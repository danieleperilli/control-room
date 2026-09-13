const { isolatedWorktreePathForTask }: import("./control-room-git.ts").IGitApi = require("./control-room-git.ts");
import type { IApprovalResult, IRecoveryResult, IControlRoomOptions, IEventPayload, IStore, IProjectRow, ITaskRow } from "./control-room-types.ts";
const { currentTimestamp, validateCommitId, validateApprovalCommitMessage }: import("./control-room-validation.ts").IValidationApi = require("./control-room-validation.ts");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;
const { runGit, requireGit, requireBranchCheckout, requireBaseCheckout, readWorkingTreeStatus, resolveCurrentHeadIfExists, resolveLocalBranchHeadIfExists, resolveLocalBranchHead, commitHasExpectedParent, commitMatchesApproval, createInitialBaseBranch, buildLinearIntegrationCommit }: import("./control-room-git.ts").IGitApi = require("./control-room-git.ts");
const { pathIsSymbolicLink, openStore, beginTransaction, commitTransaction, rollbackTransaction }: import("./control-room-storage.ts").IStorageApi = require("./control-room-storage.ts");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

const { requireProject, requireTask, readAutopilotStatus, readAutopilotBlocker, assertAutopilotReviewCurrent, titleForControlRoom, serializeTask, compactActiveQueue }: import("./control-room-state.ts").IStateApi = require("./control-room-state.ts");
const GIT_MODE = "local-approval-commit";

/**
 * Read the first meaningful commit subject accepted for a task.
 * @param store Open project store.
 * @param task Approved task whose commit subject is required.
 */
function readApprovalCommitMessage(store: IStore, task: ITaskRow): string {
    const approvalEvents = task.approval_event_key ?
        store.database.prepare(`
            SELECT payload_json, result_json
            FROM events
            WHERE task_id = ? AND event_key = ? AND kind = 'APPROVAL_REQUESTED' AND processed_at IS NOT NULL
            ORDER BY sequence
        `).all(task.task_id, task.approval_event_key) as Array<{ payload_json: string; result_json: string | null }> :
        store.database.prepare(`
            SELECT payload_json, result_json
            FROM events
            WHERE task_id = ? AND kind = 'APPROVAL_REQUESTED' AND processed_at IS NOT NULL
            ORDER BY sequence
        `).all(task.task_id) as Array<{ payload_json: string; result_json: string | null }>;
    for (const approvalEvent of approvalEvents) {
        if (!approvalEvent.result_json) {
            continue;
        }
        const approvalResult = JSON.parse(approvalEvent.result_json) as { action?: string };
        if (approvalResult.action !== "APPROVED" && approvalResult.action !== "APPROVAL_ALREADY_RECORDED") {
            continue;
        }
        const approvalPayload = JSON.parse(approvalEvent.payload_json) as IEventPayload;
        if (approvalPayload.commitMessage !== undefined) {
            return validateApprovalCommitMessage(task, approvalPayload.commitMessage);
        }
    }
    throw new Error(`${task.task_id} has no successful approval event with a commit message.`);
}

/**
 * Resolve and validate the working directory owned by one active task.
 * @param store Open project store.
 * @param task Active task row.
 */
function resolveTaskWorkspace(store: IStore, task: ITaskRow): string {
    if (task.workspace_mode === "shared") {
        return store.projectRoot;
    }
    assertCondition(task.worktree_path, `${task.task_id} has no isolated worktree path.`);
    const expectedPath = isolatedWorktreePathForTask(store.projectRoot, task.task_id);
    assertCondition(path.resolve(task.worktree_path) === expectedPath, `Stored worktree path is invalid for ${task.task_id}: ${task.worktree_path}`);
    assertCondition(!pathIsSymbolicLink(path.join(store.projectRoot, ".control-room")), `ControlRoom directory cannot be a symbolic link: ${path.join(store.projectRoot, ".control-room")}`);
    assertCondition(!pathIsSymbolicLink(path.join(store.projectRoot, ".control-room", "worktrees")), `ControlRoom worktrees directory cannot be a symbolic link: ${path.join(store.projectRoot, ".control-room", "worktrees")}`);
    assertCondition(fs.existsSync(expectedPath) && fs.statSync(expectedPath).isDirectory(), `Isolated worktree is missing for ${task.task_id}: ${expectedPath}`);
    assertCondition(!pathIsSymbolicLink(expectedPath), `Isolated worktree cannot be a symbolic link: ${expectedPath}`);
    const repositoryRoot = requireGit(expectedPath, ["rev-parse", "--show-toplevel"], `Resolve isolated repository for ${task.task_id}`);
    assertCondition(fs.realpathSync(repositoryRoot) === fs.realpathSync(expectedPath), `Isolated repository root does not match ${task.task_id}.`);
    const commonDirectory = requireGit(expectedPath, ["rev-parse", "--git-common-dir"], `Resolve isolated common Git directory for ${task.task_id}`);
    assertCondition(fs.realpathSync(path.resolve(expectedPath, commonDirectory)) === fs.realpathSync(path.join(store.projectRoot, ".git")), `Isolated worktree does not belong to ${store.projectRoot}.`);
    assertCondition(task.branch_name, `${task.task_id} has no worker branch.`);
    requireBranchCheckout(expectedPath, task.branch_name);
    return expectedPath;
}

/**
 * Remove a clean isolated worktree and delete its exact worker branch ref.
 * @param store Open project store.
 * @param task Isolated task being finalized.
 * @param workerCommit Expected worker branch commit.
 */
function removeIsolatedWorkspace(store: IStore, task: ITaskRow, workerCommit: string): void {
    assertCondition(task.workspace_mode === "isolated" && task.worktree_path && task.branch_name, `${task.task_id} has no removable isolated workspace.`);
    assertCondition(readWorkingTreeStatus(task.worktree_path).length === 0, `Cannot remove dirty isolated worktree for ${task.task_id}.`);
    assertCondition(resolveLocalBranchHead(store.projectRoot, task.branch_name) === validateCommitId(workerCommit), `Worker branch moved before cleanup for ${task.task_id}.`);
    requireGit(store.projectRoot, ["worktree", "remove", task.worktree_path], `Remove isolated worktree for ${task.task_id}`);
    requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, workerCommit], `Delete worker branch ${task.branch_name}`);
}

/**
 * Release an unchanged shared worker branch after approval.
 * @param store Open project store.
 * @param project Initialized project record.
 * @param task Approved shared task releasing its workspace.
 */
function releaseSharedWorkerBranch(store: IStore, project: IProjectRow, task: ITaskRow): boolean {
    if (task.workspace_mode !== "shared" || !task.branch_name || task.branch_name === project.base_branch) {
        return false;
    }
    const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch before releasing workspace");
    assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Cannot release ${task.task_id} while the primary checkout is on unrelated branch ${currentBranch || "detached HEAD"}.`);
    const workerCommit = resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name);
    if (!workerCommit) {
        assertCondition(task.base_commit === null && currentBranch === task.branch_name, `Worker branch ${task.branch_name} disappeared before ${task.task_id} released its workspace.`);
        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, `Cannot release dirty worker branch ${task.branch_name} for ${task.task_id}.`);
        requireGit(store.projectRoot, ["symbolic-ref", "HEAD", `refs/heads/${project.base_branch}`], `Restore unborn base branch ${project.base_branch}`);
        return true;
    }
    assertCondition(workerCommit === task.base_commit, `Worker branch ${task.branch_name} contains commits that were not integrated for ${task.task_id}.`);
    if (currentBranch === task.branch_name) {
        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, `Cannot release dirty worker branch ${task.branch_name} for ${task.task_id}.`);
        requireGit(store.projectRoot, ["checkout", project.base_branch], `Restore base branch ${project.base_branch}`);
    }
    requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, workerCommit], `Delete released worker branch ${task.branch_name}`);
    return true;
}

/**
 * Clean up one canceled isolated task only when its workspace is unchanged.
 * @param options Project and optional state-root settings.
 * @param taskId Canceled isolated task identifier.
 */
function cleanupCanceledIsolatedTask(options: IControlRoomOptions, taskId: string): Record<string, unknown> {
    const store = openStore(options);
    try {
        requireProject(store);
        const task = requireTask(store, taskId);
        assertCondition(task.state === "CANCELED" && task.workspace_mode === "isolated", `${task.task_id} is not a canceled isolated task.`);
        if (!task.worktree_path && !task.branch_name) {
            return { taskId: task.task_id, removed: false, alreadyCleaned: true };
        }
        assertCondition(task.worktree_path && task.branch_name, `${task.task_id} has incomplete isolated workspace metadata.`);
        const workspaceExists = fs.existsSync(task.worktree_path);
        const branchCommit = resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name);
        if (!workspaceExists && !branchCommit) {
            beginTransaction(store.database);
            store.database.prepare("UPDATE tasks SET branch_name = NULL, worktree_path = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
            commitTransaction(store.database);
            return { taskId: task.task_id, removed: true, recoveredMetadata: true };
        }
        if (!workspaceExists && branchCommit === task.base_commit) {
            requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, branchCommit!], `Complete canceled branch cleanup for ${task.task_id}`);
            beginTransaction(store.database);
            store.database.prepare("UPDATE tasks SET branch_name = NULL, worktree_path = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
            commitTransaction(store.database);
            return { taskId: task.task_id, removed: true, recoveredMetadata: true };
        }
        if (!workspaceExists || !branchCommit) {
            return { taskId: task.task_id, removed: false, preserved: true, reason: "INCOMPLETE_WORKSPACE", worktreePath: task.worktree_path, branchName: task.branch_name };
        }
        const workspacePath = resolveTaskWorkspace(store, task);
        if (readWorkingTreeStatus(workspacePath).length > 0) {
            return { taskId: task.task_id, removed: false, preserved: true, reason: "DIRTY_WORKSPACE", worktreePath: workspacePath, branchName: task.branch_name };
        }
        if (branchCommit !== task.base_commit) {
            return { taskId: task.task_id, removed: false, preserved: true, reason: "TASK_COMMITS_PRESENT", worktreePath: workspacePath, branchName: task.branch_name };
        }
        removeIsolatedWorkspace(store, task, branchCommit);
        beginTransaction(store.database);
        const change = store.database.prepare("UPDATE tasks SET branch_name = NULL, worktree_path = NULL, updated_at = ? WHERE task_id = ? AND state = 'CANCELED'").run(currentTimestamp(), task.task_id);
        assertCondition(Number(change.changes) === 1, `${task.task_id} changed state during isolated cleanup.`);
        commitTransaction(store.database);
        return { taskId: task.task_id, removed: true, recoveredMetadata: false };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Reconcile every canceled isolated workspace after event processing.
 * @param options Project and optional state-root settings.
 */
function cleanupCanceledIsolatedTasks(options: IControlRoomOptions): Record<string, unknown>[] {
    const store = openStore(options);
    let taskIds: string[];
    try {
        requireProject(store);
        const rows = store.database.prepare("SELECT task_id FROM tasks WHERE state = 'CANCELED' AND workspace_mode = 'isolated' AND (worktree_path IS NOT NULL OR branch_name IS NOT NULL) ORDER BY task_number").all() as Array<{ task_id: string }>;
        taskIds = rows.map((row) => row.task_id);
    } finally {
        store.database.close();
    }
    return taskIds.map((taskId) => cleanupCanceledIsolatedTask(options, taskId));
}

/**
 * Advance the configured base branch atomically without disturbing an active shared worker.
 * @param store Open project store.
 * @param project Initialized project row.
 * @param baseCommit Expected current base commit.
 * @param integratedCommit New linear base commit.
 */
function advanceBaseBranch(store: IStore, project: IProjectRow, baseCommit: string, integratedCommit: string): void {
    const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve primary checkout branch");
    if (currentBranch === project.base_branch) {
        assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === baseCommit, `${project.base_branch} moved before integration.`);
        requireGit(store.projectRoot, ["merge", "--ff-only", integratedCommit], `Advance ${project.base_branch}`);
        return;
    }
    const activeSharedTask = store.database.prepare("SELECT branch_name FROM tasks WHERE workspace_mode = 'shared' AND state IN ('RUNNING', 'REVIEW', 'APPROVED') LIMIT 1").get() as { branch_name: string | null } | undefined;
    assertCondition(activeSharedTask?.branch_name === currentBranch, `Cannot advance ${project.base_branch} while the primary checkout is on unrelated branch ${currentBranch || "detached HEAD"}.`);
    requireGit(store.projectRoot, ["update-ref", `refs/heads/${project.base_branch}`, integratedCommit, baseCommit], `Advance ${project.base_branch}`);
}

/**
 * Block a task after a conflict while preserving its committed worker branch and worktree.
 * @param store Open project store.
 * @param task Conflicting approved task.
 * @param approvedCommit Commit that could not be integrated.
 * @param details Git conflict details.
 */
function recordIntegrationConflict(store: IStore, task: ITaskRow, approvedCommit: string, details: string): IApprovalResult {
    beginTransaction(store.database);
    try {
        const project = requireProject(store);
        assertCondition(project.integration_task_id === task.task_id, `Commit lease for ${task.task_id} was lost.`);
        store.database.prepare(`
            UPDATE tasks
            SET state = 'BLOCKED', blocked_from_state = 'RUNNING', awaiting_user = 0,
                approved_commit = ?, integrated_commit = NULL, updated_at = ?
            WHERE task_id = ?
        `).run(approvedCommit, currentTimestamp(), task.task_id);
        store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
        const blockedTask = requireTask(store, task.task_id);
        commitTransaction(store.database);
        return {
            committed: true,
            integrated: false,
            integrationConflict: true,
            conflictDetails: details,
            controlRoomTitle: titleForControlRoom(),
            gitMode: GIT_MODE,
            task: serializeTask(blockedTask),
            instruction: "Resume the blocked task, resolve the conflict against the latest base in the preserved task workspace, then request review and approval again."
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    }
}

/**
 * Finalize a successful approved commit in persistent state.
 * @param store Open project store.
 * @param taskId Approved task identifier.
 * @param committedCommit Commit created by approval.
 * @param merged Whether approval fast-forwarded the base branch.
 * @param branchDeleted Whether approval deleted the worker branch.
 */
function finalizeApprovedCommit(store: IStore, taskId: string, committedCommit: string, merged: boolean, branchDeleted: boolean): IApprovalResult {
    beginTransaction(store.database);
    try {
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        assertCondition(project.integration_task_id === task.task_id, `Commit lease for ${task.task_id} was lost.`);
        assertCondition(task.state === "APPROVED", `Cannot finalize ${task.task_id} from ${task.state}.`);
        const finalState = task.approval_target;
        if (branchDeleted || finalState === "PAUSED") {
            store.database.prepare(`
                UPDATE tasks
                SET state = ?, branch_name = NULL, worktree_path = NULL, awaiting_user = 0,
                    integrated_commit = ?, queue_position = NULL, updated_at = ?
                WHERE task_id = ?
            `).run(finalState, committedCommit, currentTimestamp(), task.task_id);
        } else {
            store.database.prepare(`
                UPDATE tasks
                SET state = ?, awaiting_user = 0, integrated_commit = ?, queue_position = NULL, updated_at = ?
                WHERE task_id = ?
            `).run(finalState, committedCommit, currentTimestamp(), task.task_id);
        }
        store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
        const titleUpdates = compactActiveQueue(store);
        const completedTask = requireTask(store, task.task_id);
        commitTransaction(store.database);
        return { committed: true, merged, branchDeleted, approvalTarget: finalState, controlRoomTitle: titleForControlRoom(), gitMode: GIT_MODE, task: serializeTask(completedTask), titleUpdates };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    }
}

/**
 * Complete an approved task, committing dirty changes on the current task or base branch when needed.
 * @param options Project and optional state-root settings.
 * @param taskId Approved task identifier.
 */
function commitApprovedTask(options: IControlRoomOptions, taskId: string): IApprovalResult {
    const store = openStore(options);
    let leaseAcquired = false;
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        if (task.state === "DONE" || task.state === "PAUSED") {
            commitTransaction(store.database);
            return {
                committed: false,
                alreadyFinalized: true,
                alreadyCompleted: task.state === "DONE",
                alreadyCommitted: Boolean(task.integrated_commit),
                controlRoomTitle: titleForControlRoom(),
                gitMode: GIT_MODE,
                task: serializeTask(task)
            };
        }
        assertCondition(task.state === "APPROVED", `Cannot commit ${task.task_id} from ${task.state}.`);
        assertCondition(!project.integration_task_id, `Commit lease is already held by ${project.integration_task_id}; use recover-commit only after confirming the prior process ended.`);
        const approval = store.database.prepare("SELECT payload_json FROM events WHERE event_key = ?").get(task.approval_event_key) as { payload_json: string } | undefined;
        const approvalPayload = approval ? JSON.parse(approval.payload_json) as IEventPayload : null;
        if (approvalPayload?.autopilotEventKey && !task.approved_commit) {
            const autopilot = readAutopilotStatus(store);
            assertCondition(autopilot.enabled && autopilot.eventKey === approvalPayload.autopilotEventKey, "Autopilot authorization was revoked before integration.");
            const blocker = readAutopilotBlocker(store);
            assertCondition(!blocker, `Autopilot is waiting for user attention or recovery on ${blocker}.`);
            assertAutopilotReviewCurrent(store, task.task_id, approvalPayload.reviewEventKey);
        }
        const workspacePath = resolveTaskWorkspace(store, task);
        const currentHead = resolveCurrentHeadIfExists(workspacePath);
        const workingTreeStatus = readWorkingTreeStatus(workspacePath);
        if (approvalPayload?.autopilotEventKey && task.approved_commit) {
            assertCondition(workingTreeStatus.length === 0 && currentHead === task.approved_commit, "Automatic approval recovery requires unchanged committed work; preserve new changes for review.");
        }
        const currentBranch = requireGit(workspacePath, ["branch", "--show-current"], "Resolve current branch");
        const commitsOnBase = currentBranch === project.base_branch;
        assertCondition(commitsOnBase || currentBranch === task.branch_name, `Cannot commit ${task.task_id} from unrelated branch ${currentBranch || "detached HEAD"}.`);
        const workerBranchHasCommits = currentBranch === task.branch_name && currentHead !== task.base_commit;
        if (workingTreeStatus.length === 0 && !task.approved_commit && !workerBranchHasCommits) {
            const timestamp = currentTimestamp();
            store.database.prepare("UPDATE tasks SET cleanup_pending = 1, reviewed_commit = ?, updated_at = ? WHERE task_id = ?").run(currentHead, timestamp, task.task_id);
            store.database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?, updated_at = ? WHERE project_key = ?").run(task.task_id, timestamp, timestamp, store.projectKey);
            commitTransaction(store.database);
            leaseAcquired = true;
            return finalizeUnchangedApproval(store, task.task_id);
        }
        const commitMessage = readApprovalCommitMessage(store, task);
        const timestamp = currentTimestamp();
        store.database.prepare("UPDATE tasks SET reviewed_commit = ?, updated_at = ? WHERE task_id = ?").run(currentHead, timestamp, task.task_id);
        store.database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?, updated_at = ? WHERE project_key = ?").run(task.task_id, timestamp, timestamp, store.projectKey);
        commitTransaction(store.database);
        leaseAcquired = true;

        let committedCommit = task.approved_commit;
        if (workingTreeStatus.length > 0) {
            requireGit(workspacePath, ["add", "-A", "--", "."], "Stage approved changes");
            const stagedDifference = currentHead ? runGit(workspacePath, ["diff", "--cached", "--quiet", "HEAD", "--"]) : runGit(workspacePath, ["diff", "--cached", "--quiet", "--"]);
            assertCondition(stagedDifference.status === 1, stagedDifference.status === 0 ? "Approval produced no staged changes." : `Inspect staged changes failed: ${stagedDifference.stderr || stagedDifference.stdout}`);
            requireGit(workspacePath, ["commit", "--message", commitMessage], "Commit approved changes");
            committedCommit = validateCommitId(requireGit(workspacePath, ["rev-parse", "HEAD"], "Resolve approved commit"));
            assertCondition(commitHasExpectedParent(workspacePath, committedCommit, currentHead), currentHead ? `Approved commit does not have expected parent ${currentHead}.` : "Approved initial commit is not a root commit.");
        } else if (workerBranchHasCommits) {
            committedCommit = currentHead;
        }
        assertCondition(committedCommit, `${task.task_id} has no approved commit to integrate.`);
        beginTransaction(store.database);
        store.database.prepare("UPDATE tasks SET approved_commit = ?, updated_at = ? WHERE task_id = ?").run(committedCommit, currentTimestamp(), task.task_id);
        commitTransaction(store.database);
        if (commitsOnBase) {
            const branchDeleted = task.approval_target === "PAUSED" ? releaseSharedWorkerBranch(store, project, task) : false;
            return finalizeApprovedCommit(store, task.task_id, committedCommit, false, branchDeleted);
        }
        assertCondition(task.branch_name, `${task.task_id} has no worker branch.`);
        const currentBaseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        if (!currentBaseCommit) {
            assertCondition(task.workspace_mode === "shared", "Isolated execution requires an existing base commit.");
            createInitialBaseBranch(store.projectRoot, project.base_branch, committedCommit);
            requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out initial base branch ${project.base_branch}`);
            assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === committedCommit, `${project.base_branch} did not reach initial approved commit ${committedCommit}.`);
            requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, committedCommit], `Delete worker branch ${task.branch_name}`);
            return finalizeApprovedCommit(store, task.task_id, committedCommit, true, true);
        }
        const integration = buildLinearIntegrationCommit(store.projectRoot, currentBaseCommit, committedCommit, commitMessage);
        if (!integration.integrated) {
            return recordIntegrationConflict(store, requireTask(store, task.task_id), committedCommit, integration.details);
        }
        const integratedCommit = validateCommitId(integration.commitId);
        beginTransaction(store.database);
        store.database.prepare("UPDATE tasks SET integrated_commit = ?, updated_at = ? WHERE task_id = ?").run(integratedCommit, currentTimestamp(), task.task_id);
        commitTransaction(store.database);
        advanceBaseBranch(store, project, currentBaseCommit, integratedCommit);
        if (task.workspace_mode === "isolated") {
            removeIsolatedWorkspace(store, task, committedCommit);
        } else {
            requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out base branch ${project.base_branch}`);
            requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, committedCommit], `Delete worker branch ${task.branch_name}`);
        }
        return finalizeApprovedCommit(store, task.task_id, integratedCommit, true, true);
    } catch (error) {
        rollbackTransaction(store.database);
        const message = error instanceof Error ? error.message : String(error);
        if (leaseAcquired) {
            throw new Error(`${message} The commit lease remains active; run recover-commit only after confirming this process ended.`);
        }
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Reconcile approved cleanup even when Git completed before SQLite did.
 * @param store Open project store.
 * @param taskId Task with a persisted no-change cleanup intent.
 */
function finalizeUnchangedApproval(store: IStore, taskId: string): IApprovalResult {
    const project = requireProject(store);
    const task = requireTask(store, taskId);
    assertCondition(task.state === "APPROVED" && task.cleanup_pending === 1 && project.integration_task_id === task.task_id, `${task.task_id} has no pending approved cleanup.`);
    let releaseWorkspace = task.workspace_mode === "isolated" || task.approval_target === "PAUSED";
    if (task.workspace_mode === "isolated") {
        assertCondition(task.branch_name && task.worktree_path && task.reviewed_commit === task.base_commit && task.base_commit, `${task.task_id} has invalid cleanup anchors.`);
        const expectedPath = isolatedWorktreePathForTask(store.projectRoot, task.task_id);
        assertCondition(task.worktree_path === expectedPath && !pathIsSymbolicLink(expectedPath), `${task.task_id} has an unsafe cleanup path.`);
        const workerCommit = resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name);
        assertCondition(workerCommit === null || workerCommit === task.base_commit, `Worker branch moved before cleanup for ${task.task_id}.`);
        if (fs.existsSync(expectedPath)) {
            resolveTaskWorkspace(store, task);
            removeIsolatedWorkspace(store, task, task.base_commit);
        } else if (workerCommit) {
            requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, workerCommit], `Complete approved cleanup for ${task.task_id}`);
        }
    } else {
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve cleanup checkout");
        assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Cannot clean up ${task.task_id} from unrelated branch ${currentBranch || "detached HEAD"}.`);
        releaseWorkspace ||= currentBranch !== project.base_branch;
        const workerCommit = task.branch_name ? resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name) : null;
        if (workerCommit || currentBranch === task.branch_name) {
            if (releaseWorkspace) {
                releaseSharedWorkerBranch(store, project, task);
            }
        } else {
            releaseWorkspace = true;
        }
    }
    beginTransaction(store.database);
    try {
        assertCondition(requireProject(store).integration_task_id === task.task_id, `Commit lease for ${task.task_id} changed during cleanup.`);
        store.database.prepare("UPDATE tasks SET state = ?, cleanup_pending = 0, branch_name = CASE WHEN ? THEN NULL ELSE branch_name END, worktree_path = NULL, awaiting_user = 0, queue_position = NULL, updated_at = ? WHERE task_id = ?").run(task.approval_target, Number(releaseWorkspace), currentTimestamp(), task.task_id);
        store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
        const titleUpdates = compactActiveQueue(store);
        const completedTask = requireTask(store, task.task_id);
        commitTransaction(store.database);
        return { committed: false, dequeued: true, noUncommittedChanges: true, approvalTarget: task.approval_target, controlRoomTitle: titleForControlRoom(), gitMode: GIT_MODE, task: serializeTask(completedTask), titleUpdates };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    }
}

/**
 * Release an interrupted lease without retrying an automatic approval that was revoked.
 * @param store Open project store inside the recovery transaction.
 * @param task Task whose approved commit was not created.
 */
function resetUncommittedApproval(store: IStore, task: ITaskRow): IRecoveryResult {
    const approval = store.database.prepare("SELECT payload_json FROM events WHERE event_key = ?").get(task.approval_event_key) as { payload_json: string } | undefined;
    const authorizationKey = approval ? (JSON.parse(approval.payload_json) as IEventPayload).autopilotEventKey : undefined;
    const autopilot = readAutopilotStatus(store);
    const revoked = Boolean(authorizationKey && (!autopilot.enabled || autopilot.eventKey !== authorizationKey));
    store.database.prepare("UPDATE tasks SET state = ?, approval_event_key = ?, reviewed_commit = NULL, approved_commit = NULL, integrated_commit = NULL, updated_at = ? WHERE task_id = ?").run(revoked ? "REVIEW" : "APPROVED", revoked ? null : task.approval_event_key, currentTimestamp(), task.task_id);
    store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
    const refreshedTask = serializeTask(requireTask(store, task.task_id));
    return { recovered: true, finalized: false, retryCommit: !revoked, controlRoomTitle: titleForControlRoom(), task: refreshedTask, titleUpdates: revoked ? [{ taskId: task.task_id, threadId: task.thread_id, title: refreshedTask.title }] : [] };
}

/**
 * Recover a commit lease after confirming the previous commit process ended.
 * @param options Project and optional state-root settings.
 * @param taskId Task holding the stale commit lease.
 */
function recoverCommit(options: IControlRoomOptions, taskId: string): IRecoveryResult {
    const store = openStore(options);
    try {
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        if (task.state === "DONE" || task.state === "PAUSED") {
            return {
                recovered: false,
                alreadyFinalized: true,
                alreadyCompleted: task.state === "DONE",
                alreadyCommitted: Boolean(task.integrated_commit),
                controlRoomTitle: titleForControlRoom(),
                task: serializeTask(task)
            };
        }
        assertCondition(project.integration_task_id === task.task_id, `${task.task_id} does not hold the commit lease.`);
        if (task.cleanup_pending) {
            return { ...finalizeUnchangedApproval(store, task.task_id), recovered: true, finalized: true };
        }
        const hasRecoverableAnchor = Boolean(task.base_commit && task.reviewed_commit) || task.base_commit === null;
        assertCondition(task.state === "APPROVED" && hasRecoverableAnchor, `${task.task_id} does not have a recoverable approval.`);
        const recordedBase = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        if (task.integrated_commit && recordedBase === task.integrated_commit) {
            assertCondition(task.branch_name && task.approved_commit, `${task.task_id} has incomplete integration anchors.`);
            const workerCommit = resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name);
            assertCondition(workerCommit === null || workerCommit === task.approved_commit, `Worker branch moved after integration for ${task.task_id}.`);
            if (task.workspace_mode === "isolated" && task.worktree_path && fs.existsSync(task.worktree_path)) {
                resolveTaskWorkspace(store, task);
                removeIsolatedWorkspace(store, task, task.approved_commit);
            } else {
                if (task.workspace_mode === "shared") {
                    const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve recovery checkout");
                    assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
                    if (currentBranch !== project.base_branch) {
                        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, `Cannot restore ${project.base_branch} with a dirty working tree.`);
                        requireGit(store.projectRoot, ["checkout", project.base_branch], `Restore integrated base ${project.base_branch}`);
                    }
                }
                if (workerCommit) {
                    requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, workerCommit], `Delete integrated worker branch ${task.branch_name}`);
                }
            }
            return { ...finalizeApprovedCommit(store, task.task_id, task.integrated_commit, true, true), recovered: true, finalized: true };
        }
        if (task.workspace_mode === "isolated") {
            assertCondition(task.branch_name && task.worktree_path, `${task.task_id} has no recoverable isolated workspace.`);
            const expectedSubject = readApprovalCommitMessage(store, task);
            const workerCommit = resolveLocalBranchHead(store.projectRoot, task.branch_name);
            const detectedApprovedCommit = task.approved_commit || (commitMatchesApproval(store.projectRoot, workerCommit, task.reviewed_commit, expectedSubject) ? workerCommit : null);
            beginTransaction(store.database);
            if (!detectedApprovedCommit) {
                assertCondition(workerCommit === task.reviewed_commit, `Git history does not contain the approved commit expected for ${task.task_id}.`);
                const recovery = resetUncommittedApproval(store, task);
                commitTransaction(store.database);
                return recovery;
            } else {
                store.database.prepare("UPDATE tasks SET approved_commit = ?, integrated_commit = NULL, updated_at = ? WHERE task_id = ?").run(detectedApprovedCommit, currentTimestamp(), task.task_id);
            }
            store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
            commitTransaction(store.database);
            const retried = commitApprovedTask(options, task.task_id);
            return { ...retried, recovered: true, finalized: retried.task.state === "DONE" || retried.task.state === "PAUSED" };
        }
        const workerBranchResult = task.branch_name ?
            runGit(store.projectRoot, ["rev-parse", "--verify", `refs/heads/${task.branch_name}^{commit}`]) :
            { status: 128, stdout: "", stderr: "" };
        assertCondition(workerBranchResult.status === 0 || workerBranchResult.status === 128, `Resolve worker branch ${String(task.branch_name)} failed: ${workerBranchResult.stderr || workerBranchResult.stdout}`);
        const workerCommit = workerBranchResult.status === 0 ? validateCommitId(workerBranchResult.stdout) : null;
        const currentBaseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        const expectedSubject = readApprovalCommitMessage(store, task);
        const workerCommitIsApproval = Boolean(workerCommit && (workerCommit === task.approved_commit || commitMatchesApproval(store.projectRoot, workerCommit, task.reviewed_commit, expectedSubject)));
        const baseCommitIsApproval = Boolean(currentBaseCommit && commitMatchesApproval(store.projectRoot, currentBaseCommit, task.reviewed_commit, expectedSubject));
        const noCommitWasCreated = task.reviewed_commit === null ?
            workerCommit === null && currentBaseCommit === null :
            workerCommit === task.reviewed_commit || currentBaseCommit === task.reviewed_commit;
        if (!workerCommitIsApproval && !baseCommitIsApproval && noCommitWasCreated) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
            beginTransaction(store.database);
            const lockedProject = requireProject(store);
            assertCondition(lockedProject.integration_task_id === task.task_id, `Commit lease for ${task.task_id} changed during recovery.`);
            const recovery = resetUncommittedApproval(store, task);
            commitTransaction(store.database);
            return recovery;
        }
        assertCondition(workerCommitIsApproval || baseCommitIsApproval, `Git history does not contain the approved commit expected for ${task.task_id}.`);
        if (baseCommitIsApproval && workerCommit !== currentBaseCommit) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            if (currentBranch !== project.base_branch) {
                assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, `Cannot restore ${project.base_branch} with a dirty working tree.`);
                requireGit(store.projectRoot, ["checkout", project.base_branch], `Restore base branch ${project.base_branch}`);
            }
            let workerBranchWasDeleted = Boolean(task.branch_name && !workerCommit);
            if (task.approval_target === "PAUSED" && task.branch_name && workerCommit) {
                workerBranchWasDeleted = releaseSharedWorkerBranch(store, project, task);
            }
            const result = finalizeApprovedCommit(store, task.task_id, currentBaseCommit!, workerBranchWasDeleted, workerBranchWasDeleted);
            return { ...result, recovered: true, finalized: true };
        }
        assertCondition(workerCommit && task.branch_name, `${task.task_id} has no recoverable worker commit.`);
        const approvedCommit = workerCommit;
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        if (!currentBaseCommit) {
            assertCondition(task.base_commit === null, `Configured base branch ${project.base_branch} disappeared after activation.`);
            assertCondition(currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
            createInitialBaseBranch(store.projectRoot, project.base_branch, approvedCommit);
            requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out initial base branch ${project.base_branch}`);
            assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === approvedCommit, `${project.base_branch} did not reach recovered initial commit ${approvedCommit}.`);
            requireGit(store.projectRoot, ["branch", "--delete", task.branch_name], `Delete recovered worker branch ${task.branch_name}`);
            const result = finalizeApprovedCommit(store, task.task_id, approvedCommit, true, true);
            return { ...result, recovered: true, finalized: true };
        }
        assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
        const integration = buildLinearIntegrationCommit(store.projectRoot, currentBaseCommit, approvedCommit, expectedSubject);
        if (!integration.integrated) {
            return { ...recordIntegrationConflict(store, task, approvedCommit, integration.details), recovered: true, finalized: false };
        }
        const integratedCommit = validateCommitId(integration.commitId);
        beginTransaction(store.database);
        store.database.prepare("UPDATE tasks SET approved_commit = ?, integrated_commit = ?, updated_at = ? WHERE task_id = ?").run(approvedCommit, integratedCommit, currentTimestamp(), task.task_id);
        commitTransaction(store.database);
        advanceBaseBranch(store, project, currentBaseCommit, integratedCommit);
        requireGit(store.projectRoot, ["checkout", project.base_branch], `Restore base branch ${project.base_branch}`);
        requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, approvedCommit], `Delete recovered worker branch ${task.branch_name}`);
        const result = finalizeApprovedCommit(store, task.task_id, integratedCommit, true, true);
        return { ...result, recovered: true, finalized: true };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

const api = { readApprovalCommitMessage, resolveTaskWorkspace, removeIsolatedWorkspace, releaseSharedWorkerBranch, cleanupCanceledIsolatedTask, cleanupCanceledIsolatedTasks, advanceBaseBranch, recordIntegrationConflict, finalizeApprovedCommit, commitApprovedTask, finalizeUnchangedApproval, recoverCommit };
module.exports = api;
export interface IIntegrationApi extends Readonly<typeof api> {}
