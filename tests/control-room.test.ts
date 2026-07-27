const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const core = require("../scripts/control-room-core.ts");

interface IFixture {
    initialCommit: string;
    repositoryRoot: string;
    stateRoot: string;
}

interface IOptions {
    projectRoot: string;
    stateRoot: string;
}

/**
 * Run a Git command in a disposable repository.
 * @param repositoryRoot Disposable Git repository root.
 * @param argumentsList Git arguments passed without a shell.
 */
function runGit(repositoryRoot: string, argumentsList: string[]): string {
    const result = childProcess.spawnSync("git", argumentsList, {
        cwd: repositoryRoot,
        encoding: "utf8",
        shell: false
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}

/**
 * Create an isolated Git repository and ControlRoom state root.
 */
function createFixture(): IFixture {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "control-room-test-"));
    const repositoryRoot = path.join(fixtureRoot, "repository");
    const stateRoot = path.join(fixtureRoot, "state");
    fs.mkdirSync(repositoryRoot);
    runGit(repositoryRoot, ["init", "-b", "main"]);
    runGit(repositoryRoot, ["config", "user.name", "Control Room Test"]);
    runGit(repositoryRoot, ["config", "user.email", "control-room@example.invalid"]);
    fs.writeFileSync(path.join(repositoryRoot, "base.txt"), "base\n");
    runGit(repositoryRoot, ["add", "base.txt"]);
    runGit(repositoryRoot, ["commit", "-m", "Initial commit"]);
    return {
        initialCommit: runGit(repositoryRoot, ["rev-parse", "HEAD"]),
        repositoryRoot,
        stateRoot
    };
}

/**
 * Initialize one fixture project with its coordinator.
 * @param fixture Disposable project fixture.
 */
function initializeFixture(fixture: IFixture): string {
    const initialized = core.initializeProject(
        { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot },
        "coordinator-thread",
        "main"
    );
    assert.equal(initialized.coordinatorTitle, "⚫️ Control Room");
    assert.equal(initialized.gitMode, "local-approval-commit");
    return initialized.databasePath;
}

/**
 * Register, queue, process, and activate one task.
 * @param options ControlRoom project options.
 * @param threadId Worker thread identifier.
 * @param semanticName Worker semantic name.
 * @param eventKey Stable enqueue event key.
 */
function activateTask(options: IOptions, threadId: string, semanticName: string, eventKey: string): Record<string, unknown> {
    const registered = core.registerTask(options, threadId, semanticName);
    core.submitEvent(options, eventKey, registered.taskId, "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    return core.activateNextTask(options);
}

/**
 * Move a running task through review and direct approval.
 * @param options ControlRoom project options.
 * @param taskId Task identifier.
 * @param keyPrefix Stable event-key prefix.
 */
function approveTask(options: IOptions, taskId: string, keyPrefix: string): void {
    core.submitEvent(options, `${keyPrefix}-review`, taskId, "REVIEW_REQUESTED", { summary: "Ready" });
    core.processPendingEvents(options);
    core.submitEvent(options, `${keyPrefix}-approve`, taskId, "APPROVAL_REQUESTED", { userRequestId: `${keyPrefix}-user-message` });
    core.processPendingEvents(options);
}

test("allocates four-digit task IDs and preserves IDs across registration retries", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const first = core.registerTask(options, "thread-one", "Build queue");
    const retry = core.registerTask(options, "thread-one", "Build queue");
    const second = core.registerTask(options, "thread-two", "Add review");
    assert.equal(first.taskId, "T0001");
    assert.equal(first.title, "⚪️ T0001 - Build queue");
    assert.equal(retry.taskId, "T0001");
    assert.equal(retry.created, false);
    assert.equal(second.taskId, "T0002");
    assert.throws(
        () => core.registerTask(options, "coordinator-thread", "Invalid worker"),
        /coordinator thread cannot be registered/
    );
});

test("uses the failure icon for blocked and canceled task titles", () => {
    const baseTask = {
        task_id: "T0001",
        semantic_name: "Handle failure"
    };
    assert.equal(core.titleForTask({ ...baseTask, state: "BLOCKED" }), "❌ T0001 - Handle failure");
    assert.equal(core.titleForTask({ ...baseTask, state: "CANCELED" }), "❌ T0001 - Handle failure");
});

test("rejects linked Git worktrees", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const linkedWorktree = path.join(path.dirname(fixture.repositoryRoot), "linked-worktree");
    runGit(fixture.repositoryRoot, ["worktree", "add", "--detach", linkedWorktree, "main"]);
    assert.throws(
        () => core.registerTask(
            { projectRoot: linkedWorktree, stateRoot: fixture.stateRoot },
            "linked-thread",
            "Linked task"
        ),
        /primary Local checkout/
    );
});

test("migrates legacy state to approval-only commits", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
        ALTER TABLE projects RENAME TO projects_current;
        CREATE TABLE projects (
            project_key TEXT PRIMARY KEY,
            project_root TEXT NOT NULL UNIQUE,
            coordinator_thread_id TEXT NOT NULL,
            base_branch TEXT NOT NULL,
            git_mode TEXT NOT NULL CHECK (git_mode = 'local-ff-only'),
            next_task_number INTEGER NOT NULL CHECK (next_task_number BETWEEN 1 AND 10000),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        INSERT INTO projects (
            project_key, project_root, coordinator_thread_id, base_branch,
            git_mode, next_task_number, created_at, updated_at
        )
        SELECT
            project_key, project_root, coordinator_thread_id, base_branch,
            'local-ff-only', next_task_number, created_at, updated_at
        FROM projects_current;
        DROP TABLE projects_current;
        ALTER TABLE tasks DROP COLUMN reviewed_commit;
        PRAGMA user_version = 1;
    `);
    legacyDatabase.close();
    const status = core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot });
    assert.equal(status.gitMode, "local-approval-commit");
    assert.equal(status.commitTaskId, null);
    const migratedDatabase = new DatabaseSync(databasePath);
    const version = migratedDatabase.prepare("PRAGMA user_version").get().user_version;
    const project = migratedDatabase.prepare("SELECT git_mode FROM projects").get();
    const taskColumns = migratedDatabase.prepare("PRAGMA table_info(tasks)").all().map((column: Record<string, unknown>) => column.name);
    migratedDatabase.close();
    assert.equal(version, 3);
    assert.equal(project.git_mode, "local-approval-commit");
    assert.ok(taskColumns.includes("reviewed_commit"));
});

test("rejects a broken state database symbolic link", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    fs.rmSync(databasePath);
    const redirectedTarget = path.join(path.dirname(fixture.stateRoot), "redirected.sqlite");
    fs.symlinkSync(redirectedTarget, databasePath);
    assert.throws(
        () => core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }),
        /cannot be a symbolic link/
    );
    assert.equal(fs.existsSync(redirectedTarget), false);
});

test("keeps enqueue event-only and orders tasks without Git anchors", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Second task");
    const branchesBeforeQueue = runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]);
    const firstRequest = core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    const firstRetry = core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", { afterTaskId: "T0001" });
    assert.equal(firstRequest.created, true);
    assert.equal(firstRetry.created, false);
    assert.equal(firstRequest.notification, "CONTROL_ROOM_WAKE");
    assert.equal(core.getStatus(options, "T0001").task.state, "PLANNING");
    core.processPendingEvents(options);
    const queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002"]);
    assert.deepEqual(queue[1].dependencies, ["T0001"]);
    assert.equal(queue[0].baseCommit, null);
    assert.equal(queue[0].branchName, null);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), branchesBeforeQueue);
});

test("activation creates the worker branch only when the task starts", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "Activation branch");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
    const activation = core.activateNextTask(options);
    assert.equal(activation.task.state, "RUNNING");
    assert.equal(activation.task.baseCommit, fixture.initialCommit);
    assert.equal(activation.task.branchName, "control-room/T0001");
    assert.equal(activation.executionBrief.workerBranch, "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "control-room/T0001\nmain");
});

test("review and approval do not create a commit", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Commit on approval", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "reviewed\n");
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { summary: "Ready" });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
});

test("approved commit includes changes made after review", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Flexible review", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "before review\n");
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { summary: "Initial review" });
    core.processPendingEvents(options);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "after review\n");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "additional.txt"), "added during review\n");
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    const committed = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.task.state, "DONE");
    assert.equal(committed.task.title, "🟢 T0001 - Flexible review");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:change.txt"]), "after review");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:additional.txt"]), "added during review");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "T0001 - Flexible review");
    assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain"]), "");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
    assert.equal(committed.merged, true);
    assert.equal(committed.branchDeleted, true);
});

test("approval commits directly when the task is already on the base branch", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Direct base commit", "enqueue-1");
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change on main\n");
    approveTask(options, "T0001", "first");
    const committed = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.task.state, "DONE");
    assert.equal(committed.committed, true);
    assert.equal(committed.merged, false);
    assert.equal(committed.branchDeleted, false);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "T0001 - Direct base commit");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:change.txt"]), "change on main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "control-room/T0001\nmain");
});

test("approval only dequeues a clean task after a user-created commit", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Accept manual commit", "enqueue-1");
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "manual.txt"), "committed by user\n");
    runGit(fixture.repositoryRoot, ["add", "manual.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "User-created commit"]);
    const userCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    approveTask(options, "T0001", "first");
    const completed = core.commitApprovedTask(options, "T0001");
    assert.equal(completed.task.state, "DONE");
    assert.equal(completed.committed, false);
    assert.equal(completed.dequeued, true);
    assert.equal(completed.noUncommittedChanges, true);
    assert.equal(completed.task.committedCommit, null);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), userCommit);
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "User-created commit");
    assert.equal(core.getQueue(options).queue.length, 0);
});

test("approval does not reject commits made outside ControlRoom", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Allow external history", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "external.txt"), "external commit\n");
    runGit(fixture.repositoryRoot, ["add", "external.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "External commit"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "approved.txt"), "approval commit\n");
    approveTask(options, "T0001", "first");
    const committed = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.task.state, "DONE");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--count", "HEAD"]), "3");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "T0001 - Allow external history");
});

test("commit-approved is idempotent after completion", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Idempotent commit", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change\n");
    approveTask(options, "T0001", "first");
    const committed = core.commitApprovedTask(options, "T0001");
    const committedHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const retry = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.committed, true);
    assert.equal(retry.alreadyCommitted, true);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), committedHead);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--count", "HEAD"]), "2");
});

test("dependencies activate against the latest shared base after approval commits", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Dependent task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", { afterTaskId: "T0001" });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "first.txt"), "first\n");
    approveTask(options, "T0001", "first");
    const firstCommit = core.commitApprovedTask(options, "T0001").task.committedCommit;
    const secondActivation = core.activateNextTask(options);
    assert.equal(secondActivation.task.taskId, "T0002");
    assert.equal(secondActivation.task.baseCommit, firstCommit);
    assert.equal(secondActivation.task.branchName, "control-room/T0002");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0002");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "control-room/T0002\nmain");
});

test("recovery clears a lease when the approval commit did not happen", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Retry approval commit", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change\n");
    approveTask(options, "T0001", "first");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    const recovered = core.recoverCommit(options, "T0001");
    assert.equal(recovered.finalized, false);
    assert.equal(recovered.retryCommit, true);
    assert.equal(core.getStatus(options).commitTaskId, null);
    assert.equal(core.commitApprovedTask(options, "T0001").task.state, "DONE");
});

test("recovery finalizes a commit created before SQLite completion", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Recover commit", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change\n");
    approveTask(options, "T0001", "first");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "T0001 - Recover commit"]);
    const recovered = core.recoverCommit(options, "T0001");
    assert.equal(recovered.finalized, true);
    assert.equal(recovered.task.state, "DONE");
    assert.equal(recovered.task.committedCommit, runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]));
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
});

test("recovery recognizes a direct approval commit on the base branch", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Recover base commit", "enqueue-1");
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change\n");
    approveTask(options, "T0001", "first");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "T0001 - Recover base commit"]);
    const recovered = core.recoverCommit(options, "T0001");
    assert.equal(recovered.finalized, true);
    assert.equal(recovered.merged, false);
    assert.equal(recovered.branchDeleted, false);
    assert.equal(recovered.task.state, "DONE");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "control-room/T0001\nmain");
});

test("recovery finalizes after the worker branch was already merged and deleted", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Recover deleted branch", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change\n");
    approveTask(options, "T0001", "first");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "T0001 - Recover deleted branch"]);
    const approvedCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    runGit(fixture.repositoryRoot, ["merge", "--ff-only", approvedCommit]);
    runGit(fixture.repositoryRoot, ["branch", "--delete", "control-room/T0001"]);
    const recovered = core.recoverCommit(options, "T0001");
    assert.equal(recovered.finalized, true);
    assert.equal(recovered.merged, true);
    assert.equal(recovered.branchDeleted, true);
    assert.equal(recovered.task.state, "DONE");
    assert.equal(recovered.task.branchName, null);
    assert.equal(recovered.task.committedCommit, approvedCommit);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
});

test("activation refuses leftover changes from a canceled active task", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "Canceled task");
    core.registerTask(options, "thread-two", "Next task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    core.activateNextTask(options);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "leftover.txt"), "leftover\n");
    core.submitEvent(options, "cancel-1", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-message" });
    core.processPendingEvents(options);
    assert.throws(() => core.activateNextTask(options), /working tree must be clean/);
});

test("join is documented as a non-terminal directive that preserves the request", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /Treat `join` as a non-terminal preamble/);
    assert.match(skillText, /continue the same turn by evaluating and fulfilling every remaining request/);
    assert.match(skillText, /registration and title synchronization must never consume, replace, summarize away, or defer the user's actual request/);
});
