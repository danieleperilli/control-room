import type { ISerializedTask, TaskState, IStore, IProjectRow, ITaskRow, ITitleUpdate } from "./control-room-types.ts";
const { currentTimestamp, validateTaskId }: import("./control-room-validation.ts").IValidationApi = require("./control-room-validation.ts");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;

const QUEUE_POSITION_DIGITS = ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
const TASK_WITH_QUEUED_POSITION_SELECT = `
    SELECT task.*,
        (SELECT json_group_array(destination.task_id) FROM tasks AS destination
            WHERE destination.handoff_sender_task_id = task.task_id AND destination.state = 'RUNNING') AS pending_handoff_task_ids,
        CASE
            WHEN (task.state = 'QUEUED' OR (task.state = 'RUNNING' AND task.handoff_sender_task_id IS NOT NULL)) AND task.queue_position IS NOT NULL THEN (
                SELECT COUNT(*)
                FROM tasks AS queued_task
                WHERE (queued_task.state = 'QUEUED' OR (queued_task.state = 'RUNNING' AND queued_task.handoff_sender_task_id IS NOT NULL))
                    AND (
                        queued_task.queue_position < task.queue_position
                        OR (
                            queued_task.queue_position = task.queue_position
                            AND queued_task.task_number <= task.task_number
                        )
                    )
            )
            ELSE NULL
        END AS queued_display_position
    FROM tasks AS task
`;
const ACTIVE_STATES: TaskState[] = ["QUEUED", "RUNNING", "REVIEW", "APPROVED", "BLOCKED"];

/**
 * Load the initialized project record.
 * @param store Open project store.
 */
function requireProject(store: IStore): IProjectRow {
    const row = store.database.prepare("SELECT * FROM projects WHERE project_key = ?").get(store.projectKey) as IProjectRow | undefined;
    assertCondition(row, "Control Room is not initialized for this project.");
    assertCondition(row.project_root === store.projectRoot, "Stored project root does not match the canonical project root.");
    return row;
}

/**
 * Load a task or fail with a stable message.
 * @param store Open project store.
 * @param taskId Task identifier to load.
 */
function requireTask(store: IStore, taskId: string): ITaskRow {
    const validTaskId = validateTaskId(taskId);
    const row = store.database.prepare(`${TASK_WITH_QUEUED_POSITION_SELECT} WHERE task.task_id = ?`).get(validTaskId) as ITaskRow | undefined;
    assertCondition(row, `Unknown task: ${validTaskId}`);
    return row;
}

/**
 * Format the visual marker for one waiting-queue position.
 * @param position One-based waiting-queue position.
 */
function queuePositionMarker(position: number | null): string {
    if (!Number.isSafeInteger(position) || Number(position) < 1) {
        return "";
    }
    return String(position).split("").map((digit) => QUEUE_POSITION_DIGITS[Number(digit)]).join("");
}

/**
 * Convert a task state into its exact user-facing title.
 * @param task Task record to title.
 */
function titleForTask(task: ITaskRow): string {
    if (task.state === "CANCELED") {
        return task.semantic_name;
    }
    let prefix = "";
    if ((task.pending_handoff_task_ids && task.pending_handoff_task_ids !== "[]") || (task.awaiting_user && task.state === "RUNNING")) {
        prefix = "🟡 ";
    } else if (task.state === "PLANNING") {
        prefix = "⚪️ ";
    } else if (task.state === "QUEUED" || (task.state === "RUNNING" && task.handoff_sender_task_id)) {
        const positionMarker = queuePositionMarker(task.queued_display_position ?? task.queue_position);
        prefix = positionMarker ? `⭕️ ${positionMarker} ` : "⭕️ ";
    } else if (task.state === "RUNNING") {
        prefix = "🔴 ";
    } else if (task.state === "REVIEW") {
        prefix = "💪 ";
    } else if (task.state === "APPROVED") {
        prefix = "🟢 ";
    } else if (task.state === "PAUSED") {
        prefix = "⏸️ ";
    } else if (task.state === "DONE") {
        prefix = "🟢 ";
    } else if (task.state === "BLOCKED") {
        prefix = "❌ ";
    }
    return `${prefix}${task.task_id} - ${task.semantic_name}`;
}

/**
 * Return the fixed Control Room console title.
 */
function titleForControlRoom(): string {
    return "⚫️ Control Room";
}

/**
 * Convert a database task row into stable public JSON.
 * @param task Task database row.
 */
function serializeTask(task: ITaskRow): ISerializedTask {
    return {
        taskId: task.task_id,
        number: task.task_number,
        semanticName: task.semantic_name,
        threadId: task.thread_id,
        state: task.state,
        blockedFromState: task.blocked_from_state,
        awaitingUser: Boolean(task.awaiting_user),
        handoffSenderTaskId: task.handoff_sender_task_id || null,
        pendingHandoffTaskIds: JSON.parse(task.pending_handoff_task_ids || "[]"),
        title: titleForTask(task),
        queuePosition: task.queue_position,
        queuedPosition: task.queued_display_position ?? null,
        baseCommit: task.base_commit,
        branchName: task.branch_name,
        workspaceMode: task.workspace_mode,
        worktreePath: task.worktree_path,
        approvedCommit: task.approved_commit,
        approvalTarget: task.approval_target,
        committedCommit: task.integrated_commit
    };
}

/**
 * Normalize active queue positions and return changed queued title projections.
 * @param store Open project store.
 * @param orderedTaskIds Active task IDs in desired order.
 */
function writeQueueOrder(store: IStore, orderedTaskIds: string[]): ITitleUpdate[] {
    const readCurrentPosition = store.database.prepare("SELECT state, queue_position, handoff_sender_task_id FROM tasks WHERE task_id = ?");
    const updatePosition = store.database.prepare("UPDATE tasks SET queue_position = ?, updated_at = ? WHERE task_id = ?");
    const timestamp = currentTimestamp();
    const changedQueuedTaskIds: string[] = [];
    for (let index = 0; index < orderedTaskIds.length; index += 1) {
        const taskId = orderedTaskIds[index];
        const nextPosition = index + 1;
        const current = readCurrentPosition.get(taskId) as { queue_position: number | null; state: TaskState; handoff_sender_task_id: string | null } | undefined;
        assertCondition(current, `Cannot order unknown task: ${taskId}`);
        if (current.queue_position !== nextPosition) {
            updatePosition.run(nextPosition, timestamp, taskId);
            if (current.state === "QUEUED" || (current.state === "RUNNING" && current.handoff_sender_task_id)) {
                changedQueuedTaskIds.push(taskId);
            }
        }
    }
    const titleUpdates: ITitleUpdate[] = [];
    for (const taskId of changedQueuedTaskIds) {
        const queuedTask = requireTask(store, taskId);
        titleUpdates.push({
            taskId: queuedTask.task_id,
            threadId: queuedTask.thread_id,
            title: titleForTask(queuedTask)
        });
    }
    return titleUpdates;
}

/**
 * Project title updates for queued tasks at or after an active queue position.
 * @param store Open project store.
 * @param minimumQueuePosition First active queue position whose queued titles may have changed.
 */
function readQueuedTitleUpdates(store: IStore, minimumQueuePosition: number): ITitleUpdate[] {
    const queuedTasks = store.database.prepare(`
        ${TASK_WITH_QUEUED_POSITION_SELECT}
        WHERE (task.state = 'QUEUED' OR (task.state = 'RUNNING' AND task.handoff_sender_task_id IS NOT NULL)) AND task.queue_position >= ?
        ORDER BY task.queue_position, task.task_number
    `).all(minimumQueuePosition) as unknown as ITaskRow[];
    const titleUpdates: ITitleUpdate[] = [];
    for (const queuedTask of queuedTasks) {
        titleUpdates.push({
            taskId: queuedTask.task_id,
            threadId: queuedTask.thread_id,
            title: titleForTask(queuedTask)
        });
    }
    return titleUpdates;
}

/**
 * Read explicit blocking dependencies for one task.
 * @param store Open project store.
 * @param taskId Task whose dependencies should be read.
 */
function readTaskDependencies(store: IStore, taskId: string): string[] {
    const dependencyRows = store.database.prepare("SELECT depends_on_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_id").all(taskId) as Array<{ depends_on_id: string }>;
    const dependencies: string[] = [];
    for (const dependencyRow of dependencyRows) {
        dependencies.push(dependencyRow.depends_on_id);
    }
    return dependencies;
}

/**
 * Compact active queue positions after a task leaves the active queue.
 * @param store Open project store.
 */
function compactActiveQueue(store: IStore): ITitleUpdate[] {
    const rows = store.database.prepare(`
        SELECT task_id FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all() as Array<{ task_id: string }>;
    const taskIds: string[] = [];
    for (const row of rows) {
        taskIds.push(row.task_id);
    }
    return writeQueueOrder(store, taskIds);
}

const api = { requireProject, requireTask, queuePositionMarker, titleForTask, titleForControlRoom, serializeTask, writeQueueOrder, readQueuedTitleUpdates, readTaskDependencies, compactActiveQueue, TASK_WITH_QUEUED_POSITION_SELECT, ACTIVE_STATES };
module.exports = api;
export interface IStateApi extends Readonly<typeof api> {}
