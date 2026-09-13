const { isolatedWorktreePathForTask }: import("./control-room-git.ts").IGitApi = require("./control-room-git.ts");
const { requireProject, requireTask, readAutopilotStatus, readAutopilotBlocker, assertAutopilotReviewCurrent, titleForTask, titleForControlRoom, serializeTask, writeQueueOrder, readQueuedTitleUpdates, readTaskDependencies, compactActiveQueue, TASK_WITH_QUEUED_POSITION_SELECT, ACTIVE_STATES }: import("./control-room-state.ts").IStateApi = require("./control-room-state.ts");
const { resolveTaskWorkspace, cleanupCanceledIsolatedTasks, commitApprovedTask, recoverCommit }: import("./control-room-integration.ts").IIntegrationApi = require("./control-room-integration.ts");
import type { IApprovalResult, IEventPayloadByKind, IActivationRequest, IActivationDelivery, IDeliveryRow, IExecutionBrief, IActivationResult, TaskState, EventKind, DecisionConfidence, DecisionImpact, DecisionInputStatus, IControlRoomOptions, IEventPayload, IDecision, IReviewPacket, IStore, IProjectRow, ITaskRow, ITaskExclusionRow, IEventRow, ITitleUpdate } from "./control-room-types.ts";
const { currentTimestamp, validateThreadId, validateSemanticName, validateTaskId, validateBranchName, workerBranchForTask, validateEventKey, validateCompactText, validateDecisionId, validateDecisionPayload, validateApprovalCommitMessage, validateQueuePosition, validateEventPayload }: import("./control-room-validation.ts").IValidationApi = require("./control-room-validation.ts");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;
const { canonicalizeProjectRoot, runGit, requireGit, requireBranchCheckout, requireBaseCheckout, readWorkingTreeStatus, resolveCurrentHeadIfExists, resolveLocalBranchHeadIfExists }: import("./control-room-git.ts").IGitApi = require("./control-room-git.ts");
const { openReadStore, pathIsSymbolicLink, openStore, beginTransaction, commitTransaction, rollbackTransaction }: import("./control-room-storage.ts").IStorageApi = require("./control-room-storage.ts");
const nodeCrypto: typeof import("node:crypto") = require("node:crypto");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

const TITLE_CHANGING_EVENT_ACTIONS = new Set(["RETURNED_TO_PLANNING", "ENQUEUED", "REENQUEUED", "USER_INPUT_REQUESTED", "USER_INPUT_RECEIVED", "REVIEW_READY", "REVIEW_ALREADY_RECORDED", "REWORK_STARTED", "APPROVED", "CANCELED", "BLOCKED"]);
const GIT_MODE = "local-approval-commit";
const ROUTING_FILE_LIMIT_BYTES = 1024 * 1024;
const WORKTREE_IGNORE_PATTERN = ".control-room/";

/**
 * Validate one existing instruction file before reading or replacing it.
 * @param agentsPath Absolute instruction file path.
 */
function validateAgentsFile(agentsPath: string): void {
    const fileStatus = fs.lstatSync(agentsPath);
    assertCondition(!fileStatus.isSymbolicLink(), `Codex instruction file cannot be a symbolic link: ${agentsPath}`);
    assertCondition(fileStatus.isFile(), `Codex instruction path is not a file: ${agentsPath}`);
    assertCondition(fileStatus.size <= ROUTING_FILE_LIMIT_BYTES, `Codex instruction file exceeds ${ROUTING_FILE_LIMIT_BYTES} bytes: ${agentsPath}`);
}

/**
 * Resolve the active instruction file in the project Git root.
 * @param projectRoot Canonical project Git root.
 */
function resolveProjectAgentsPath(projectRoot: string): string {
    const overridePath = path.join(projectRoot, "AGENTS.override.md");
    if (fs.existsSync(overridePath)) {
        validateAgentsFile(overridePath);
        if (fs.readFileSync(overridePath, "utf8").trim().length > 0) {
            return overridePath;
        }
    }
    const agentsPath = path.join(projectRoot, "AGENTS.md");
    if (fs.existsSync(agentsPath)) {
        validateAgentsFile(agentsPath);
    }
    return agentsPath;
}

/**
 * Atomically replace one validated project file.
 * @param targetPath Absolute file path.
 * @param content Complete replacement content.
 */
function writeProjectFileAtomically(targetPath: string, content: string): void {
    const existingMode = fs.existsSync(targetPath) ? fs.lstatSync(targetPath).mode & 0o777 : 0o644;
    const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.control-room-${process.pid}-${nodeCrypto.randomBytes(6).toString("hex")}.tmp`);
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(temporaryPath, "wx", existingMode);
        fs.writeFileSync(descriptor, content, "utf8");
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = null;
        fs.renameSync(temporaryPath, targetPath);
    } catch (error) {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
        if (fs.existsSync(temporaryPath)) {
            fs.unlinkSync(temporaryPath);
        }
        throw error;
    }
}

/**
 * Initialize project coordination idempotently.
 * @param options Project and optional state-root settings.
 * @param controlRoomThreadId Control Room console thread identifier.
 * @param baseBranch Local Git base branch.
 */
function initializeProject(options: IControlRoomOptions, controlRoomThreadId: string, baseBranch: string): Record<string, unknown> {
    const validControlRoomThreadId = validateThreadId(controlRoomThreadId);
    const validBaseBranch = validateBranchName(baseBranch);
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const existingProject = store.database.prepare("SELECT * FROM projects WHERE project_key = ?").get(store.projectKey) as IProjectRow | undefined;
        if (existingProject) {
            assertCondition(existingProject.project_root === store.projectRoot, "Project hash collision detected.");
            assertCondition(existingProject.coordinator_thread_id === validControlRoomThreadId, "A different Control Room task is already registered for this project.");
            assertCondition(existingProject.base_branch === validBaseBranch, "The configured base branch does not match.");
            const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, existingProject.base_branch);
            const controlRoomTitle = titleForControlRoom();
            commitTransaction(store.database);
            return {
                created: false,
                title: controlRoomTitle,
                controlRoomTitle,
                projectRoot: store.projectRoot,
                controlRoomThreadId: existingProject.coordinator_thread_id,
                baseBranch: existingProject.base_branch,
                baseCommit,
                gitMode: existingProject.git_mode,
                databasePath: store.databasePath
            };
        }
        const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, validBaseBranch);
        if (!baseCommit) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            assertCondition(currentBranch === validBaseBranch, `Unborn base branch ${validBaseBranch} must be the current branch.`);
            assertCondition(resolveCurrentHeadIfExists(store.projectRoot) === null, `Base branch ${validBaseBranch} does not exist, but the current branch already has commits.`);
        }
        const timestamp = currentTimestamp();
        store.database.prepare(`
            INSERT INTO projects (project_key, project_root, coordinator_thread_id, base_branch, git_mode, next_task_number, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'local-approval-commit', 1, ?, ?)
        `).run(store.projectKey, store.projectRoot, validControlRoomThreadId, validBaseBranch, timestamp, timestamp);
        const controlRoomTitle = titleForControlRoom();
        commitTransaction(store.database);
        return {
            created: true,
            title: controlRoomTitle,
            controlRoomTitle,
            projectRoot: store.projectRoot,
            controlRoomThreadId: validControlRoomThreadId,
            baseBranch: validBaseBranch,
            baseCommit,
            gitMode: GIT_MODE,
            databasePath: store.databasePath
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Install one idempotent ControlRoom rule in the project instruction file.
 * @param options Project and optional state-root settings.
 */
function installProjectRouting(options: IControlRoomOptions): Record<string, unknown> {
    const store = openStore(options);
    let projectRoot: string;
    try {
        requireProject(store);
        projectRoot = store.projectRoot;
    } finally {
        store.database.close();
    }
    const agentsPath = resolveProjectAgentsPath(projectRoot);
    const existingContent = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
    const startMarker = "<!-- control-room:start -->";
    const endMarker = "<!-- control-room:end -->";
    const routingBlock = [
        startMarker,
        "# ControlRoom project routing",
        "",
        "- In every top-level task for this project, load and follow `$control-room` before handling each user message.",
        "- Persistently exclude an unregistered task before automatic registration when it invokes or triggers `$brand-forge`, or when its message contains the exact standalone `$control-room exclude` directive.",
        "- For a registered PLANNING or QUEUED task, route `$control-room exclude` through cancellation and settlement so it leaves the queue and regains its undecorated semantic title.",
        "- Keep excluded tasks unregistered on later turns; only an explicit `$control-room join` adopts one.",
        "- Route a direct `autopilot`, `autopilot on`, `autopilot off`, or `autopilot status` command to the project before worker registration or exclusion handling, including from side chats. Autopilot authorizes automatic completion of explicitly started or queued work until disabled; it does not enqueue planning tasks. Follow the skill's autopilot reference for approval and progress.",
        "- Do not automatically register a purely read-only request; register change work and concrete plans intended for later implementation.",
        "- Treat a direct user `Enqueue` command as advance authorization for that exact registered task to start automatically when it becomes the first dependency-eligible queued worker. After settlement activates it, send one activation brief to its recorded thread without asking for another confirmation merely because a different task's approval freed the queue. This authorization never covers another task, thread, project, or implementation scope.",
        "- Apply every ControlRoom task title update before replying.",
        "- Never register subagents or side chats as ControlRoom workers, allocate task IDs for them, or let them submit queue or lifecycle mutations on their own behalf.",
        "- A side chat may create a new top-level task in this saved project with the Local environment only when the user explicitly requests it; remove only the task-creation wrapper, preserve the delegated prompt and lifecycle intent, and let the created task register and mutate its own state.",
        endMarker
    ].join("\n");
    const startIndex = existingContent.indexOf(startMarker);
    const endIndex = existingContent.indexOf(endMarker);
    assertCondition((startIndex < 0) === (endIndex < 0), `ControlRoom routing block is malformed in ${agentsPath}.`);
    assertCondition(startIndex < 0 || existingContent.indexOf(startMarker, startIndex + startMarker.length) < 0, `ControlRoom routing block is duplicated in ${agentsPath}.`);
    assertCondition(endIndex < 0 || existingContent.indexOf(endMarker, endIndex + endMarker.length) < 0, `ControlRoom routing block is duplicated in ${agentsPath}.`);
    let updatedContent: string;
    if (startIndex < 0) {
        updatedContent = existingContent.length > 0 ? `${routingBlock}\n\n${existingContent}` : `${routingBlock}\n`;
    } else {
        assertCondition(startIndex < endIndex, `ControlRoom routing block is malformed in ${agentsPath}.`);
        const blockEnd = endIndex + endMarker.length;
        updatedContent = `${existingContent.slice(0, startIndex)}${routingBlock}${existingContent.slice(blockEnd)}`;
        if (!updatedContent.endsWith("\n")) {
            updatedContent += "\n";
        }
    }
    assertCondition(Buffer.byteLength(updatedContent, "utf8") <= ROUTING_FILE_LIMIT_BYTES, `Codex instruction file exceeds ${ROUTING_FILE_LIMIT_BYTES} bytes after routing installation: ${agentsPath}`);
    const updated = updatedContent !== existingContent;
    if (updated) {
        writeProjectFileAtomically(agentsPath, updatedContent);
    }
    return {
        installed: true,
        updated,
        projectRoot,
        agentsPath
    };
}

/**
 * Install the repository-wide ControlRoom worktree ignore pattern idempotently.
 * @param options Project and optional state-root settings.
 */
function installWorktreeIgnore(options: IControlRoomOptions): Record<string, unknown> {
    const store = openStore(options);
    let projectRoot: string;
    try {
        requireProject(store);
        projectRoot = store.projectRoot;
    } finally {
        store.database.close();
    }
    const ignorePath = path.join(projectRoot, ".gitignore");
    if (fs.existsSync(ignorePath)) {
        const ignoreStatus = fs.lstatSync(ignorePath);
        assertCondition(!ignoreStatus.isSymbolicLink(), `Git ignore file cannot be a symbolic link: ${ignorePath}`);
        assertCondition(ignoreStatus.isFile(), `Git ignore path is not a file: ${ignorePath}`);
        assertCondition(ignoreStatus.size <= ROUTING_FILE_LIMIT_BYTES, `Git ignore file exceeds ${ROUTING_FILE_LIMIT_BYTES} bytes: ${ignorePath}`);
    }
    const existingContent = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
    const alreadyInstalled = existingContent.split(/\r?\n/u).some((line) => line === WORKTREE_IGNORE_PATTERN);
    if (alreadyInstalled) {
        return { installed: true, updated: false, projectRoot, ignorePath, pattern: WORKTREE_IGNORE_PATTERN };
    }
    const separator = existingContent.length === 0 || existingContent.endsWith("\n") ? "" : "\n";
    const updatedContent = `${existingContent}${separator}${WORKTREE_IGNORE_PATTERN}\n`;
    assertCondition(Buffer.byteLength(updatedContent, "utf8") <= ROUTING_FILE_LIMIT_BYTES, `Git ignore file exceeds ${ROUTING_FILE_LIMIT_BYTES} bytes after ControlRoom installation: ${ignorePath}`);
    writeProjectFileAtomically(ignorePath, updatedContent);
    return { installed: true, updated: true, projectRoot, ignorePath, pattern: WORKTREE_IGNORE_PATTERN };
}

/**
 * Persistently exclude one unregistered top-level task from Control Room.
 * @param options Project and optional state-root settings.
 * @param threadId Codex thread identifier to exclude.
 * @param reason Compact reason for the exclusion.
 */
function excludeTask(options: IControlRoomOptions, threadId: string, reason: string): Record<string, unknown> {
    const validThreadId = validateThreadId(threadId);
    const validReason = String(validateCompactText(reason, "Exclusion reason", 200, true));
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        assertCondition(project.coordinator_thread_id !== validThreadId, "The Control Room task cannot be excluded.");
        const existingTask = store.database.prepare("SELECT task_id FROM tasks WHERE thread_id = ?").get(validThreadId) as { task_id: string } | undefined;
        assertCondition(!existingTask, `Registered worker ${existingTask?.task_id || ""} must use request-exclude from PLANNING or QUEUED.`);
        const existingExclusion = store.database.prepare("SELECT * FROM task_exclusions WHERE thread_id = ?").get(validThreadId) as ITaskExclusionRow | undefined;
        if (existingExclusion) {
            commitTransaction(store.database);
            return {
                created: false,
                projectRoot: store.projectRoot,
                controlRoomThreadId: project.coordinator_thread_id,
                role: "EXCLUDED",
                task: null,
                exclusion: { reason: existingExclusion.reason, createdAt: existingExclusion.created_at }
            };
        }
        const timestamp = currentTimestamp();
        store.database.prepare("INSERT INTO task_exclusions (thread_id, reason, created_at) VALUES (?, ?, ?)").run(validThreadId, validReason, timestamp);
        commitTransaction(store.database);
        return {
            created: true,
            projectRoot: store.projectRoot,
            controlRoomThreadId: project.coordinator_thread_id,
            role: "EXCLUDED",
            task: null,
            exclusion: { reason: validReason, createdAt: timestamp }
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Allocate or retrieve a stable top-level task ID.
 * @param options Project and optional state-root settings.
 * @param threadId Worker Codex thread identifier.
 * @param semanticName Short user-facing task name.
 * @param adoptExcluded Whether an explicit join may remove a prior exclusion.
 */
function registerTask(options: IControlRoomOptions, threadId: string, semanticName: string, adoptExcluded = false): Record<string, unknown> {
    const validThreadId = validateThreadId(threadId);
    const validSemanticName = validateSemanticName(semanticName);
    assertCondition(typeof adoptExcluded === "boolean", "Excluded-task adoption must be a boolean.");
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        assertCondition(project.coordinator_thread_id !== validThreadId, "The Control Room task cannot be registered as a worker task.");
        const exclusion = store.database.prepare("SELECT * FROM task_exclusions WHERE thread_id = ?").get(validThreadId) as ITaskExclusionRow | undefined;
        const existingTask = store.database.prepare("SELECT * FROM tasks WHERE thread_id = ?").get(validThreadId) as ITaskRow | undefined;
        assertCondition(!exclusion || adoptExcluded, "This task is excluded from Control Room; use $control-room join to adopt it explicitly.");
        if (exclusion && existingTask) {
            assertCondition(existingTask.state === "CANCELED" && !existingTask.branch_name, `Excluded worker ${existingTask.task_id} cannot be safely restored from ${existingTask.state}.`);
            const timestamp = currentTimestamp();
            store.database.prepare(`
                UPDATE tasks
                SET semantic_name = ?, state = 'PLANNING', blocked_from_state = NULL, awaiting_user = 0,
                    queue_position = NULL, base_commit = NULL, branch_name = NULL, workspace_mode = 'shared',
                    worktree_path = NULL, reviewed_commit = NULL, approved_commit = NULL,
                    approval_event_key = NULL, approval_target = 'DONE', integrated_commit = NULL, updated_at = ?
                WHERE task_id = ?
            `).run(validSemanticName, timestamp, existingTask.task_id);
            store.database.prepare("DELETE FROM task_exclusions WHERE thread_id = ?").run(validThreadId);
            const restoredTask = requireTask(store, existingTask.task_id);
            commitTransaction(store.database);
            return { created: false, adoptedExclusion: true, controlRoomThreadId: project.coordinator_thread_id, ...serializeTask(restoredTask) };
        }
        if (exclusion) {
            store.database.prepare("DELETE FROM task_exclusions WHERE thread_id = ?").run(validThreadId);
        }
        if (existingTask) {
            if (existingTask.semantic_name !== validSemanticName) {
                assertCondition(existingTask.state === "PLANNING", "A semantic task name can change only during PLANNING.");
                store.database.prepare("UPDATE tasks SET semantic_name = ?, updated_at = ? WHERE task_id = ?").run(validSemanticName, currentTimestamp(), existingTask.task_id);
            }
            const refreshedTask = requireTask(store, existingTask.task_id);
            commitTransaction(store.database);
            return { created: false, controlRoomThreadId: project.coordinator_thread_id, ...serializeTask(refreshedTask) };
        }
        assertCondition(project.next_task_number <= 9999, "The project task ID space T0001-T9999 is exhausted.");
        const taskNumber = project.next_task_number;
        const taskId = `T${String(taskNumber).padStart(4, "0")}`;
        const timestamp = currentTimestamp();
        store.database.prepare(`
            INSERT INTO tasks (task_id, task_number, semantic_name, thread_id, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'PLANNING', ?, ?)
        `).run(taskId, taskNumber, validSemanticName, validThreadId, timestamp, timestamp);
        store.database.prepare("UPDATE projects SET next_task_number = ?, updated_at = ? WHERE project_key = ?").run(taskNumber + 1, timestamp, store.projectKey);
        const createdTask = requireTask(store, taskId);
        commitTransaction(store.database);
        return { created: true, controlRoomThreadId: project.coordinator_thread_id, ...serializeTask(createdTask) };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Submit an idempotent worker event without mutating queue or task state.
 * @param options Project and optional state-root settings.
 * @param eventKey Caller-stable event key.
 * @param taskId Target Control Room task.
 * @param kind Event kind requested by the worker.
 * @param payload Compact event payload.
 */
function submitEvent<Kind extends EventKind>(options: IControlRoomOptions, eventKey: string, taskId: string, kind: Kind, payload: IEventPayloadByKind[Kind]): Record<string, unknown> {
    const validEventKey = validateEventKey(eventKey);
    const validTaskId = validateTaskId(taskId);
    const validPayload = validateEventPayload(kind, payload);
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        requireProject(store);
        let task = requireTask(store, validTaskId);
        if (kind === "APPROVAL_REQUESTED" && validPayload.autopilotEventKey) {
            const authorization = store.database.prepare("SELECT user_request_id FROM autopilot_requests WHERE event_key = ? AND enabled = 1").get(validPayload.autopilotEventKey) as { user_request_id: string } | undefined;
            assertCondition(authorization, "Unknown autopilot authorization.");
            validPayload.userRequestId = authorization.user_request_id;
        }
        const payloadJson = JSON.stringify(validPayload);
        const existingEvent = store.database.prepare("SELECT event_key, task_id, kind, payload_json, processed_at FROM events WHERE event_key = ?").get(validEventKey) as Record<string, unknown> | undefined;
        if (existingEvent) {
            assertCondition(existingEvent.task_id === validTaskId && existingEvent.kind === kind && existingEvent.payload_json === payloadJson, "Event key already exists with different content.");
            commitTransaction(store.database);
            return {
                created: false,
                processed: Boolean(existingEvent.processed_at),
                eventKey: validEventKey
            };
        }
        const replacesAutomaticApproval = ["REWORK_REQUESTED", "REVIEW_REQUESTED", "BLOCKED_REPORTED", "CANCEL_REQUESTED"].includes(kind) || (kind === "APPROVAL_REQUESTED" && !validPayload.autopilotEventKey);
        if (task.state === "APPROVED" && replacesAutomaticApproval && requireProject(store).integration_task_id !== task.task_id) {
            const automatic = store.database.prepare("SELECT 1 FROM events WHERE event_key = ? AND json_extract(payload_json, '$.autopilotEventKey') IS NOT NULL").get(task.approval_event_key);
            if (automatic) {
                store.database.prepare("UPDATE tasks SET state = 'REVIEW', approval_event_key = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
                task = requireTask(store, validTaskId);
            }
        }
        if (kind === "PLANNING_REQUESTED") {
            assertCondition(task.state === "QUEUED" || task.state === "BLOCKED", `Cannot return ${task.task_id} to PLANNING from ${task.state}.`);
            if (task.state === "BLOCKED") {
                assertCondition(task.blocked_from_state === "QUEUED", `Cannot return ${task.task_id} to PLANNING after ${String(task.blocked_from_state)}; resume it to its prior state to preserve its worker branch and changes.`);
            }
        } else if (kind === "ENQUEUE_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED" || task.state === "BLOCKED", `Cannot request enqueue for ${task.task_id} from ${task.state}.`);
            if (task.state === "BLOCKED") {
                assertCondition(task.blocked_from_state === "QUEUED", `Cannot enqueue ${task.task_id} after ${String(task.blocked_from_state)}; resume it to its prior state to preserve its worker branch and changes.`);
            }
            if (validPayload.afterTaskId) {
                assertCondition(validPayload.afterTaskId !== task.task_id, "A task cannot be queued after itself.");
                requireTask(store, validPayload.afterTaskId);
            }
        } else if (kind === "RUN_NOW_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED" || task.state === "RUNNING", `Cannot run ${task.task_id} now from ${task.state}.`);
        } else if (kind === "RUN_ISOLATED_NOW_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED" || (task.state === "RUNNING" && task.workspace_mode === "isolated"), `Cannot run ${task.task_id} isolated now from ${task.state}.`);
        } else if (kind === "MOVE_REQUESTED") {
            assertCondition(task.state === "QUEUED", `Cannot move ${task.task_id} from ${task.state}.`);
            const referenceTaskId = validPayload.beforeTaskId || validPayload.afterTaskId;
            if (referenceTaskId) {
                assertCondition(referenceTaskId !== task.task_id, "A task cannot be moved relative to itself.");
                const referenceTask = requireTask(store, referenceTaskId);
                assertCondition(referenceTask.state === "QUEUED", `${referenceTask.task_id} is not waiting in the queue.`);
            }
        } else if (kind === "DEPENDENCY_ADD_REQUESTED" || kind === "DEPENDENCY_REMOVE_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot change dependencies for ${task.task_id} from ${task.state}.`);
            assertCondition(validPayload.dependencyTaskId !== task.task_id, "A task cannot depend on itself.");
            requireTask(store, String(validPayload.dependencyTaskId));
        } else if (kind === "USER_INPUT_REQUESTED") {
            if (validPayload.handoffTaskId) {
                assertCondition(task.state === "DONE" || task.state === "PAUSED", `Cannot report an approval handoff for ${task.task_id} from ${task.state}.`);
                const destination = requireTask(store, validPayload.handoffTaskId);
                assertCondition(destination.task_id !== task.task_id && destination.state === "RUNNING", "Handoff destination must be a different RUNNING task.");
                assertCondition(!destination.handoff_sender_task_id || destination.handoff_sender_task_id === task.task_id, "Handoff destination already belongs to a different sender.");
            } else {
                assertCondition(task.state === "RUNNING", `Cannot request user input for ${task.task_id} from ${task.state}.`);
            }
        } else if (kind === "USER_INPUT_RECEIVED") {
            if (validPayload.handoffTaskId) {
                const destination = requireTask(store, validPayload.handoffTaskId);
                assertCondition(destination.task_id !== task.task_id && (!destination.handoff_sender_task_id || destination.handoff_sender_task_id === task.task_id), "Handoff destination does not belong to this sender.");
            } else {
                assertCondition(task.state === "PLANNING" || task.state === "RUNNING" || task.state === "REVIEW", `Cannot update user-input attention for ${task.task_id} from ${task.state}.`);
            }
        } else if (kind === "DECISION_RECORDED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED" || task.state === "RUNNING", `Cannot record review context for ${task.task_id} from ${task.state}.`);
        } else if (kind === "REVIEW_REQUESTED") {
            assertCondition(task.state === "RUNNING" || task.state === "REVIEW", `Cannot request review for ${task.task_id} from ${task.state}.`);
            assertCondition(!task.awaiting_user || !readAutopilotStatus(store).enabled, "Resolve awaited user input before autopilot review.");
        } else if (kind === "REWORK_REQUESTED") {
            assertCondition(task.state === "REVIEW", `Cannot request rework for ${task.task_id} from ${task.state}.`);
        } else if (kind === "APPROVAL_REQUESTED") {
            if (validPayload.autopilotEventKey) {
                validateAutopilotApproval(store, task, validPayload);
            }
            assertCondition(task.state === "RUNNING" || task.state === "REVIEW" || task.state === "APPROVED" || task.state === "PAUSED" || task.state === "DONE", `Cannot request approval for ${task.task_id} from ${task.state}.`);
            validateApprovalCommitMessage(task, validPayload.commitMessage);
        } else if (kind === "CANCEL_REQUESTED") {
            if (validPayload.cancelSource === "exclude") {
                assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot request exclusion for ${task.task_id} from ${task.state}.`);
            } else {
                assertCondition(["PLANNING", "QUEUED", "RUNNING", "REVIEW", "PAUSED", "BLOCKED", "CANCELED"].includes(task.state), `Cannot request cancellation for ${task.task_id} from ${task.state}.`);
            }
        } else {
            assertCondition(["QUEUED", "RUNNING", "REVIEW", "BLOCKED"].includes(task.state), `Cannot report ${task.task_id} blocked from ${task.state}.`);
        }
        store.database.prepare(`
            INSERT INTO events (event_key, task_id, kind, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(validEventKey, validTaskId, kind, payloadJson, currentTimestamp());
        commitTransaction(store.database);
        return {
            created: true,
            processed: false,
            eventKey: validEventKey
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Record a project-wide mode change without registering or interrupting the caller.
 * @param options Project and optional state-root settings.
 * @param enabled Whether automatic approval is authorized.
 * @param eventKey Stable retry key for this command.
 * @param userRequestId Actual direct-user message authorizing the mode change.
 * @param threadId Task or side chat containing that user message.
 */
function setAutopilot(options: IControlRoomOptions, enabled: boolean, eventKey: string, userRequestId: string, threadId: string): Record<string, unknown> {
    assertCondition(typeof enabled === "boolean", "Autopilot mode must be a boolean.");
    const validEventKey = validateEventKey(eventKey);
    const validRequestId = validateCompactText(userRequestId, "Direct user request ID", 200, true)!;
    const validThreadId = validateThreadId(threadId);
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const existing = store.database.prepare("SELECT * FROM autopilot_requests WHERE event_key = ?").get(validEventKey) as { enabled: number; user_request_id: string; thread_id: string } | undefined;
        const titleUpdates: ITitleUpdate[] = [];
        if (existing) {
            assertCondition(Boolean(existing.enabled) === enabled && existing.user_request_id === validRequestId && existing.thread_id === validThreadId, "Autopilot event key already exists with different content.");
        } else {
            const timestamp = currentTimestamp();
            store.database.prepare("INSERT INTO autopilot_requests (event_key, enabled, user_request_id, thread_id, created_at) VALUES (?, ?, ?, ?, ?)").run(validEventKey, Number(enabled), validRequestId, validThreadId, timestamp);
            // An integration that already holds its lease must finish or recover normally.
            const revoked = store.database.prepare(`
                SELECT task.task_id FROM tasks AS task JOIN events ON events.event_key = task.approval_event_key
                WHERE task.state = 'APPROVED' AND task.task_id <> COALESCE(?, '')
                    AND json_extract(events.payload_json, '$.autopilotEventKey') IS NOT NULL
            `).all(project.integration_task_id) as Array<{ task_id: string }>;
            for (const task of revoked) {
                store.database.prepare("UPDATE tasks SET state = 'REVIEW', approval_event_key = NULL, approval_target = 'DONE', updated_at = ? WHERE task_id = ?").run(timestamp, task.task_id);
                const refreshed = requireTask(store, task.task_id);
                titleUpdates.push({ taskId: refreshed.task_id, threadId: refreshed.thread_id, title: titleForTask(refreshed) });
            }
        }
        const autopilot = readAutopilotStatus(store);
        commitTransaction(store.database);
        return { changed: !existing, autopilot, controlRoomThreadId: project.coordinator_thread_id, integrationTaskId: project.integration_task_id, titleUpdates };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Bind an automatic approval to the current authorization and successful review.
 * @param store Open project store inside the event transaction.
 * @param task Task proposed for automatic completion.
 * @param payload Validated automatic approval and verification evidence.
 */
function validateAutopilotApproval(store: IStore, task: ITaskRow, payload: IEventPayload): void {
    const autopilot = readAutopilotStatus(store);
    assertCondition(autopilot.enabled && autopilot.eventKey === payload.autopilotEventKey && autopilot.userRequestId === payload.userRequestId, "Autopilot authorization is disabled or superseded.");
    assertCondition(task.state === "REVIEW", `Autopilot requires ${task.task_id} to be in REVIEW.`);
    assertCondition(!requireProject(store).integration_task_id, "Finish the pending integration before automatic approval.");
    const blocker = readAutopilotBlocker(store);
    assertCondition(!blocker, `Autopilot is waiting for user attention or recovery on ${blocker}.`);
    assertAutopilotReviewCurrent(store, task.task_id, payload.reviewEventKey);
    const reviewPacket = readReviewPacketFromStore(store, task.task_id);
    assertCondition(!reviewPacket.decisions.some((decision) => decision.status !== "superseded" && (decision.status === "unresolved" || decision.confidence === "low")), "Resolve pending or low-confidence decisions before automatic approval.");
}

/**
 * Reconstruct the task review packet from successfully processed append-only events.
 * @param store Open project store.
 * @param taskId Task whose review packet should be reconstructed.
 */
function readReviewPacketFromStore(store: IStore, taskId: string): IReviewPacket {
    const validTaskId = validateTaskId(taskId);
    const rows = store.database.prepare(`
        SELECT kind, payload_json, result_json
        FROM events
        WHERE task_id = ?
            AND processed_at IS NOT NULL
            AND kind = 'DECISION_RECORDED'
        ORDER BY sequence
    `).all(validTaskId) as Array<{ kind: EventKind; payload_json: string; result_json: string | null }>;
    const decisions: IDecision[] = [];
    const decisionsById = new Map<string, IDecision>();
    for (const row of rows) {
        const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {};
        const payload = JSON.parse(row.payload_json) as IEventPayload;
        if (row.kind !== "DECISION_RECORDED" || result.action !== "DECISION_RECORDED") {
            continue;
        }
        const decisionId = validateDecisionId(String(result.decisionId || ""));
        const validPayload = validateDecisionPayload(payload);
        if (validPayload.supersedesDecisionId) {
            const supersededDecision = decisionsById.get(validPayload.supersedesDecisionId);
            assertCondition(supersededDecision && supersededDecision.status !== "superseded", `${validPayload.supersedesDecisionId} is not a current decision for ${validTaskId}.`);
            supersededDecision.status = "superseded";
            supersededDecision.supersededByDecisionId = decisionId;
        }
        const decision: IDecision = {
            decisionId,
            decision: String(validPayload.decision),
            rationale: String(validPayload.rationale),
            confidence: validPayload.confidence as DecisionConfidence,
            impact: validPayload.impact as DecisionImpact,
            evidence: String(validPayload.evidence),
            alternatives: validPayload.alternatives || null,
            uncertainty: validPayload.uncertainty || null,
            supersedesDecisionId: validPayload.supersedesDecisionId || null,
            supersededByDecisionId: null,
            status: validPayload.status as DecisionInputStatus
        };
        decisions.push(decision);
        decisionsById.set(decisionId, decision);
    }
    const confidenceOrder: Record<DecisionConfidence, number> = { low: 0, medium: 1, high: 2 };
    const impactOrder: Record<DecisionImpact, number> = { high: 0, medium: 1, low: 2 };
    decisions.sort((left, right) => {
        const leftSuperseded = left.status === "superseded" ? 1 : 0;
        const rightSuperseded = right.status === "superseded" ? 1 : 0;
        return leftSuperseded - rightSuperseded || confidenceOrder[left.confidence] - confidenceOrder[right.confidence] || impactOrder[left.impact] - impactOrder[right.impact] || left.decisionId.localeCompare(right.decisionId, "en-US");
    });
    const latestReview = store.database.prepare("SELECT event_key FROM events WHERE task_id = ? AND kind = 'REVIEW_REQUESTED' AND processed_at IS NOT NULL AND json_extract(result_json, '$.action') IN ('REVIEW_READY', 'REVIEW_ALREADY_RECORDED') ORDER BY sequence DESC LIMIT 1").get(validTaskId) as { event_key: string } | undefined;
    return {
        taskId: validTaskId,
        reviewEventKey: latestReview?.event_key || null,
        decisionCount: decisions.length,
        unresolvedDecisionIds: decisions.filter((decision) => decision.status === "unresolved").map((decision) => decision.decisionId),
        decisions
    };
}

/**
 * Require a decision supersession target to still be current.
 * @param reviewPacket Reconstructed review packet.
 * @param supersedesDecisionId Decision identifier that the new decision replaces.
 */
function requireCurrentDecision(reviewPacket: IReviewPacket, supersedesDecisionId: string): void {
    const decision = reviewPacket.decisions.find((candidate) => candidate.decisionId === supersedesDecisionId);
    assertCondition(decision, `Unknown decision for ${reviewPacket.taskId}: ${supersedesDecisionId}`);
    assertCondition(decision.status !== "superseded", `${supersedesDecisionId} is already superseded for ${reviewPacket.taskId}.`);
}

/**
 * Reject a blocking dependency that would create a cycle.
 * @param store Open project store.
 * @param taskId Task receiving the new dependency.
 * @param dependsOnId Proposed prerequisite task.
 */
function assertDependencyIsAcyclic(store: IStore, taskId: string, dependsOnId: string): void {
    const cycle = store.database.prepare(`
        WITH RECURSIVE prerequisite_chain(task_id) AS (
            SELECT ?
            UNION
            SELECT dependency.depends_on_id
            FROM dependencies AS dependency
            JOIN prerequisite_chain AS current ON dependency.task_id = current.task_id
        )
        SELECT task_id FROM prerequisite_chain WHERE task_id = ? LIMIT 1
    `).get(dependsOnId, taskId) as { task_id: string } | undefined;
    assertCondition(!cycle, `Making ${taskId} depend on ${dependsOnId} would create a dependency cycle.`);
}

/**
 * Return a queued or safely blocked waiting task to planning.
 * @param store Open project store.
 * @param task Current waiting task row.
 */
function applyPlanningEvent(store: IStore, task: ITaskRow): Record<string, unknown> {
    assertCondition(task.state === "QUEUED" || task.state === "BLOCKED", `Cannot return ${task.task_id} to PLANNING from ${task.state}.`);
    if (task.state === "BLOCKED") {
        assertCondition(task.blocked_from_state === "QUEUED", `Cannot return ${task.task_id} to PLANNING after ${String(task.blocked_from_state)}; resume it to its prior state to preserve its worker branch and changes.`);
    }
    store.database.prepare(`
        UPDATE tasks
        SET state = 'PLANNING', blocked_from_state = NULL, awaiting_user = 0, queue_position = NULL, updated_at = ?
        WHERE task_id = ?
    `).run(currentTimestamp(), task.task_id);
    const titleUpdates = compactActiveQueue(store);
    const refreshedTask = requireTask(store, task.task_id);
    return { action: "RETURNED_TO_PLANNING", task: serializeTask(refreshedTask), titleUpdates };
}

/**
 * Place a task at the requested queue location without changing dependencies.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Enqueue request payload.
 */
function applyEnqueueEvent(store: IStore, task: ITaskRow, payload: IEventPayload): Record<string, unknown> {
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED" || task.state === "BLOCKED", `Cannot enqueue ${task.task_id} from ${task.state}.`);
    const reviewPacket = readReviewPacketFromStore(store, task.task_id);
    if (task.state === "BLOCKED") {
        assertCondition(task.blocked_from_state === "QUEUED", `Cannot enqueue ${task.task_id} after ${String(task.blocked_from_state)}; resume it to its prior state to preserve its worker branch and changes.`);
    }
    const wasAlreadyQueued = task.state === "QUEUED";
    let afterTaskId: string | undefined;
    if (payload.afterTaskId) {
        afterTaskId = validateTaskId(payload.afterTaskId);
        assertCondition(afterTaskId !== task.task_id, "A task cannot be queued after itself.");
        const afterTask = requireTask(store, afterTaskId);
        assertCondition(ACTIVE_STATES.includes(afterTask.state), `${afterTask.task_id} is not in the active queue.`);
    }
    const activeRows = store.database.prepare(`
        SELECT task_id FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED') AND task_id <> ?
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all(task.task_id) as Array<{ task_id: string }>;
    const orderedTaskIds: string[] = [];
    for (const row of activeRows) {
        orderedTaskIds.push(row.task_id);
    }
    if (afterTaskId) {
        const afterIndex = orderedTaskIds.indexOf(afterTaskId);
        if (afterIndex >= 0) {
            orderedTaskIds.splice(afterIndex + 1, 0, task.task_id);
        } else {
            orderedTaskIds.push(task.task_id);
        }
    } else {
        orderedTaskIds.push(task.task_id);
    }
    store.database.prepare(`
        UPDATE tasks
        SET state = 'QUEUED', blocked_from_state = NULL, awaiting_user = 0, base_commit = NULL,
            branch_name = NULL, workspace_mode = 'shared', worktree_path = NULL,
            reviewed_commit = NULL, approved_commit = NULL, updated_at = ?
        WHERE task_id = ?
    `).run(currentTimestamp(), task.task_id);
    const titleUpdates = writeQueueOrder(store, orderedTaskIds);
    const refreshedTask = requireTask(store, task.task_id);
    return {
        action: wasAlreadyQueued ? "REENQUEUED" : "ENQUEUED",
        task: serializeTask(refreshedTask),
        afterTaskId: afterTaskId || null,
        reviewPacket,
        titleUpdates,
        executionBrief: {
            taskId: refreshedTask.task_id,
            title: titleForTask(refreshedTask),
            projectRoot: store.projectRoot,
            dependencies: readTaskDependencies(store, refreshedTask.task_id),
            instruction: "Wait for Control Room activation. Do not create a branch, modify files, stage changes, or commit."
        }
    };
}

/**
 * Reposition a waiting task without changing dependencies.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Move request payload.
 */
function applyMoveEvent(store: IStore, task: ITaskRow, payload: IEventPayload): Record<string, unknown> {
    assertCondition(task.state === "QUEUED", `Cannot move ${task.task_id} from ${task.state}.`);
    const activeRows = store.database.prepare(`
        SELECT task_id, state FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED') AND task_id <> ?
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all(task.task_id) as Array<{ task_id: string; state: TaskState }>;
    const orderedTaskIds = activeRows.map((row) => row.task_id);
    const waitingTaskIds = activeRows.filter((row) => row.state === "QUEUED").map((row) => row.task_id);
    let insertionIndex: number;
    if (payload.beforeTaskId) {
        insertionIndex = orderedTaskIds.indexOf(payload.beforeTaskId);
        assertCondition(insertionIndex >= 0 && waitingTaskIds.includes(payload.beforeTaskId), `${payload.beforeTaskId} is not waiting in the queue.`);
    } else if (payload.afterTaskId) {
        insertionIndex = orderedTaskIds.indexOf(payload.afterTaskId);
        assertCondition(insertionIndex >= 0 && waitingTaskIds.includes(payload.afterTaskId), `${payload.afterTaskId} is not waiting in the queue.`);
        insertionIndex += 1;
    } else {
        const position = validateQueuePosition(payload.position);
        assertCondition(position <= waitingTaskIds.length + 1, `Queue position ${position} exceeds the waiting queue length ${waitingTaskIds.length + 1}.`);
        if (position <= waitingTaskIds.length) {
            insertionIndex = orderedTaskIds.indexOf(waitingTaskIds[position - 1]);
        } else if (waitingTaskIds.length > 0) {
            insertionIndex = orderedTaskIds.indexOf(waitingTaskIds[waitingTaskIds.length - 1]) + 1;
        } else {
            insertionIndex = orderedTaskIds.length;
        }
    }
    orderedTaskIds.splice(insertionIndex, 0, task.task_id);
    const titleUpdates = writeQueueOrder(store, orderedTaskIds);
    const refreshedTask = requireTask(store, task.task_id);
    const refreshedWaitingRows = store.database.prepare("SELECT task_id FROM tasks WHERE state = 'QUEUED' ORDER BY queue_position, task_number").all() as Array<{ task_id: string }>;
    return {
        action: "MOVED",
        task: serializeTask(refreshedTask),
        waitingPosition: refreshedWaitingRows.findIndex((row) => row.task_id === task.task_id) + 1,
        titleUpdates,
        dependencies: readTaskDependencies(store, task.task_id)
    };
}

/**
 * Prioritize a task only when it can be activated immediately.
 * @param store Open project store.
 * @param task Current task row.
 */
function applyRunNowEvent(store: IStore, task: ITaskRow): Record<string, unknown> {
    if (task.state === "RUNNING") {
        return { action: "RUN_NOW_ALREADY_ACTIVE", task: serializeTask(task) };
    }
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot run ${task.task_id} now from ${task.state}.`);
    const exclusiveTask = store.database.prepare("SELECT task_id, state FROM tasks WHERE workspace_mode = 'shared' AND state IN ('RUNNING', 'REVIEW', 'APPROVED') LIMIT 1").get() as { task_id: string; state: TaskState } | undefined;
    assertCondition(!exclusiveTask, `Cannot run ${task.task_id} now while ${exclusiveTask?.task_id} is ${exclusiveTask?.state}.`);
    assertCondition(dependenciesAreDone(store, task.task_id), `Cannot run ${task.task_id} now until all dependencies are DONE.`);
    if (task.state === "PLANNING") {
        applyEnqueueEvent(store, task, {});
    }
    store.database.prepare("UPDATE tasks SET workspace_mode = 'shared', worktree_path = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
    const moved = applyMoveEvent(store, requireTask(store, task.task_id), { position: 1 });
    return {
        ...moved,
        action: task.state === "PLANNING" ? "RUN_NOW_ENQUEUED" : "RUN_NOW_PRIORITIZED"
    };
}

/**
 * Request immediate activation in a dedicated repository-local worktree.
 * @param store Open project store.
 * @param task Current task row.
 */
function applyRunIsolatedNowEvent(store: IStore, task: ITaskRow): Record<string, unknown> {
    if (task.state === "RUNNING" && task.workspace_mode === "isolated") {
        return { action: "RUN_ISOLATED_ALREADY_ACTIVE", task: serializeTask(task) };
    }
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot run ${task.task_id} isolated now from ${task.state}.`);
    assertCondition(dependenciesAreDone(store, task.task_id), `Cannot run ${task.task_id} isolated now until all dependencies are DONE.`);
    if (task.state === "PLANNING") {
        applyEnqueueEvent(store, task, {});
    }
    store.database.prepare("UPDATE tasks SET workspace_mode = 'isolated', worktree_path = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
    const moved = applyMoveEvent(store, requireTask(store, task.task_id), { position: 1 });
    return {
        ...moved,
        action: "RUN_ISOLATED_REQUESTED"
    };
}

/**
 * Add or remove one explicit blocking dependency.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Dependency request payload.
 * @param shouldAdd Whether the dependency should be added.
 */
function applyDependencyEvent(store: IStore, task: ITaskRow, payload: IEventPayload, shouldAdd: boolean): Record<string, unknown> {
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot change dependencies for ${task.task_id} from ${task.state}.`);
    const dependencyTaskId = validateTaskId(String(payload.dependencyTaskId || ""));
    assertCondition(dependencyTaskId !== task.task_id, "A task cannot depend on itself.");
    const dependencyTask = requireTask(store, dependencyTaskId);
    if (shouldAdd) {
        assertCondition(dependencyTask.state !== "CANCELED", `${dependencyTask.task_id} is canceled and cannot be used as a dependency.`);
        assertDependencyIsAcyclic(store, task.task_id, dependencyTaskId);
        const change = store.database.prepare("INSERT OR IGNORE INTO dependencies (task_id, depends_on_id, dependency_kind) VALUES (?, ?, 'BLOCKING')").run(task.task_id, dependencyTaskId);
        store.database.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        return {
            action: Number(change.changes) > 0 ? "DEPENDENCY_ADDED" : "DEPENDENCY_ALREADY_PRESENT",
            task: serializeTask(requireTask(store, task.task_id)),
            dependencyTaskId,
            dependencies: readTaskDependencies(store, task.task_id)
        };
    }
    const change = store.database.prepare("DELETE FROM dependencies WHERE task_id = ? AND depends_on_id = ? AND dependency_kind = 'BLOCKING'").run(task.task_id, dependencyTaskId);
    store.database.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
    return {
        action: Number(change.changes) > 0 ? "DEPENDENCY_REMOVED" : "DEPENDENCY_ALREADY_ABSENT",
        task: serializeTask(requireTask(store, task.task_id)),
        dependencyTaskId,
        dependencies: readTaskDependencies(store, task.task_id)
    };
}

/**
 * Record one stable task-local macro decision in the append-only event log.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Decision event payload.
 */
function applyDecisionEvent(store: IStore, task: ITaskRow, payload: IEventPayload): Record<string, unknown> {
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED" || task.state === "RUNNING", `Cannot record a decision for ${task.task_id} from ${task.state}; request rework first when the task is in REVIEW.`);
    const reviewPacket = readReviewPacketFromStore(store, task.task_id);
    const validPayload = validateDecisionPayload(payload);
    if (validPayload.supersedesDecisionId) {
        requireCurrentDecision(reviewPacket, validPayload.supersedesDecisionId);
    }
    const decisionNumber = reviewPacket.decisionCount + 1;
    assertCondition(decisionNumber <= 999, `The task decision ID space D001-D999 is exhausted for ${task.task_id}.`);
    const decisionId = `D${String(decisionNumber).padStart(3, "0")}`;
    store.database.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
    return {
        action: "DECISION_RECORDED",
        task: serializeTask(requireTask(store, task.task_id)),
        decisionId
    };
}

/**
 * Apply a pending event to the state machine.
 * @param store Open project store.
 * @param event Pending event record.
 */
function applyPendingEvent(store: IStore, event: IEventRow): Record<string, unknown> {
    const task = requireTask(store, event.task_id);
    const payload = JSON.parse(event.payload_json) as IEventPayload;
    if (event.kind === "PLANNING_REQUESTED") {
        return applyPlanningEvent(store, task);
    }
    if (event.kind === "ENQUEUE_REQUESTED") {
        return applyEnqueueEvent(store, task, payload);
    }
    if (event.kind === "RUN_NOW_REQUESTED") {
        return applyRunNowEvent(store, task);
    }
    if (event.kind === "RUN_ISOLATED_NOW_REQUESTED") {
        return applyRunIsolatedNowEvent(store, task);
    }
    if (event.kind === "MOVE_REQUESTED") {
        return applyMoveEvent(store, task, payload);
    }
    if (event.kind === "DEPENDENCY_ADD_REQUESTED") {
        return applyDependencyEvent(store, task, payload, true);
    }
    if (event.kind === "DEPENDENCY_REMOVE_REQUESTED") {
        return applyDependencyEvent(store, task, payload, false);
    }
    if ((event.kind === "USER_INPUT_REQUESTED" || event.kind === "USER_INPUT_RECEIVED") && payload.handoffTaskId) {
        const destination = requireTask(store, payload.handoffTaskId);
        const waiting = event.kind === "USER_INPUT_REQUESTED";
        assertCondition(destination.task_id !== task.task_id, "Handoff destination must differ from its sender.");
        assertCondition(!destination.handoff_sender_task_id || destination.handoff_sender_task_id === task.task_id, "Handoff destination does not belong to this sender.");
        if (waiting) {
            assertCondition(task.state === "DONE" || task.state === "PAUSED", `Cannot report an approval handoff for ${task.task_id} from ${task.state}.`);
            assertCondition(destination.state === "RUNNING", "Handoff destination must be RUNNING.");
        }
        store.database.prepare("UPDATE tasks SET handoff_sender_task_id = ?, awaiting_user = CASE WHEN ? THEN 0 ELSE awaiting_user END, updated_at = ? WHERE task_id = ?").run(waiting ? task.task_id : null, Number(waiting), currentTimestamp(), destination.task_id);
        const refreshedDestination = requireTask(store, destination.task_id);
        return {
            action: event.kind,
            task: serializeTask(requireTask(store, task.task_id)),
            handoffTaskId: destination.task_id,
            titleUpdates: [
                { taskId: destination.task_id, threadId: destination.thread_id, title: titleForTask(refreshedDestination) },
                ...readQueuedTitleUpdates(store, destination.queue_position || 1)
            ]
        };
    }
    if (event.kind === "USER_INPUT_REQUESTED") {
        assertCondition(task.state === "RUNNING", `Cannot request user input for ${task.task_id} from ${task.state}.`);
        if (task.awaiting_user) {
            return { action: "USER_INPUT_ALREADY_REQUESTED", task: serializeTask(task) };
        }
        store.database.prepare("UPDATE tasks SET awaiting_user = 1, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        return { action: "USER_INPUT_REQUESTED", task: serializeTask(requireTask(store, task.task_id)) };
    }
    if (event.kind === "USER_INPUT_RECEIVED") {
        if (!task.awaiting_user) {
            return { action: "USER_INPUT_ALREADY_RECEIVED", task: serializeTask(task) };
        }
        store.database.prepare("UPDATE tasks SET awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        return { action: "USER_INPUT_RECEIVED", task: serializeTask(requireTask(store, task.task_id)) };
    }
    if (event.kind === "DECISION_RECORDED") {
        return applyDecisionEvent(store, task, payload);
    }
    if (event.kind === "REVIEW_REQUESTED") {
        assertCondition(!task.awaiting_user || !readAutopilotStatus(store).enabled, "Resolve awaited user input before autopilot review.");
        if (task.state === "APPROVED" || task.state === "DONE") {
            return { action: "REVIEW_ALREADY_RECORDED", task: serializeTask(task), summary: payload.summary || null, reviewPacket: readReviewPacketFromStore(store, task.task_id) };
        }
        if (task.state === "REVIEW") {
            return { action: "REVIEW_ALREADY_RECORDED", task: serializeTask(task), summary: payload.summary || null, reviewPacket: readReviewPacketFromStore(store, task.task_id) };
        }
        assertCondition(task.state === "RUNNING", `Cannot request review for ${task.task_id} from ${task.state}.`);
        const reviewPacket = readReviewPacketFromStore(store, task.task_id);
        store.database.prepare("UPDATE tasks SET state = 'REVIEW', awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "REVIEW_READY", task: serializeTask(refreshedTask), summary: payload.summary || null, reviewPacket };
    }
    if (event.kind === "REWORK_REQUESTED") {
        if (task.state === "RUNNING") {
            return { action: "REWORK_ALREADY_STARTED", task: serializeTask(task), summary: payload.summary || null };
        }
        assertCondition(task.state === "REVIEW", `Cannot request rework for ${task.task_id} from ${task.state}.`);
        store.database.prepare("UPDATE tasks SET state = 'RUNNING', awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "REWORK_STARTED", task: serializeTask(refreshedTask), summary: payload.summary || null };
    }
    if (event.kind === "APPROVAL_REQUESTED") {
        if (payload.autopilotEventKey) {
            validateAutopilotApproval(store, task, payload);
        }
        if (task.state === "APPROVED" || task.state === "PAUSED" || task.state === "DONE") {
            const commitMessage = validateApprovalCommitMessage(task, payload.commitMessage);
            return { action: "APPROVAL_ALREADY_RECORDED", task: serializeTask(task), userRequestId: payload.userRequestId, commitMessage, approvalTarget: task.approval_target };
        }
        // A direct RUNNING approval recovers a turn interrupted before it recorded REVIEW.
        assertCondition(task.state === "RUNNING" || task.state === "REVIEW", `Cannot approve ${task.task_id} from ${task.state}.`);
        assertCondition(payload.userRequestId && payload.userRequestId.trim().length > 0, "Approval requires a direct user request ID.");
        const commitMessage = validateApprovalCommitMessage(task, payload.commitMessage);
        const approvalTarget = payload.approvalTarget || "DONE";
        store.database.prepare("UPDATE tasks SET state = 'APPROVED', awaiting_user = 0, approval_event_key = ?, approval_target = ?, updated_at = ? WHERE task_id = ?").run(event.event_key, approvalTarget, currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "APPROVED", task: serializeTask(refreshedTask), userRequestId: payload.userRequestId, commitMessage, approvalTarget, approvalMode: payload.autopilotEventKey ? "autopilot" : "manual" };
    }
    if (event.kind === "CANCEL_REQUESTED") {
        assertCondition(payload.userRequestId && payload.userRequestId.trim().length > 0, "Cancellation requires a direct user request ID.");
        const exclusionRequested = payload.cancelSource === "exclude";
        if (task.state === "CANCELED") {
            if (exclusionRequested) {
                store.database.prepare("INSERT OR IGNORE INTO task_exclusions (thread_id, reason, created_at) VALUES (?, ?, ?)").run(task.thread_id, validateCompactText(payload.exclusionReason, "Exclusion reason", 200, true)!, currentTimestamp());
            }
            return { action: "CANCELLATION_ALREADY_RECORDED", task: serializeTask(task), excluded: exclusionRequested, userRequestId: payload.userRequestId };
        }
        if (exclusionRequested) {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot exclude ${task.task_id} from ${task.state}.`);
        } else {
            assertCondition(["PLANNING", "QUEUED", "RUNNING", "REVIEW", "PAUSED", "BLOCKED"].includes(task.state), `Cannot cancel ${task.task_id} from ${task.state}.`);
        }
        const timestamp = currentTimestamp();
        store.database.prepare(`
            UPDATE tasks
            SET state = 'CANCELED', blocked_from_state = NULL, awaiting_user = 0, queue_position = NULL,
                updated_at = ?
            WHERE task_id = ?
        `).run(timestamp, task.task_id);
        if (exclusionRequested) {
            store.database.prepare("INSERT OR IGNORE INTO task_exclusions (thread_id, reason, created_at) VALUES (?, ?, ?)").run(task.thread_id, validateCompactText(payload.exclusionReason, "Exclusion reason", 200, true)!, timestamp);
        }
        const activeRows = store.database.prepare(`
            SELECT task_id FROM tasks
            WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
            ORDER BY queue_position IS NULL, queue_position, task_number
        `).all() as Array<{ task_id: string }>;
        const activeTaskIds: string[] = [];
        for (const activeRow of activeRows) {
            activeTaskIds.push(activeRow.task_id);
        }
        const titleUpdates = writeQueueOrder(store, activeTaskIds);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "CANCELED", task: serializeTask(refreshedTask), excluded: exclusionRequested, titleUpdates, userRequestId: payload.userRequestId };
    }
    assertCondition(event.kind === "BLOCKED_REPORTED", `Unsupported event kind: ${event.kind}`);
    if (task.state === "BLOCKED") {
        return { action: "BLOCK_ALREADY_RECORDED", task: serializeTask(task), reason: payload.reason };
    }
    assertCondition(task.state === "QUEUED" || task.state === "RUNNING" || task.state === "REVIEW", `Cannot block ${task.task_id} from ${task.state}.`);
    assertCondition(payload.reason && payload.reason.trim().length > 0, "A blocked event requires a reason.");
    store.database.prepare("UPDATE tasks SET state = 'BLOCKED', blocked_from_state = ?, awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(task.state, currentTimestamp(), task.task_id);
    const titleUpdates = task.state === "QUEUED" ? readQueuedTitleUpdates(store, task.queue_position || 1) : [];
    const refreshedTask = requireTask(store, task.task_id);
    return { action: "BLOCKED", task: serializeTask(refreshedTask), reason: payload.reason, titleUpdates };
}

/**
 * Process pending events serially through the deterministic engine.
 * @param options Project and optional state-root settings.
 */
function processPendingEvents(options: IControlRoomOptions): Record<string, unknown> {
    const store = openStore(options);
    const results: Record<string, unknown>[] = [];
    try {
        requireProject(store);
        const pendingEvents = store.database.prepare(`
            SELECT sequence, event_key, task_id, kind, payload_json
            FROM events
            WHERE processed_at IS NULL
            ORDER BY sequence
        `).all() as unknown as IEventRow[];
        for (const event of pendingEvents) {
            beginTransaction(store.database);
            try {
                const stillPending = store.database.prepare("SELECT processed_at FROM events WHERE sequence = ?").get(event.sequence) as { processed_at: string | null } | undefined;
                if (!stillPending || stillPending.processed_at) {
                    commitTransaction(store.database);
                    continue;
                }
                const previousTask = requireTask(store, event.task_id);
                const result = applyPendingEvent(store, event);
                const updatedTask = requireTask(store, event.task_id);
                if (updatedTask.state !== "RUNNING") {
                    store.database.prepare("UPDATE activation_deliveries SET state = 'CANCELED', updated_at = ? WHERE task_id = ? AND state IN ('PENDING', 'CLAIMED')").run(currentTimestamp(), updatedTask.task_id);
                }
                if (previousTask.handoff_sender_task_id && updatedTask.state !== "RUNNING") {
                    store.database.prepare("UPDATE tasks SET handoff_sender_task_id = NULL WHERE task_id = ?").run(updatedTask.task_id);
                    const sender = requireTask(store, previousTask.handoff_sender_task_id);
                    result.task = serializeTask(requireTask(store, updatedTask.task_id));
                    result.titleUpdates = [
                        ...(Array.isArray(result.titleUpdates) ? result.titleUpdates : []),
                        { taskId: sender.task_id, threadId: sender.thread_id, title: titleForTask(sender) },
                        ...readQueuedTitleUpdates(store, previousTask.queue_position || 1)
                    ];
                }
                store.database.prepare("UPDATE events SET processed_at = ?, result_json = ? WHERE sequence = ?").run(currentTimestamp(), JSON.stringify(result), event.sequence);
                commitTransaction(store.database);
                results.push({ eventKey: event.event_key, ...result });
            } catch (error) {
                rollbackTransaction(store.database);
                const message = error instanceof Error ? error.message : String(error);
                beginTransaction(store.database);
                try {
                    const rejectedResult = { action: "REJECTED", taskId: event.task_id, error: message };
                    store.database.prepare("UPDATE events SET processed_at = ?, result_json = ? WHERE sequence = ?").run(currentTimestamp(), JSON.stringify(rejectedResult), event.sequence);
                    commitTransaction(store.database);
                    results.push({ eventKey: event.event_key, ...rejectedResult });
                } catch (rejectionError) {
                    rollbackTransaction(store.database);
                    throw rejectionError;
                }
            }
        }
        return { processedCount: results.length, controlRoomTitle: titleForControlRoom(), results };
    } finally {
        store.database.close();
    }
}

/**
 * Determine whether every dependency for a task is complete.
 * @param store Open project store.
 * @param taskId Task whose dependencies must be checked.
 */
function dependenciesAreDone(store: IStore, taskId: string): boolean {
    const unmet = store.database.prepare(`
        SELECT COUNT(*) AS count
        FROM dependencies AS dependency
        JOIN tasks AS prerequisite ON prerequisite.task_id = dependency.depends_on_id
        WHERE dependency.task_id = ? AND prerequisite.state <> 'DONE'
    `).get(taskId) as { count: number };
    return Number(unmet.count) === 0;
}

/**
 * Retrieve the accepted start request for an activation without inventing user provenance.
 * @param store Open project store.
 * @param taskId Task being activated.
 */
function readActivationRequest(store: IStore, taskId: string): IActivationRequest | null {
    const event = store.database.prepare(`
        SELECT event_key, kind, payload_json, created_at
        FROM events
        WHERE task_id = ? AND processed_at IS NOT NULL
            AND kind IN ('ENQUEUE_REQUESTED', 'RUN_NOW_REQUESTED', 'RUN_ISOLATED_NOW_REQUESTED')
            AND json_extract(result_json, '$.action') IN (
                'ENQUEUED', 'REENQUEUED', 'RUN_NOW_ENQUEUED', 'RUN_NOW_PRIORITIZED', 'RUN_ISOLATED_REQUESTED'
            )
        ORDER BY sequence DESC
        LIMIT 1
    `).get(taskId) as { event_key: string; kind: EventKind; payload_json: string; created_at: string } | undefined;
    if (!event) {
        return null;
    }
    const payload = JSON.parse(event.payload_json) as IEventPayload;
    return {
        eventKey: event.event_key,
        eventKind: event.kind,
        userRequestId: payload.userRequestId || null,
        requestedAt: event.created_at
    };
}

/**
 * Validate and create the parent directory used by isolated task worktrees.
 * @param projectRoot Canonical project root.
 * @param worktreePath Deterministic task worktree path.
 */
function prepareIsolatedWorktreeParent(projectRoot: string, worktreePath: string): void {
    const controlRoomDirectory = path.join(projectRoot, ".control-room");
    const worktreesDirectory = path.join(controlRoomDirectory, "worktrees");
    assertCondition(worktreePath.startsWith(`${worktreesDirectory}${path.sep}`), `Worktree path escapes the ControlRoom directory: ${worktreePath}`);
    assertCondition(!pathIsSymbolicLink(controlRoomDirectory), `ControlRoom directory cannot be a symbolic link: ${controlRoomDirectory}`);
    fs.mkdirSync(controlRoomDirectory, { recursive: true, mode: 0o700 });
    const controlRoomStatus = fs.lstatSync(controlRoomDirectory);
    assertCondition(!controlRoomStatus.isSymbolicLink() && controlRoomStatus.isDirectory(), `ControlRoom path is not a safe directory: ${controlRoomDirectory}`);
    assertCondition(!pathIsSymbolicLink(worktreesDirectory), `ControlRoom worktrees directory cannot be a symbolic link: ${worktreesDirectory}`);
    fs.mkdirSync(worktreesDirectory, { recursive: true, mode: 0o700 });
    const worktreesStatus = fs.lstatSync(worktreesDirectory);
    assertCondition(!worktreesStatus.isSymbolicLink() && worktreesStatus.isDirectory(), `ControlRoom worktrees path is not a safe directory: ${worktreesDirectory}`);
    assertCondition(!fs.existsSync(worktreePath), `Isolated worktree path already exists: ${worktreePath}`);
    const relativeWorktreePath = path.relative(projectRoot, worktreePath);
    const ignored = runGit(projectRoot, ["check-ignore", "--quiet", "--no-index", "--", relativeWorktreePath]);
    assertCondition(ignored.status === 0, `${WORKTREE_IGNORE_PATTERN} is not active in the root .gitignore; rerun $control-room init before isolated execution.`);
}

/**
 * Validate an existing worktree left by an interrupted isolated activation.
 * @param projectRoot Canonical project root.
 * @param worktreePath Deterministic isolated worktree path.
 * @param workerBranch Expected task branch.
 * @param baseCommit Expected unchanged activation base.
 */
function validateRecoverableIsolatedWorktree(projectRoot: string, worktreePath: string, workerBranch: string, baseCommit: string): void {
    assertCondition(!pathIsSymbolicLink(path.join(projectRoot, ".control-room")), `ControlRoom directory cannot be a symbolic link: ${path.join(projectRoot, ".control-room")}`);
    assertCondition(!pathIsSymbolicLink(path.join(projectRoot, ".control-room", "worktrees")), `ControlRoom worktrees directory cannot be a symbolic link: ${path.join(projectRoot, ".control-room", "worktrees")}`);
    assertCondition(!pathIsSymbolicLink(worktreePath) && fs.statSync(worktreePath).isDirectory(), `Interrupted isolated worktree path is unsafe: ${worktreePath}`);
    const repositoryRoot = requireGit(worktreePath, ["rev-parse", "--show-toplevel"], "Resolve interrupted isolated repository");
    assertCondition(fs.realpathSync(repositoryRoot) === fs.realpathSync(worktreePath), `Interrupted isolated repository root does not match ${worktreePath}.`);
    const commonDirectory = requireGit(worktreePath, ["rev-parse", "--git-common-dir"], "Resolve interrupted isolated common Git directory");
    assertCondition(fs.realpathSync(path.resolve(worktreePath, commonDirectory)) === fs.realpathSync(path.join(projectRoot, ".git")), `Interrupted isolated worktree does not belong to ${projectRoot}.`);
    requireBranchCheckout(worktreePath, workerBranch);
    assertCondition(resolveCurrentHeadIfExists(worktreePath) === baseCommit, `Interrupted isolated branch ${workerBranch} contains changes and cannot be adopted automatically.`);
    assertCondition(readWorkingTreeStatus(worktreePath).length === 0, `Interrupted isolated worktree contains changes and cannot be adopted automatically: ${worktreePath}`);
}

/**
 * Activate one queued task immediately in its dedicated repository-local worktree.
 * @param options Project and optional state-root settings.
 * @param taskId Task requested for isolated activation.
 */
function activateIsolatedTask(options: IControlRoomOptions, taskId: string): IActivationResult {
    const store = openStore(options);
    let createdWorktreePath: string | null = null;
    let createdWorkerBranch: string | null = null;
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        if (task.state === "RUNNING" && task.workspace_mode === "isolated" && task.worktree_path) {
            commitTransaction(store.database);
            return { activated: false, alreadyActive: true, controlRoomTitle: titleForControlRoom(), task: serializeTask(task) };
        }
        assertCondition(task.state === "QUEUED", `Cannot activate ${task.task_id} isolated from ${task.state}.`);
        assertCondition(task.workspace_mode === "isolated", `${task.task_id} was not requested for isolated execution.`);
        assertCondition(dependenciesAreDone(store, task.task_id), `Cannot activate ${task.task_id} until all dependencies are DONE.`);
        const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        assertCondition(baseCommit, `Cannot run ${task.task_id} isolated before ${project.base_branch} has its first commit.`);
        const workerBranch = workerBranchForTask(task.task_id);
        const worktreePath = isolatedWorktreePathForTask(store.projectRoot, task.task_id);
        const existingWorkerCommit = resolveLocalBranchHeadIfExists(store.projectRoot, workerBranch);
        const existingWorktree = fs.existsSync(worktreePath);
        const recoveredActivation = Boolean(existingWorkerCommit || existingWorktree);
        if (recoveredActivation) {
            assertCondition(existingWorkerCommit && existingWorktree, `Interrupted isolated activation for ${task.task_id} is incomplete; preserve the remaining branch or path for manual recovery.`);
            assertCondition(existingWorkerCommit === baseCommit, `Interrupted isolated branch ${workerBranch} moved from activation base ${baseCommit}.`);
            validateRecoverableIsolatedWorktree(store.projectRoot, worktreePath, workerBranch, baseCommit);
        } else {
            prepareIsolatedWorktreeParent(store.projectRoot, worktreePath);
            requireGit(store.projectRoot, ["worktree", "add", "--quiet", "-b", workerBranch, worktreePath, project.base_branch], `Create isolated worktree for ${task.task_id}`);
            createdWorktreePath = worktreePath;
            createdWorkerBranch = workerBranch;
        }
        store.database.prepare(`
            UPDATE tasks
            SET state = 'RUNNING', awaiting_user = 0, base_commit = ?, branch_name = ?,
                workspace_mode = 'isolated', worktree_path = ?, reviewed_commit = NULL,
                approved_commit = NULL, updated_at = ?
            WHERE task_id = ?
        `).run(baseCommit, workerBranch, worktreePath, currentTimestamp(), task.task_id);
        const runningTask = requireTask(store, task.task_id);
        const reviewPacket = readReviewPacketFromStore(store, task.task_id);
        const activationRequest = readActivationRequest(store, task.task_id);
        const titleUpdates = readQueuedTitleUpdates(store, task.queue_position || 1);
        const instruction = "Use workspacePath for every file read, edit, command, and verification. Do not stage or commit; leave changes uncommitted for review.";
        const executionBrief: IExecutionBrief = {
                activationKey: nodeCrypto.randomUUID(),
                taskId: runningTask.task_id,
                threadId: runningTask.thread_id,
                semanticName: runningTask.semantic_name,
                projectRoot: store.projectRoot,
                workspacePath: worktreePath,
                activationRequest,
                baseCommit,
                baseBranch: project.base_branch,
                workerBranch,
                dependencies: readTaskDependencies(store, runningTask.task_id),
                reviewPacket,
                instruction
            };
        persistActivation(store, executionBrief);
        commitTransaction(store.database);
        return {
            activated: true,
            isolated: true,
            recoveredActivation,
            controlRoomTitle: titleForControlRoom(),
            task: serializeTask(runningTask),
            titleUpdates,
            executionBrief
        };
    } catch (error) {
        rollbackTransaction(store.database);
        if (createdWorktreePath) {
            runGit(store.projectRoot, ["worktree", "remove", "--force", createdWorktreePath]);
        }
        if (createdWorkerBranch) {
            const branchCommit = resolveLocalBranchHeadIfExists(store.projectRoot, createdWorkerBranch);
            if (branchCommit) {
                runGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${createdWorkerBranch}`, branchCommit]);
            }
        }
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Activate the first eligible queued task when the project is idle.
 * @param options Project and optional state-root settings.
 */
function activateNextTask(options: IControlRoomOptions): IActivationResult {
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const autopilotBlocker = readAutopilotStatus(store).enabled ? readAutopilotBlocker(store) : null;
        if (autopilotBlocker) {
            commitTransaction(store.database);
            return { activated: false, controlRoomTitle: titleForControlRoom(), reason: "AUTOPILOT_WAITING", taskId: autopilotBlocker };
        }
        const exclusiveTask = store.database.prepare("SELECT task_id, state FROM tasks WHERE workspace_mode = 'shared' AND state IN ('RUNNING', 'REVIEW', 'APPROVED') LIMIT 1").get() as { task_id: string; state: TaskState } | undefined;
        if (exclusiveTask) {
            const controlRoomTitle = titleForControlRoom();
            commitTransaction(store.database);
            return { activated: false, controlRoomTitle, reason: "ACTIVE_TASK_PRESENT", taskId: exclusiveTask.task_id, state: exclusiveTask.state };
        }
        const queuedTasks = store.database.prepare("SELECT * FROM tasks WHERE state = 'QUEUED' AND workspace_mode = 'shared' ORDER BY queue_position, task_number").all() as unknown as ITaskRow[];
        let selectedTask: ITaskRow | undefined;
        for (const queuedTask of queuedTasks) {
            if (dependenciesAreDone(store, queuedTask.task_id)) {
                selectedTask = queuedTask;
                break;
            }
        }
        if (!selectedTask) {
            const controlRoomTitle = titleForControlRoom();
            commitTransaction(store.database);
            return { activated: false, controlRoomTitle, reason: queuedTasks.length === 0 ? "QUEUE_EMPTY" : "DEPENDENCIES_PENDING" };
        }
        const reviewPacket = readReviewPacketFromStore(store, selectedTask.task_id);
        const workerBranch = workerBranchForTask(selectedTask.task_id);
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        let currentBaseCommit: string | null;
        if (!baseCommit) {
            assertCondition(resolveCurrentHeadIfExists(store.projectRoot) === null, `Base branch ${project.base_branch} has no commits, but ${currentBranch || "the current branch"} has a commit.`);
            const previousTask = store.database.prepare(`
                SELECT task_id FROM tasks
                WHERE branch_name = ? AND state IN ('DONE', 'CANCELED')
                LIMIT 1
            `).get(currentBranch) as { task_id: string } | undefined;
            assertCondition(
                currentBranch === project.base_branch || currentBranch === workerBranch || previousTask,
                `ControlRoom requires unborn branch ${project.base_branch}; found ${currentBranch || "detached HEAD"}.`
            );
            const previousActivation = store.database.prepare("SELECT task_id FROM tasks WHERE branch_name IS NOT NULL LIMIT 1").get() as { task_id: string } | undefined;
            if (previousActivation) {
                assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "The shared Local working tree must be clean before activating another task.");
            }
            const existingWorkerBranch = runGit(store.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workerBranch}`]);
            assertCondition(
                existingWorkerBranch.status === 1,
                existingWorkerBranch.status === 0 ?
                    `Worker branch already exists for ${selectedTask.task_id}: ${workerBranch}` :
                    `Inspect worker branch failed: ${existingWorkerBranch.stderr || existingWorkerBranch.stdout}`
            );
            requireGit(store.projectRoot, ["symbolic-ref", "HEAD", `refs/heads/${workerBranch}`], `Create unborn worker branch ${workerBranch}`);
            currentBaseCommit = null;
        } else if (currentBranch === project.base_branch) {
            currentBaseCommit = requireBaseCheckout(store.projectRoot, project.base_branch);
            const existingWorkerBranch = runGit(store.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workerBranch}`]);
            assertCondition(
                existingWorkerBranch.status === 1,
                existingWorkerBranch.status === 0 ?
                    `Worker branch already exists for ${selectedTask.task_id}: ${workerBranch}` :
                    `Inspect worker branch failed: ${existingWorkerBranch.stderr || existingWorkerBranch.stdout}`
            );
            requireGit(store.projectRoot, ["checkout", "-b", workerBranch, project.base_branch], `Create worker branch ${workerBranch}`);
        } else {
            assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "The shared Local working tree must be clean before activating a task.");
            assertCondition(currentBranch === workerBranch, `ControlRoom requires branch ${project.base_branch}; found ${currentBranch || "detached HEAD"}.`);
            currentBaseCommit = baseCommit;
            assertCondition(requireBranchCheckout(store.projectRoot, workerBranch) === currentBaseCommit, `Interrupted activation branch ${workerBranch} moved before state persistence.`);
        }
        store.database.prepare(`
            UPDATE tasks
            SET state = 'RUNNING', awaiting_user = 0, base_commit = ?, branch_name = ?,
                workspace_mode = 'shared', worktree_path = NULL, reviewed_commit = NULL,
                approved_commit = NULL, updated_at = ?
            WHERE task_id = ?
        `).run(currentBaseCommit, workerBranch, currentTimestamp(), selectedTask.task_id);
        const runningTask = requireTask(store, selectedTask.task_id);
        const activationRequest = readActivationRequest(store, selectedTask.task_id);
        const titleUpdates = readQueuedTitleUpdates(store, selectedTask.queue_position || 1);
        const controlRoomTitle = titleForControlRoom();
        const instruction = "Implement on the active worker branch without staging or committing. Leave all changes uncommitted for review.";
        const executionBrief: IExecutionBrief = {
                activationKey: nodeCrypto.randomUUID(),
                taskId: runningTask.task_id,
                threadId: runningTask.thread_id,
                semanticName: runningTask.semantic_name,
                projectRoot: store.projectRoot,
                workspacePath: store.projectRoot,
                activationRequest,
                baseCommit: runningTask.base_commit,
                baseBranch: project.base_branch,
                workerBranch,
                dependencies: readTaskDependencies(store, runningTask.task_id),
                reviewPacket,
                instruction
            };
        persistActivation(store, executionBrief);
        commitTransaction(store.database);
        return {
            activated: true,
            controlRoomTitle,
            task: serializeTask(runningTask),
            titleUpdates,
            executionBrief
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Resume a paused or explicitly reopened completed task, or restore a blocked task.
 * @param options Project and optional state-root settings.
 * @param taskId Task identifier.
 * @param reopen Whether the user explicitly requested reopening completed work.
 */
function resumeTask(options: IControlRoomOptions, taskId: string, reopen = false): Record<string, unknown> {
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        if (reopen && task.state === "PLANNING") {
            commitTransaction(store.database);
            return { reopened: false, task: serializeTask(task), titleUpdates: [{ taskId: task.task_id, threadId: task.thread_id, title: titleForTask(task) }] };
        }
        if (reopen) assertCondition(task.state === "DONE", `Cannot reopen ${task.task_id} from ${task.state}.`);
        if (task.state === "PAUSED" || reopen) {
            assertCondition(!project.integration_task_id, "Approval integration must finish before resuming or reopening work.");
            if (reopen && task.workspace_mode === "shared" && task.branch_name && !task.worktree_path) {
                const workerHead = resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name);
                assertCondition(!workerHead || workerHead === task.base_commit, "Completed worker branch changed; preserve its work.");
                const branch = requireGit(store.projectRoot, ["branch", "--show-current"], "Read completed worker branch");
                if (branch === task.branch_name) {
                    assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "Completed worker checkout changed; preserve its work.");
                    requireGit(store.projectRoot, ["checkout", project.base_branch], "Return completed worker to base");
                }
                if (workerHead) requireGit(store.projectRoot, ["branch", "-d", task.branch_name], "Release unchanged completed worker branch");
                task.branch_name = null;
            }
            assertCondition(!task.branch_name && !task.worktree_path, `${task.task_id} still owns a workspace and cannot return to PLANNING safely.`);
            const deferred = store.database.prepare("SELECT * FROM tasks WHERE handoff_sender_task_id = ?").all(task.task_id) as unknown as ITaskRow[];
            assertCondition(reopen || deferred.length === 0, "Resolve the pending activation handoff before resuming.");
            assertCondition(deferred.length <= 1, "Resolve multiple pending handoffs before reopening.");
            for (const destination of deferred) {
                const delivery = store.database.prepare("SELECT state FROM activation_deliveries WHERE task_id = ? AND state IN ('PENDING', 'CLAIMED')").get(destination.task_id) as { state: string } | undefined;
                assertCondition(destination.state === "RUNNING" && destination.workspace_mode === "shared" && !destination.worktree_path && destination.branch_name && delivery?.state === "PENDING", `Cannot defer ${destination.task_id}: its activation may already have been delivered.`);
                assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "Cannot defer a changed shared checkout.");
                const branch = requireGit(store.projectRoot, ["branch", "--show-current"], "Read pending activation branch");
                const workerHead = resolveLocalBranchHeadIfExists(store.projectRoot, destination.branch_name);
                assertCondition((branch === destination.branch_name || branch === project.base_branch) && (!workerHead || workerHead === destination.base_commit) && resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch) === destination.base_commit, "Pending activation or base branch changed; preserve its workspace.");
                if (branch !== project.base_branch) requireGit(store.projectRoot, destination.base_commit ? ["checkout", project.base_branch] : ["symbolic-ref", "HEAD", `refs/heads/${project.base_branch}`], "Return undelivered activation to base");
                if (workerHead) requireGit(store.projectRoot, ["branch", "-d", destination.branch_name], "Remove unchanged undelivered branch");
                store.database.prepare("UPDATE activation_deliveries SET state = 'CANCELED', updated_at = ? WHERE task_id = ? AND state = 'PENDING'").run(currentTimestamp(), destination.task_id);
                store.database.prepare("UPDATE tasks SET state = 'QUEUED', base_commit = NULL, branch_name = NULL, handoff_sender_task_id = NULL, awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), destination.task_id);
            }
            store.database.prepare(`
                UPDATE tasks
                SET state = 'PLANNING', blocked_from_state = NULL, awaiting_user = 0,
                    queue_position = NULL, base_commit = NULL, branch_name = NULL,
                    workspace_mode = 'shared', worktree_path = NULL, reviewed_commit = NULL,
                    approved_commit = NULL, approval_event_key = NULL, approval_target = 'DONE',
                    integrated_commit = NULL, updated_at = ?
                WHERE task_id = ?
            `).run(currentTimestamp(), task.task_id);
            const resumedTask = requireTask(store, task.task_id);
            commitTransaction(store.database);
            return { resumed: true, resumedFrom: task.state, deferredTaskIds: deferred.map((destination) => destination.task_id), task: serializeTask(resumedTask), titleUpdates: [{ taskId: resumedTask.task_id, threadId: resumedTask.thread_id, title: titleForTask(resumedTask) }, ...readQueuedTitleUpdates(store, 1)] };
        }
        assertCondition(task.state === "BLOCKED" && task.blocked_from_state, `${task.task_id} is not resumable.`);
        if (task.workspace_mode === "shared" && (task.blocked_from_state === "RUNNING" || task.blocked_from_state === "REVIEW")) {
            const exclusiveTask = store.database.prepare("SELECT task_id FROM tasks WHERE workspace_mode = 'shared' AND state IN ('RUNNING', 'REVIEW', 'APPROVED') AND task_id <> ? LIMIT 1").get(task.task_id) as Record<string, unknown> | undefined;
            assertCondition(!exclusiveTask, exclusiveTask ? `Another task is active: ${exclusiveTask.task_id}` : "Project is not idle.");
        }
        const resumedQueuePosition = task.blocked_from_state === "QUEUED" ? task.queue_position || 1 : null;
        store.database.prepare("UPDATE tasks SET state = blocked_from_state, blocked_from_state = NULL, awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const resumedTask = requireTask(store, task.task_id);
        const titleUpdates = resumedQueuePosition ? readQueuedTitleUpdates(store, resumedQueuePosition) : [];
        commitTransaction(store.database);
        return { resumed: true, task: serializeTask(resumedTask), titleUpdates };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Read dependency-eligible isolated tasks that still require activation.
 * @param options Project and optional state-root settings.
 */
function readEligibleIsolatedTaskIds(options: IControlRoomOptions): string[] {
    const store = openStore(options);
    try {
        requireProject(store);
        const queuedTasks = store.database.prepare("SELECT * FROM tasks WHERE state = 'QUEUED' AND workspace_mode = 'isolated' ORDER BY queue_position, task_number").all() as unknown as ITaskRow[];
        return queuedTasks.filter((task) => dependenciesAreDone(store, task.task_id)).map((task) => task.task_id);
    } finally {
        store.database.close();
    }
}

/**
 * Read one task review packet without changing state.
 * @param options Project and optional state-root settings.
 * @param taskId Task identifier to read.
 */
function getReviewPacket(options: IControlRoomOptions, taskId: string): IReviewPacket {
    const store = openReadStore(options);
    assertCondition("database" in store, "Cannot read the review packet: state is missing or requires migration. Run $control-room init.");
    try {
        requireProject(store);
        const task = requireTask(store, taskId);
        return readReviewPacketFromStore(store, task.task_id);
    } finally {
        store.database.close();
    }
}

/**
 * Read the project snapshot, one task, or the role of one Codex thread without changing state.
 * @param options Project and optional state-root settings.
 * @param taskId Optional task identifier to select.
 * @param threadId Optional Codex thread identifier to resolve.
 */
function getStatus(options: IControlRoomOptions, taskId?: string, threadId?: string): Record<string, unknown> {
    assertCondition(!(taskId && threadId), "Status accepts either a task ID or a thread ID, not both.");
    const validThreadId = threadId ? validateThreadId(threadId) : null;
    const store = openReadStore(options);
    if (!("database" in store)) {
        return { ...store };
    }
    try {
        const project = requireProject(store);
        const autopilot = readAutopilotStatus(store);
        if (taskId) {
            const task = requireTask(store, taskId);
            const includesReviewPacket = task.state === "RUNNING" || task.state === "REVIEW" || task.state === "APPROVED" || task.state === "PAUSED" || task.state === "DONE";
            return {
                projectRoot: store.projectRoot,
                autopilot,
                controlRoomTitle: titleForControlRoom(),
                task: serializeTask(task),
                ...(includesReviewPacket ? { reviewPacket: readReviewPacketFromStore(store, task.task_id) } : {})
            };
        }
        if (validThreadId) {
            if (validThreadId === project.coordinator_thread_id) {
                return { projectRoot: store.projectRoot, autopilot, controlRoomTitle: titleForControlRoom(), controlRoomThreadId: project.coordinator_thread_id, role: "CONTROL_ROOM", task: null };
            }
            const task = store.database.prepare(`${TASK_WITH_QUEUED_POSITION_SELECT} WHERE task.thread_id = ?`).get(validThreadId) as ITaskRow | undefined;
            const exclusion = store.database.prepare("SELECT * FROM task_exclusions WHERE thread_id = ?").get(validThreadId) as ITaskExclusionRow | undefined;
            const isExcluded = Boolean(exclusion && (!task || task.state === "CANCELED"));
            const includesReviewPacket = task && (task.state === "RUNNING" || task.state === "REVIEW" || task.state === "APPROVED" || task.state === "PAUSED" || task.state === "DONE");
            return {
                projectRoot: store.projectRoot,
                autopilot,
                controlRoomTitle: titleForControlRoom(),
                controlRoomThreadId: project.coordinator_thread_id,
                role: isExcluded ? "EXCLUDED" : task ? "WORKER" : "UNREGISTERED",
                task: task && !isExcluded ? serializeTask(task) : null,
                ...(isExcluded && exclusion ? { exclusion: { reason: exclusion.reason, createdAt: exclusion.created_at } } : {}),
                ...(includesReviewPacket && task ? { reviewPacket: readReviewPacketFromStore(store, task.task_id) } : {})
            };
        }
        const counts = store.database.prepare("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state ORDER BY state").all() as Array<{ state: TaskState; count: number }>;
        const stateCounts: Record<string, number> = {};
        for (const countRow of counts) {
            stateCounts[countRow.state] = Number(countRow.count);
        }
        return {
            projectRoot: store.projectRoot,
            autopilot,
            controlRoomTitle: titleForControlRoom(),
            controlRoomThreadId: project.coordinator_thread_id,
            baseBranch: project.base_branch,
            gitMode: project.git_mode,
            commitTaskId: project.integration_task_id,
            nextTaskId: project.next_task_number <= 9999 ? `T${String(project.next_task_number).padStart(4, "0")}` : null,
            stateCounts
        };
    } finally {
        store.database.close();
    }
}

/**
 * Read the ordered active queue without changing state.
 * @param options Project and optional state-root settings.
 */
function getQueue(options: IControlRoomOptions): Record<string, unknown> {
    const store = openReadStore(options);
    if (!("database" in store)) {
        return { ...store, queue: [] };
    }
    try {
        const project = requireProject(store);
        const tasks = store.database.prepare(`
            ${TASK_WITH_QUEUED_POSITION_SELECT}
            WHERE task.state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
            ORDER BY task.queue_position IS NULL, task.queue_position, task.task_number
        `).all() as unknown as ITaskRow[];
        const queue: Record<string, unknown>[] = [];
        for (const task of tasks) {
            queue.push({ ...serializeTask(task), dependencies: readTaskDependencies(store, task.task_id) });
        }
        const progress = store.database.prepare("SELECT COUNT(CASE WHEN state = 'DONE' THEN 1 END) AS completed, COUNT(*) AS total FROM tasks WHERE state NOT IN ('PLANNING', 'PAUSED', 'CANCELED')").get() as { completed: number; total: number };
        const completedTasks = store.database.prepare(`${TASK_WITH_QUEUED_POSITION_SELECT} WHERE task.state = 'DONE' ORDER BY task.updated_at DESC, task.task_number DESC LIMIT 5`).all() as unknown as ITaskRow[];
        const pendingActivations = store.database.prepare("SELECT task_id AS taskId, activation_key AS activationKey, state FROM activation_deliveries WHERE state IN ('PENDING', 'CLAIMED') ORDER BY created_at, task_id").all();
        return { projectRoot: store.projectRoot, controlRoomTitle: titleForControlRoom(), autopilot: readAutopilotStatus(store), integrationTaskId: project.integration_task_id, pendingActivations, capturedAt: currentTimestamp(), progress: { ...progress }, completedTasks: completedTasks.map((task) => serializeTask(task)), queue };
    } finally {
        store.database.close();
    }
}

/**
 * Add one serialized task title to a deduplicated settlement update map.
 * @param updates Title updates keyed by Codex thread ID.
 * @param task Serialized task candidate.
 */
function addSettlementTitleUpdate(updates: Map<string, ITitleUpdate>, task: unknown): void {
    if (!task || typeof task !== "object") {
        return;
    }
    const candidate = task as Record<string, unknown>;
    if (typeof candidate.taskId !== "string" || typeof candidate.threadId !== "string" || typeof candidate.title !== "string") {
        return;
    }
    updates.set(candidate.threadId, {
        taskId: candidate.taskId,
        threadId: candidate.threadId,
        title: candidate.title
    });
}

/**
 * Add projected title updates returned by one settlement phase.
 * @param updates Title updates keyed by Codex thread ID.
 * @param candidates Projected title update candidates.
 */
function addSettlementTitleUpdateList(updates: Map<string, ITitleUpdate>, candidates: unknown): void {
    if (!Array.isArray(candidates)) {
        return;
    }
    for (const candidate of candidates) {
        addSettlementTitleUpdate(updates, candidate);
    }
}

/**
 * Collect only titles whose projection may have changed during settlement.
 * @param processed Processed event batch.
 * @param completions Approval completion results.
 * @param activation Shared activation result.
 * @param isolatedActivations Isolated activation results.
 */
function collectSettlementTitleUpdates(processed: Record<string, unknown>, completions: IApprovalResult[], activation: IActivationResult | null, isolatedActivations: IActivationResult[]): ITitleUpdate[] {
    const updates = new Map<string, ITitleUpdate>();
    const results = Array.isArray(processed.results) ? processed.results : [];
    for (const result of results) {
        if (result && typeof result === "object") {
            const eventResult = result as Record<string, unknown>;
            if (typeof eventResult.action === "string" && TITLE_CHANGING_EVENT_ACTIONS.has(eventResult.action)) {
                addSettlementTitleUpdate(updates, eventResult.task);
            }
            addSettlementTitleUpdateList(updates, eventResult.titleUpdates);
        }
    }
    for (const completion of completions) {
        addSettlementTitleUpdate(updates, completion.task);
        addSettlementTitleUpdateList(updates, completion.titleUpdates);
    }
    if (activation) {
        addSettlementTitleUpdate(updates, activation.task);
        addSettlementTitleUpdateList(updates, activation.titleUpdates);
    }
    for (const isolatedActivation of isolatedActivations) {
        addSettlementTitleUpdate(updates, isolatedActivation.task);
        addSettlementTitleUpdateList(updates, isolatedActivation.titleUpdates);
    }
    return Array.from(updates.values());
}

/**
 * Process pending events, complete an approved task, and activate the next eligible task.
 * @param options Project and optional state-root settings.
 */
function settleProject(options: IControlRoomOptions): Record<string, unknown> {
    const processed = processPendingEvents(options);
    const isolatedCancellations = cleanupCanceledIsolatedTasks(options);
    let status = getStatus(options);
    if (status.commitTaskId) {
        const queue = getQueue(options);
        const activeQueue = queue.queue as Record<string, unknown>[];
        return {
            settled: false,
            autopilot: queue.autopilot,
            progress: queue.progress,
            reason: "COMMIT_RECOVERY_REQUIRED",
            commitTaskId: status.commitTaskId,
            controlRoomTitle: titleForControlRoom(),
            processed,
            completion: null,
            activation: null,
            queue: activeQueue,
            completions: [],
            isolatedActivations: [],
            isolatedCancellations,
            pendingActivations: getPendingActivations(options),
            titleUpdates: collectSettlementTitleUpdates(processed, [], null, [])
        };
    }
    const completions: IApprovalResult[] = [];
    while (!status.commitTaskId) {
        const activeQueue = getQueue(options).queue as Record<string, unknown>[];
        const approvedTasks = activeQueue.filter((task) => task.state === "APPROVED");
        if (approvedTasks.length === 0) {
            break;
        }
        completions.push(commitApprovedTask(options, String(approvedTasks[0].taskId)));
        status = getStatus(options);
    }
    const isolatedActivations: IActivationResult[] = [];
    for (const requestedTaskId of readEligibleIsolatedTaskIds(options)) {
        isolatedActivations.push(activateIsolatedTask(options, requestedTaskId));
    }
    let activation: IActivationResult;
    if (status.commitTaskId) {
        activation = { activated: false, controlRoomTitle: titleForControlRoom(), reason: "COMMIT_RECOVERY_REQUIRED" };
    } else {
        activation = activateNextTask(options);
    }
    const queue = getQueue(options);
    const activeQueue = queue.queue as Record<string, unknown>[];
    const reviewTasks = activeQueue.filter((task) => task.state === "RUNNING" || task.state === "REVIEW");
    const reviewPackets = reviewTasks.map((task) => getReviewPacket(options, String(task.taskId)));
    return {
        settled: !status.commitTaskId,
        autopilot: queue.autopilot,
        progress: queue.progress,
        controlRoomTitle: titleForControlRoom(),
        processed,
        completion: completions[0] || null,
        completions,
        activation,
        isolatedActivations,
        isolatedCancellations,
        pendingActivations: getPendingActivations(options),
        queue: activeQueue,
        reviewPacket: reviewPackets[0] || null,
        reviewPackets,
        titleUpdates: collectSettlementTitleUpdates(processed, completions, activation, isolatedActivations)
    };
}

/**
 * Persist the handoff in the same transaction that reserves its workspace.
 * @param store Open project store with an active activation transaction.
 * @param brief Exact execution brief to deliver.
 */
function persistActivation(store: IStore, brief: IExecutionBrief): void {
    const timestamp = currentTimestamp();
    store.database.prepare("INSERT INTO activation_deliveries (activation_key, task_id, brief_json, state, created_at, updated_at) VALUES (?, ?, ?, 'PENDING', ?, ?)").run(brief.activationKey, brief.taskId, JSON.stringify(brief), timestamp, timestamp);
}

/**
 * Read unconfirmed handoffs without replaying or claiming a delivery.
 * @param options Project and optional state-root settings.
 */
function getPendingActivations(options: IControlRoomOptions): IActivationDelivery[] {
    const store = openReadStore(options);
    if (!("database" in store)) {
        return [];
    }
    try {
        const rows = store.database.prepare("SELECT delivery.* FROM activation_deliveries AS delivery JOIN tasks AS task ON task.task_id = delivery.task_id WHERE delivery.state IN ('PENDING', 'CLAIMED') AND task.state = 'RUNNING' ORDER BY delivery.created_at, delivery.activation_key").all() as unknown as IDeliveryRow[];
        return rows.map((row) => ({ activationKey: row.activation_key, state: row.state as "PENDING" | "CLAIMED", claimToken: row.claim_token, executionBrief: JSON.parse(row.brief_json) as IExecutionBrief }));
    } finally {
        store.database.close();
    }
}

/**
 * Claim one handoff so concurrent settlements cannot both send it.
 * @param options Project and optional state-root settings.
 * @param activationKey Persisted activation identifier.
 * @param retryUserRequestId New direct authorization for retrying an uncertain delivery.
 */
function claimActivation(options: IControlRoomOptions, activationKey: string, retryUserRequestId?: string): { claimed: boolean; reason?: string; claimToken?: string; executionBrief?: IExecutionBrief } {
    const validKey = validateEventKey(activationKey);
    const retryRequest = retryUserRequestId === undefined ? null : validateCompactText(retryUserRequestId, "Direct retry request ID", 200, true)!;
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        requireProject(store);
        const row = store.database.prepare("SELECT * FROM activation_deliveries WHERE activation_key = ?").get(validKey) as IDeliveryRow | undefined;
        assertCondition(row, `Unknown activation: ${validKey}`);
        if (row.state === "DELIVERED" || row.state === "CANCELED" || (row.state === "CLAIMED" && (!retryRequest || retryRequest === row.retry_request_id))) {
            commitTransaction(store.database);
            return { claimed: false, reason: row.state === "CLAIMED" ? "DELIVERY_UNCONFIRMED" : row.state };
        }
        const task = requireTask(store, row.task_id);
        assertCondition(task.state === "RUNNING" && task.branch_name, `${task.task_id} no longer owns this activation.`);
        const brief = JSON.parse(row.brief_json) as IExecutionBrief;
        const workspacePath = resolveTaskWorkspace(store, task);
        assertCondition(brief.activationKey === validKey && brief.taskId === task.task_id && brief.threadId === task.thread_id && brief.projectRoot === store.projectRoot && brief.workspacePath === workspacePath && brief.workerBranch === task.branch_name, "Activation target or workspace no longer matches the stored brief.");
        // The shared workspace resolver intentionally accepts base-branch approvals; delivery must use the worker checkout.
        const currentBranch = requireGit(workspacePath, ["branch", "--show-current"], "Verify activation checkout");
        assertCondition(currentBranch === task.branch_name, `Activation checkout changed for ${task.task_id}.`);
        const claimToken = nodeCrypto.randomUUID();
        store.database.prepare("UPDATE activation_deliveries SET state = 'CLAIMED', claim_token = ?, retry_request_id = ?, updated_at = ? WHERE activation_key = ?").run(claimToken, retryRequest, currentTimestamp(), validKey);
        commitTransaction(store.database);
        return { claimed: true, claimToken, executionBrief: brief };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Confirm a successful send or a verified direct start against its exact claim.
 * @param options Project and optional state-root settings.
 * @param activationKey Persisted activation identifier.
 * @param claimToken Token returned by the successful claim.
 * @param receipt App message ID or direct-start request reference.
 */
function confirmActivation(options: IControlRoomOptions, activationKey: string, claimToken: string, receipt: string): { confirmed: boolean; alreadyConfirmed?: boolean; reason?: string } {
    const validKey = validateEventKey(activationKey);
    const validToken = validateEventKey(claimToken);
    const validReceipt = validateCompactText(receipt, "Delivery receipt", 500, true)!;
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        requireProject(store);
        const row = store.database.prepare("SELECT * FROM activation_deliveries WHERE activation_key = ?").get(validKey) as IDeliveryRow | undefined;
        assertCondition(row, `Unknown activation: ${validKey}`);
        assertCondition(row.claim_token === validToken, "Activation claim changed; a stale confirmation cannot acknowledge another delivery attempt.");
        if (row.state === "CANCELED") {
            commitTransaction(store.database);
            return { confirmed: false, reason: "ACTIVATION_SUPERSEDED" };
        }
        if (row.state === "DELIVERED") {
            assertCondition(row.receipt === validReceipt, "Activation was already confirmed with another receipt.");
            commitTransaction(store.database);
            return { confirmed: true, alreadyConfirmed: true };
        }
        assertCondition(row.state === "CLAIMED", "Activation must be claimed before confirmation.");
        assertCondition(requireTask(store, row.task_id).state === "RUNNING", "Activation is no longer running.");
        store.database.prepare("UPDATE activation_deliveries SET state = 'DELIVERED', receipt = ?, updated_at = ? WHERE activation_key = ?").run(validReceipt, currentTimestamp(), validKey);
        commitTransaction(store.database);
        return { confirmed: true };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Diagnose runtime, repository, queue, cleanup and delivery problems without repairs.
 * @param options Project and optional state-root settings.
 * @param taskId Optional task whose execution blockers should be explained.
 */
function doctorProject(options: IControlRoomOptions, taskId?: string): import("./control-room-types.ts").IDoctorResult {
    const checks: import("./control-room-types.ts").IDoctorCheck[] = [];
    let store: IStore | undefined;
    let projectRoot = path.resolve(options.projectRoot);
    try {
        const [major, minor] = process.versions.node.split(".").map(Number);
        const supportedNode = major > 22 || (major === 22 && minor >= 18);
        checks.push({ code: "NODE_VERSION", level: supportedNode ? "ok" : "error", message: `Node.js ${process.versions.node}; requires 22.18 or newer.` });
        projectRoot = canonicalizeProjectRoot(options.projectRoot);
        const gitVersion = requireGit(projectRoot, ["--version"], "Inspect Git version");
        const mergeHelp = runGit(projectRoot, ["merge-tree", "-h"]);
        const supportsMergeTree = `${mergeHelp.stdout}\n${mergeHelp.stderr}`.includes("--write-tree");
        checks.push({ code: "GIT_CAPABILITIES", level: supportsMergeTree ? "ok" : "error", message: `${gitVersion}; merge-tree --write-tree ${supportsMergeTree ? "available" : "unavailable"}.`, ...(!supportsMergeTree ? { nextAction: "Install Git with merge-tree --write-tree support (2.38 or newer)." } : {}) });
        const opened = openReadStore(options);
        if (!("database" in opened)) {
            checks.push({ code: opened.reason, level: "warning", message: opened.reason === "NOT_INITIALIZED" ? "ControlRoom is not initialized for this project." : `State schema ${opened.schemaVersion} requires migration to ${opened.expectedSchemaVersion}.`, nextAction: "Run $control-room init to initialize or migrate the project." });
            return { healthy: false, projectRoot, checks };
        }
        store = opened;
        const project = requireProject(store);
        const integrity = store.database.prepare("PRAGMA quick_check").all();
        const foreignKeys = store.database.prepare("PRAGMA foreign_key_check").all();
        checks.push({ code: "STATE_INTEGRITY", level: integrity.every((row) => row.quick_check === "ok") && foreignKeys.length === 0 ? "ok" : "error", message: integrity.every((row) => row.quick_check === "ok") && foreignKeys.length === 0 ? "SQLite integrity and foreign keys are valid." : "SQLite integrity or foreign key checks failed; preserve the database before recovery." });
        const baseCommit = resolveLocalBranchHeadIfExists(projectRoot, project.base_branch);
        const unborn = resolveCurrentHeadIfExists(projectRoot) === null;
        checks.push({ code: "BASE_BRANCH", level: baseCommit || unborn ? "ok" : "error", message: baseCommit ? `Base branch ${project.base_branch} exists.` : unborn ? `Base branch ${project.base_branch} is unborn; isolated execution needs a first commit.` : `Base branch ${project.base_branch} is missing.`, ...(!baseCommit && !unborn ? { nextAction: "Restore the configured base branch after inspecting Git history." } : {}) });
        const agentsPath = resolveProjectAgentsPath(projectRoot);
        const routing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
        const routingPresent = routing.includes("<!-- control-room:start -->") && routing.includes("<!-- control-room:end -->");
        checks.push({ code: "PROJECT_ROUTING", level: routingPresent ? "ok" : "warning", message: routingPresent ? "Managed project routing is present." : "Managed project routing is missing.", ...(!routingPresent ? { nextAction: "Run $control-room init to repair project routing." } : {}) });
        const ignored = runGit(projectRoot, ["check-ignore", "--quiet", "--no-index", "--", ".control-room/worktrees/T9999"]).status === 0;
        checks.push({ code: "WORKTREE_IGNORE", level: ignored ? "ok" : "warning", message: ignored ? "ControlRoom worktrees are ignored by Git." : "ControlRoom worktrees are not ignored by Git.", ...(!ignored ? { nextAction: "Run $control-room init to repair .gitignore." } : {}) });
        if (project.integration_task_id) {
            checks.push({ code: "COMMIT_RECOVERY_REQUIRED", level: "warning", taskId: project.integration_task_id, message: `Approval or cleanup lease held since ${project.integration_started_at}.`, nextAction: `Verify that the prior process has ended before running recover-commit for ${project.integration_task_id}.` });
        }
        const tasks = taskId ? [requireTask(store, taskId)] : store.database.prepare("SELECT * FROM tasks WHERE state NOT IN ('DONE', 'CANCELED') ORDER BY task_number").all() as unknown as ITaskRow[];
        const shared = store.database.prepare("SELECT task_id FROM tasks WHERE workspace_mode = 'shared' AND state IN ('RUNNING', 'REVIEW', 'APPROVED')").all() as Array<{ task_id: string }>;
        if (shared.length > 1) {
            checks.push({ code: "MULTIPLE_SHARED_WORKERS", level: "error", message: "More than one task owns the shared checkout.", nextAction: "Inspect task state and workspace ownership before continuing." });
        }
        const currentBranch = requireGit(projectRoot, ["branch", "--show-current"], "Inspect shared checkout");
        if (shared.length === 0 && currentBranch !== project.base_branch) {
            checks.push({ code: "SHARED_CHECKOUT_UNASSIGNED", level: "warning", message: `The shared checkout is on ${currentBranch || "detached HEAD"} without an active shared owner.`, nextAction: "Inspect pending activation or cancellation state and preserve local work before restoring the base checkout." });
        }
        for (const task of tasks) {
            const unmet = store.database.prepare("SELECT prerequisite.task_id, prerequisite.state FROM dependencies JOIN tasks AS prerequisite ON prerequisite.task_id = dependencies.depends_on_id WHERE dependencies.task_id = ? AND prerequisite.state <> 'DONE'").all(task.task_id) as Array<{ task_id: string; state: TaskState }>;
            if (unmet.length > 0) {
                checks.push({ code: "DEPENDENCIES_PENDING", level: "warning", taskId: task.task_id, message: unmet.map((dependency) => `${dependency.task_id}: ${dependency.state}`).join(", "), nextAction: "Complete the prerequisites, or explicitly remove an obsolete dependency." });
            }
            if (task.state === "QUEUED" && task.workspace_mode === "shared" && shared.length > 0) {
                checks.push({ code: "SHARED_CHECKOUT_BUSY", level: "warning", taskId: task.task_id, message: `Waiting for ${shared[0].task_id} to release the shared checkout.`, nextAction: "Complete or pause the active task through its normal approval flow." });
            }
            if (task.state === "BLOCKED") {
                const blocked = store.database.prepare("SELECT payload_json FROM events WHERE task_id = ? AND kind = 'BLOCKED_REPORTED' AND json_extract(result_json, '$.action') = 'BLOCKED' ORDER BY sequence DESC LIMIT 1").get(task.task_id) as { payload_json: string } | undefined;
                const reason = blocked ? (JSON.parse(blocked.payload_json) as IEventPayload).reason : null;
                checks.push({ code: "TASK_BLOCKED", level: "warning", taskId: task.task_id, message: reason || `Task is blocked from ${task.blocked_from_state}.`, nextAction: "Inspect the preserved workspace and the latest task failure, then Resume when resolved." });
            }
            if (task.state === "RUNNING" || task.state === "REVIEW" || task.state === "APPROVED") {
                if (task.cleanup_pending) {
                    checks.push({ code: "CLEANUP_PENDING", level: "warning", taskId: task.task_id, message: "Approved no-change cleanup has not been finalized.", nextAction: "After confirming the previous process ended, run recover-commit." });
                } else {
                    try {
                        const workspace = resolveTaskWorkspace(store, task);
                        const branch = requireGit(workspace, ["branch", "--show-current"], "Inspect task checkout");
                        assertCondition(branch === task.branch_name || (task.workspace_mode === "shared" && branch === project.base_branch), `Unexpected branch ${branch || "detached HEAD"}.`);
                    } catch (error) {
                        checks.push({ code: "WORKSPACE_MISMATCH", level: "error", taskId: task.task_id, message: error instanceof Error ? error.message : String(error), nextAction: "Inspect Git worktrees and the task's recorded workspace; preserve uncommitted work." });
                    }
                }
            }
        }
        for (const delivery of getPendingActivations(options)) {
            if (!taskId || delivery.executionBrief.taskId === taskId) {
                checks.push({ code: delivery.state === "PENDING" ? "ACTIVATION_PENDING" : "DELIVERY_UNCONFIRMED", level: "warning", taskId: delivery.executionBrief.taskId, activationKey: delivery.activationKey, message: delivery.state === "PENDING" ? "The activation brief has not been claimed for delivery." : "Delivery was claimed but has no receipt; it may already have reached the destination.", nextAction: delivery.state === "PENDING" ? "Verify the original start authorization, then claim and deliver this exact activation." : "Inspect the destination history and confirm a verified receipt. Retry only with new direct user authorization." });
            }
        }
        return { healthy: checks.every((check) => check.level === "ok"), projectRoot, checks };
    } catch (error) {
        checks.push({ code: "DIAGNOSTIC_FAILED", level: "error", message: error instanceof Error ? error.message : String(error), nextAction: "Resolve this diagnostic error before attempting state changes." });
        return { healthy: false, projectRoot, checks };
    } finally {
        store?.database.close();
    }
}

const api = {
    doctorProject,
    claimActivation,
    confirmActivation,
    getPendingActivations,
    activateIsolatedTask,
    activateNextTask,
    commitApprovedTask,
    excludeTask,
    getQueue,
    getReviewPacket,
    getStatus,
    initializeProject,
    installProjectRouting,
    installWorktreeIgnore,
    processPendingEvents,
    recoverCommit,
    registerTask,
    resumeTask,
    settleProject,
    setAutopilot,
    submitEvent,
    titleForControlRoom,
    titleForTask
};

module.exports = api;
export interface IControlRoomApi extends Readonly<typeof api> {}
