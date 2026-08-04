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
 * Run the deterministic ControlRoom CLI in a separate process.
 * @param argumentsList CLI command and options.
 */
function runCli(argumentsList: string[]) {
    return childProcess.spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "control-room.ts"), ...argumentsList], {
        encoding: "utf8",
        shell: false
    });
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
 * Create an isolated Git repository whose main branch has no commits.
 */
function createUnbornFixture(): IFixture {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "control-room-unborn-test-"));
    const repositoryRoot = path.join(fixtureRoot, "repository");
    const stateRoot = path.join(fixtureRoot, "state");
    fs.mkdirSync(repositoryRoot);
    runGit(repositoryRoot, ["init", "-b", "main"]);
    runGit(repositoryRoot, ["config", "user.name", "Control Room Test"]);
    runGit(repositoryRoot, ["config", "user.email", "control-room@example.invalid"]);
    return {
        initialCommit: "",
        repositoryRoot,
        stateRoot
    };
}

/**
 * Initialize one fixture project with its Control Room console.
 * @param fixture Disposable project fixture.
 */
function initializeFixture(fixture: IFixture): string {
    const initialized = core.initializeProject(
        { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot },
        "control-room-thread",
        "main"
    );
    assert.equal(initialized.controlRoomTitle, "⚫️ Control Room");
    assert.equal(initialized.gitMode, "local-approval-commit");
    return initialized.databasePath;
}

test("initializes and completes the first task in a repository without commits", () => {
    const fixture = createUnbornFixture();
    const initialized = runCli([
        "init",
        "--project-root",
        fixture.repositoryRoot,
        "--state-root",
        fixture.stateRoot,
        "--control-room-thread",
        "control-room-thread",
        "--base-branch",
        "main"
    ]);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const initializationResult = JSON.parse(initialized.stdout);
    const databasePath = initializationResult.databasePath;
    assert.equal(initializationResult.controlRoomTitle, "⚫️ Control Room");
    assert.equal(initializationResult.baseCommit, null);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    assert.equal(core.getStatus(options).baseBranch, "main");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--all", "--count"]), "0");

    fs.writeFileSync(path.join(fixture.repositoryRoot, "existing.txt"), "present before activation\n");
    core.registerTask(options, "thread-one", "Create initial project");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    const activation = core.activateNextTask(options);
    assert.equal(activation.task.baseCommit, null);
    assert.equal(activation.task.branchName, "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--all", "--count"]), "0");

    fs.writeFileSync(path.join(fixture.repositoryRoot, "created.txt"), "created while running\n");
    approveTask(options, "T0001", "first", "Initialize project files");
    const completed = core.commitApprovedTask(options, "T0001");
    assert.equal(completed.task.state, "DONE");
    assert.equal(completed.committed, true);
    assert.equal(completed.merged, true);
    assert.equal(completed.branchDeleted, true);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--all", "--count"]), "1");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "Initialize project files");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:existing.txt"]), "present before activation");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:created.txt"]), "created while running");
    assert.equal(fs.existsSync(databasePath), true);
});

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
 * @param commitMessage Meaningful English commit subject.
 */
function approveTask(options: IOptions, taskId: string, keyPrefix: string, commitMessage = "Apply approved project changes"): void {
    core.submitEvent(options, `${keyPrefix}-review`, taskId, "REVIEW_REQUESTED", { summary: "Ready" });
    core.processPendingEvents(options);
    core.submitEvent(options, `${keyPrefix}-approve`, taskId, "APPROVAL_REQUESTED", { commitMessage, userRequestId: `${keyPrefix}-user-message` });
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
        () => core.registerTask(options, "control-room-thread", "Invalid worker"),
        /Control Room task cannot be registered/
    );
});

test("returns the user command list for the created Control Room console", () => {
    const fixture = createFixture();
    const argumentsList = [
        "init",
        "--project-root",
        fixture.repositoryRoot,
        "--state-root",
        fixture.stateRoot,
        "--control-room-thread",
        "control-room-thread",
        "--base-branch",
        "main"
    ];
    const initialized = runCli(argumentsList);
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const result = JSON.parse(initialized.stdout);
    assert.equal(result.controlRoomTitle, "⚫️ Control Room");
    assert.deepEqual(result.userCommands, [
        "$control-room init",
        "$control-room join",
        "$control-room queue",
        "$control-room help",
        "Enqueue [after T0002]",
        "Move first | Move to 3 | Move before T0002 | Move after T0002",
        "Depends on T0002 | Remove dependency T0002",
        "Approve | Cancel | Status | Queue status"
    ]);
    const retry = runCli(argumentsList);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(retry.stdout).created, false);
    assert.deepEqual(JSON.parse(retry.stdout).userCommands, result.userCommands);
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /End that response with the same command list returned by CLI `help`/);
    assert.match(skillText, /Put nothing after the list/);
});

test("uses the failure icon for blocked and canceled task titles", () => {
    const baseTask = {
        task_id: "T0001",
        semantic_name: "Handle failure"
    };
    assert.equal(core.titleForTask({ ...baseTask, state: "BLOCKED" }), "❌ T0001 - Handle failure");
    assert.equal(core.titleForTask({ ...baseTask, state: "CANCELED" }), "❌ T0001 - Handle failure");
});

test("uses the review marker and red when review rework starts", () => {
    const baseTask = {
        task_id: "T0001",
        semantic_name: "Refine review"
    };
    assert.equal(core.titleForTask({ ...baseTask, state: "REVIEW" }), "💪 T0001 - Refine review");
    assert.equal(core.titleForTask({ ...baseTask, state: "RUNNING" }), "🔴 T0001 - Refine review");
});

test("derives queued position markers without storing them in the semantic name", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const registered = core.registerTask(options, "thread-one", "⭕️ ① Build queue");
    assert.equal(registered.semanticName, "Build queue");
    assert.equal(core.titleForTask({ task_id: "T0001", semantic_name: "Build queue", state: "QUEUED", queue_position: 1 }), "⭕️ ① T0001 - Build queue");
    assert.equal(core.titleForTask({ task_id: "T0009", semantic_name: "Ninth task", state: "QUEUED", queue_position: 9 }), "⭕️ ⑨ T0009 - Ninth task");
    assert.equal(core.titleForTask({ task_id: "T0010", semantic_name: "Tenth task", state: "QUEUED", queue_position: 10 }), "⭕️ ①⓪ T0010 - Tenth task");
    assert.equal(core.titleForTask({ task_id: "T0105", semantic_name: "One hundred fifth", state: "QUEUED", queue_position: 105 }), "⭕️ ①⓪⑤ T0105 - One hundred fifth");
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
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "First legacy task");
    core.registerTask(options, "thread-two", "Second legacy task");
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
        ALTER TABLE dependencies RENAME TO dependencies_current;
        CREATE TABLE dependencies (
            task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
            depends_on_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
            dependency_kind TEXT NOT NULL CHECK (dependency_kind = 'ORDER'),
            PRIMARY KEY (task_id, depends_on_id, dependency_kind),
            CHECK (task_id <> depends_on_id)
        );
        DROP TABLE dependencies_current;
        INSERT INTO dependencies (task_id, depends_on_id, dependency_kind) VALUES ('T0002', 'T0001', 'ORDER');
        ALTER TABLE events RENAME TO events_current;
        CREATE TABLE events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT NOT NULL UNIQUE,
            task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('ENQUEUE_REQUESTED', 'REVIEW_REQUESTED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            processed_at TEXT,
            result_json TEXT
        );
        DROP TABLE events_current;
        INSERT INTO events (event_key, task_id, kind, payload_json, created_at)
        VALUES ('legacy-enqueue', 'T0001', 'ENQUEUE_REQUESTED', '{}', '2026-01-01T00:00:00.000Z');
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
    const dependencySql = migratedDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dependencies'").get().sql;
    const eventSql = migratedDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get().sql;
    const migratedDependency = migratedDatabase.prepare("SELECT dependency_kind FROM dependencies WHERE task_id = 'T0002' AND depends_on_id = 'T0001'").get();
    const migratedEvent = migratedDatabase.prepare("SELECT kind FROM events WHERE event_key = 'legacy-enqueue'").get();
    migratedDatabase.close();
    assert.equal(version, 5);
    assert.equal(project.git_mode, "local-approval-commit");
    assert.ok(taskColumns.includes("reviewed_commit"));
    assert.match(dependencySql, /BLOCKING/);
    assert.match(eventSql, /MOVE_REQUESTED/);
    assert.match(eventSql, /REWORK_REQUESTED/);
    assert.equal(migratedDependency.dependency_kind, "BLOCKING");
    assert.equal(migratedEvent.kind, "ENQUEUE_REQUESTED");
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
    assert.equal(Object.hasOwn(firstRequest, "notification"), false);
    assert.equal(Object.hasOwn(firstRequest, "controlRoomThreadId"), false);
    assert.equal(core.getStatus(options, "T0001").task.state, "PLANNING");
    const processed = core.processPendingEvents(options);
    const queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002"]);
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.title), ["⭕️ ① T0001 - First task", "⭕️ ② T0002 - Second task"]);
    assert.deepEqual(processed.results.flatMap((result) => result.titleUpdates).map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0001 - First task", "⭕️ ② T0002 - Second task"]);
    assert.deepEqual(queue[1].dependencies, []);
    assert.equal(queue[0].baseCommit, null);
    assert.equal(queue[0].branchName, null);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), branchesBeforeQueue);
});

test("settles worker events directly and returns the fully renumbered queue", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 3; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        core.registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }

    const settledResult = runCli(["settle", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot]);
    assert.equal(settledResult.status, 0, settledResult.stderr || settledResult.stdout);
    const settled = JSON.parse(settledResult.stdout);
    assert.equal(settled.settled, true);
    assert.equal(settled.processed.processedCount, 3);
    assert.equal(settled.activation.activated, true);
    assert.equal(settled.activation.task.taskId, "T0001");
    assert.deepEqual(settled.queue.map((task: Record<string, unknown>) => task.title), [
        "🔴 T0001 - Task 1",
        "⭕️ ① T0002 - Task 2",
        "⭕️ ② T0003 - Task 3"
    ]);

    const retry = core.settleProject(options);
    assert.equal(retry.processed.processedCount, 0);
    assert.equal(retry.activation.activated, false);
    assert.equal(retry.activation.reason, "ACTIVE_TASK_PRESENT");
    assert.deepEqual(retry.queue.map((task: Record<string, unknown>) => task.title), settled.queue.map((task: Record<string, unknown>) => task.title));
});

test("settlement commits an approved task and activates the next worker", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 2; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        core.registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.settleProject(options);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "settled.txt"), "approved\n");
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { summary: "Ready" });
    core.settleProject(options);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Add settled workflow coverage", userRequestId: "user-message-1" });

    const settled = core.settleProject(options);
    assert.equal(settled.completion.task.state, "DONE");
    assert.equal(settled.completion.committed, true);
    assert.equal(settled.activation.activated, true);
    assert.equal(settled.activation.task.taskId, "T0002");
    assert.deepEqual(settled.queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0002 - Task 2"]);
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "Add settled workflow coverage");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0002");
});

test("moves an already queued task to the end on a new enqueue request", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 3; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        core.registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002", "T0003"]);

    core.submitEvent(options, "enqueue-2-again", "T0002", "ENQUEUE_REQUESTED", {});
    const processed = core.processPendingEvents(options);
    assert.equal(processed.results[0].action, "REENQUEUED");
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0003", "T0002"]);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.title), ["⭕️ ① T0001 - Task 1", "⭕️ ② T0003 - Task 3", "⭕️ ③ T0002 - Task 2"]);

    const retry = core.submitEvent(options, "enqueue-2-again", "T0002", "ENQUEUE_REQUESTED", {});
    assert.equal(retry.created, false);
    assert.equal(core.processPendingEvents(options).processedCount, 0);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0003", "T0002"]);
});

test("reorders waiting tasks independently from blocking dependencies", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 4; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        core.registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.processPendingEvents(options);
    core.submitEvent(options, "dependency-add-4-1", "T0004", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002", "T0003", "T0004"]);

    core.submitEvent(options, "move-4-first", "T0004", "MOVE_REQUESTED", { position: 1 });
    const firstMove = core.processPendingEvents(options);
    let queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.taskId), ["T0004", "T0001", "T0002", "T0003"]);
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.title), ["⭕️ ① T0004 - Task 4", "⭕️ ② T0001 - Task 1", "⭕️ ③ T0002 - Task 2", "⭕️ ④ T0003 - Task 3"]);
    assert.deepEqual(firstMove.results[0].titleUpdates.map((update: Record<string, unknown>) => update.title), queue.map((task: Record<string, unknown>) => task.title));
    assert.deepEqual(queue[0].dependencies, ["T0001"]);

    core.submitEvent(options, "move-4-after-2", "T0004", "MOVE_REQUESTED", { afterTaskId: "T0002" });
    core.processPendingEvents(options);
    queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002", "T0004", "T0003"]);
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.title), ["⭕️ ① T0001 - Task 1", "⭕️ ② T0002 - Task 2", "⭕️ ③ T0004 - Task 4", "⭕️ ④ T0003 - Task 3"]);
    assert.deepEqual(queue[2].dependencies, ["T0001"]);

    core.submitEvent(options, "move-4-before-2", "T0004", "MOVE_REQUESTED", { beforeTaskId: "T0002" });
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0004", "T0002", "T0003"]);

    core.submitEvent(options, "move-4-fourth", "T0004", "MOVE_REQUESTED", { position: 4 });
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002", "T0003", "T0004"]);

    core.submitEvent(options, "dependency-remove-4-1", "T0004", "DEPENDENCY_REMOVE_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue[3].dependencies, []);
});

test("rejects dependency cycles without changing queue order", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Second task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    core.submitEvent(options, "dependency-2-1", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);
    core.submitEvent(options, "dependency-1-2", "T0001", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0002" });
    const rejected = core.processPendingEvents(options);
    assert.equal(rejected.results[0].action, "REJECTED");
    assert.match(rejected.results[0].error, /dependency cycle/);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002"]);
});

test("maps move, dependency, and global queue CLI commands", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Second task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);

    const moveResult = runCli(["request-move", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "cli-move", "--position", "1"]);
    assert.equal(moveResult.status, 0, moveResult.stderr || moveResult.stdout);
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.taskId), ["T0002", "T0001"]);

    const dependencyResult = runCli(["request-dependency-add", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "cli-dependency", "--depends-on", "T0001"]);
    assert.equal(dependencyResult.status, 0, dependencyResult.stderr || dependencyResult.stdout);
    core.processPendingEvents(options);
    assert.deepEqual(core.getQueue(options).queue[0].dependencies, ["T0001"]);

    const queueResult = runCli(["queue", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot]);
    assert.equal(queueResult.status, 0, queueResult.stderr || queueResult.stdout);
    assert.deepEqual(JSON.parse(queueResult.stdout).queue.map((task: Record<string, unknown>) => task.taskId), ["T0002", "T0001"]);
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

test("numbers only queued tasks while another task is running", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 3; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        core.registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.processPendingEvents(options);

    const activation = core.activateNextTask(options);
    assert.equal(activation.task.title, "🔴 T0001 - Task 1");
    assert.deepEqual(activation.titleUpdates.map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0002 - Task 2", "⭕️ ② T0003 - Task 3"]);
    let queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0001 - Task 1", "⭕️ ① T0002 - Task 2", "⭕️ ② T0003 - Task 3"]);
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.queuedPosition), [null, 1, 2]);

    core.registerTask(options, "thread-4", "Task 4");
    core.submitEvent(options, "enqueue-4", "T0004", "ENQUEUE_REQUESTED", {});
    const enqueued = core.processPendingEvents(options);
    assert.equal(enqueued.results[0].task.queuePosition, 4);
    assert.equal(enqueued.results[0].task.queuedPosition, 3);
    assert.equal(enqueued.results[0].task.title, "⭕️ ③ T0004 - Task 4");
    queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0001 - Task 1", "⭕️ ① T0002 - Task 2", "⭕️ ② T0003 - Task 3", "⭕️ ③ T0004 - Task 4"]);

    core.submitEvent(options, "block-2", "T0002", "BLOCKED_REPORTED", { reason: "Waiting for input" });
    const blocked = core.processPendingEvents(options);
    assert.deepEqual(blocked.results[0].titleUpdates.map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0003 - Task 3", "⭕️ ② T0004 - Task 4"]);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0001 - Task 1", "❌ T0002 - Task 2", "⭕️ ① T0003 - Task 3", "⭕️ ② T0004 - Task 4"]);

    const resumed = core.resumeTask(options, "T0002");
    assert.deepEqual(resumed.titleUpdates.map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0002 - Task 2", "⭕️ ② T0003 - Task 3", "⭕️ ③ T0004 - Task 4"]);
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
    assert.equal(core.getStatus(options, "T0001").task.title, "💪 T0001 - Commit on approval");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Commit approved changes safely", userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
});

test("returns review to running before rework without changing Git state", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Refine review", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "first pass\n");
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { summary: "First pass ready" });
    core.processPendingEvents(options);
    const branchBeforeRework = runGit(fixture.repositoryRoot, ["branch", "--show-current"]);
    const headBeforeRework = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const statusBeforeRework = runGit(fixture.repositoryRoot, ["status", "--porcelain"]);

    const requested = runCli([
        "request-rework",
        "--project-root",
        fixture.repositoryRoot,
        "--state-root",
        fixture.stateRoot,
        "--task",
        "T0001",
        "--event-key",
        "rework-1",
        "--summary",
        "Address review feedback"
    ]);
    assert.equal(requested.status, 0, requested.stderr || requested.stdout);
    assert.equal(JSON.parse(requested.stdout).created, true);
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");

    const processed = core.processPendingEvents(options);
    assert.equal(processed.results[0].action, "REWORK_STARTED");
    assert.equal(processed.results[0].summary, "Address review feedback");
    assert.equal(processed.results[0].task.state, "RUNNING");
    assert.equal(processed.results[0].task.title, "🔴 T0001 - Refine review");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), branchBeforeRework);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), headBeforeRework);
    assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain"]), statusBeforeRework);

    const retry = runCli([
        "request-rework",
        "--project-root",
        fixture.repositoryRoot,
        "--state-root",
        fixture.stateRoot,
        "--task",
        "T0001",
        "--event-key",
        "rework-1",
        "--summary",
        "Address review feedback"
    ]);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(retry.stdout).created, false);

    core.submitEvent(options, "review-2", "T0001", "REVIEW_REQUESTED", { summary: "Rework ready" });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.title, "💪 T0001 - Refine review");
});

test("requires a meaningful approval commit subject distinct from the task title", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Improve approval messages", "enqueue-1");
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { summary: "Ready" });
    core.processPendingEvents(options);

    assert.throws(
        () => core.submitEvent(options, "approve-missing", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" }),
        /Commit message is required/
    );
    assert.throws(
        () => core.submitEvent(options, "approve-title", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Improve approval messages", userRequestId: "user-message-2" }),
        /rather than copy the task name/
    );
    assert.throws(
        () => core.submitEvent(options, "approve-decorated", "T0001", "APPROVAL_REQUESTED", { commitMessage: "T0001 - Improve approval messages", userRequestId: "user-message-3" }),
        /must not use the task title format/
    );
    const approval = runCli([
        "request-approve",
        "--project-root",
        fixture.repositoryRoot,
        "--state-root",
        fixture.stateRoot,
        "--task",
        "T0001",
        "--event-key",
        "approve-valid",
        "--user-request-id",
        "user-message-4",
        "--commit-message",
        "Generate meaningful approval subjects"
    ]);
    assert.equal(approval.status, 0, approval.stderr || approval.stdout);
    assert.equal(JSON.parse(approval.stdout).created, true);
    const processed = core.processPendingEvents(options);
    assert.equal(processed.results[0].commitMessage, "Generate meaningful approval subjects");
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
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Preserve changes made during review", userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-2", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Replace the original commit subject", userRequestId: "user-message-2" });
    core.processPendingEvents(options);
    const committed = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.task.state, "DONE");
    assert.equal(committed.task.title, "🟢 T0001 - Flexible review");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:change.txt"]), "after review");
    assert.equal(runGit(fixture.repositoryRoot, ["show", "HEAD:additional.txt"]), "added during review");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "Preserve changes made during review");
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
    approveTask(options, "T0001", "first", "Commit changes directly on main");
    const committed = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.task.state, "DONE");
    assert.equal(committed.committed, true);
    assert.equal(committed.merged, false);
    assert.equal(committed.branchDeleted, false);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "Commit changes directly on main");
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
    approveTask(options, "T0001", "first", "Add approved changes after external commit");
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
    approveTask(options, "T0001", "first", "Add approved changes after external commit");
    const committed = core.commitApprovedTask(options, "T0001");
    assert.equal(committed.task.state, "DONE");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--count", "HEAD"]), "3");
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "Add approved changes after external commit");
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
    core.submitEvent(options, "dependency-2-1", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "first.txt"), "first\n");
    approveTask(options, "T0001", "first");
    const firstCompletion = core.commitApprovedTask(options, "T0001");
    const firstCommit = firstCompletion.task.committedCommit;
    assert.deepEqual(firstCompletion.titleUpdates.map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0002 - Dependent task"]);
    const secondActivation = core.activateNextTask(options);
    assert.equal(secondActivation.task.taskId, "T0002");
    assert.equal(secondActivation.task.baseCommit, firstCommit);
    assert.equal(secondActivation.task.branchName, "control-room/T0002");
    const dependencyRetry = core.submitEvent(options, "dependency-2-1", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    assert.equal(dependencyRetry.created, false);
    assert.equal(dependencyRetry.processed, true);
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
    approveTask(options, "T0001", "first", "Recover approved project change");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Recover approved project change"]);
    const recovered = core.recoverCommit(options, "T0001");
    assert.equal(recovered.finalized, true);
    assert.equal(recovered.task.state, "DONE");
    assert.equal(recovered.task.committedCommit, runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]));
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
});

test("recovery integrates an initial root commit from the unborn worker branch", () => {
    const fixture = createUnbornFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Recover initial commit", "enqueue-1");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "initial.txt"), "initial\n");
    approveTask(options, "T0001", "first", "Create initial recovered project");

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A", "--", "."]);
    runGit(fixture.repositoryRoot, ["commit", "--message", "Create initial recovered project"]);

    const recovered = core.recoverCommit(options, "T0001");
    assert.equal(recovered.finalized, true);
    assert.equal(recovered.task.state, "DONE");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--all", "--count"]), "1");
});

test("recovery recognizes a direct approval commit on the base branch", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Recover base commit", "enqueue-1");
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), "change\n");
    approveTask(options, "T0001", "first", "Recover direct base branch change");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Recover direct base branch change"]);
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
    approveTask(options, "T0001", "first", "Recover merged worker change");
    const preCommitHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE tasks SET reviewed_commit = ? WHERE task_id = ?").run(preCommitHead, "T0001");
    database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    database.close();
    runGit(fixture.repositoryRoot, ["add", "-A"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Recover merged worker change"]);
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
    const canceled = core.processPendingEvents(options);
    assert.deepEqual(canceled.results[0].titleUpdates.map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0002 - Next task"]);
    assert.throws(() => core.activateNextTask(options), /working tree must be clean/);
});

test("join is documented as a non-terminal directive that preserves the request", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /Preserve the complete message before handling the directive/);
    assert.match(skillText, /Remove only the directive, then evaluate and fulfill every remaining request in the same turn/);
    assert.match(skillText, /Joining is idempotent and never consumes the substantive request/);
});

test("documents queue and help as global read-only commands", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /\$control-room queue/);
    assert.match(skillText, /\$control-room help/);
    assert.match(skillText, /Treat these as read-only commands that never register or rename the caller/);
    assert.match(skillText, /They do not submit or settle events/);
    const cliResult = runCli(["help"]);
    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    assert.match(cliResult.stdout, /\$control-room queue/);
    assert.match(cliResult.stdout, /^\s+Enqueue \[after T0002\]$/m);
    assert.doesNotMatch(cliResult.stdout, /^\s+Queue \[after T0002\]$/m);
    assert.match(cliResult.stdout, /Move first/);
    assert.match(cliResult.stdout, /Depends on T0002/);
});

test("documents init as creation of a silent manual Control Room task", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /Create one top-level task in that project with the \*\*Local\*\* environment/);
    assert.match(skillText, /initial prompt `\$control-room console`/);
    assert.match(skillText, /Leave the calling task unchanged and unregistered/);
    assert.match(skillText, /does not process routine events or receive wake notifications/);
    assert.match(skillText, /apply the title of every task in the returned final `queue`/);
});
