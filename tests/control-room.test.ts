const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const core = require("../scripts/control-room-core.ts");

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
 * Create an isolated Git repository and Control Room state root.
 */
function createFixture(): { repositoryRoot: string; stateRoot: string; initialCommit: string } {
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
    const initialCommit = runGit(repositoryRoot, ["rev-parse", "HEAD"]);
    return { repositoryRoot, stateRoot, initialCommit };
}

/**
 * Initialize one fixture project with its coordinator.
 * @param fixture Disposable project fixture.
 */
function initializeFixture(fixture: { repositoryRoot: string; stateRoot: string }): string {
    const initialized = core.initializeProject(
        { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot },
        "coordinator-thread",
        "main"
    );
    assert.equal(initialized.coordinatorTitle, "⚫️ Control Room");
    return initialized.databasePath;
}

/**
 * Create a local worker branch at the fixture's current main commit.
 * @param fixture Disposable project fixture.
 * @param branchName Worker branch to create.
 */
function createWorkerBranch(fixture: { repositoryRoot: string }, branchName: string): void {
    runGit(fixture.repositoryRoot, ["branch", branchName, "main"]);
}

test("allocates four-digit task IDs and preserves IDs across registration retries", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    createWorkerBranch(fixture, "worker-one");
    createWorkerBranch(fixture, "worker-two");
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

test("migrates legacy schema columns transactionally", () => {
    const fixture = createFixture();
    const initialized = core.initializeProject(
        { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot },
        "coordinator-thread",
        "main"
    );
    const legacyDatabase = new DatabaseSync(initialized.databasePath);
    legacyDatabase.exec(`
        ALTER TABLE projects DROP COLUMN integration_task_id;
        ALTER TABLE projects DROP COLUMN integration_started_at;
        ALTER TABLE tasks DROP COLUMN reviewed_commit;
        PRAGMA user_version = 1;
    `);
    legacyDatabase.close();
    const status = core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot });
    assert.equal(status.integrationTaskId, null);
    const migratedDatabase = new DatabaseSync(initialized.databasePath);
    const version = migratedDatabase.prepare("PRAGMA user_version").get().user_version;
    const projectColumns = migratedDatabase.prepare("PRAGMA table_info(projects)").all().map((column: Record<string, unknown>) => column.name);
    const taskColumns = migratedDatabase.prepare("PRAGMA table_info(tasks)").all().map((column: Record<string, unknown>) => column.name);
    migratedDatabase.close();
    assert.equal(version, 2);
    assert.ok(projectColumns.includes("integration_task_id"));
    assert.ok(projectColumns.includes("integration_started_at"));
    assert.ok(taskColumns.includes("reviewed_commit"));
});

test("rejects a broken state database symbolic link", () => {
    const fixture = createFixture();
    const initialized = core.initializeProject(
        { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot },
        "coordinator-thread",
        "main"
    );
    fs.rmSync(initialized.databasePath);
    const redirectedTarget = path.join(path.dirname(fixture.stateRoot), "redirected.sqlite");
    fs.symlinkSync(redirectedTarget, initialized.databasePath);
    assert.throws(
        () => core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }),
        /cannot be a symbolic link/
    );
    assert.equal(fs.existsSync(redirectedTarget), false);
});

test("keeps worker requests event-only and applies queue ordering idempotently", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    createWorkerBranch(fixture, "worker-one");
    createWorkerBranch(fixture, "worker-two");
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Second task");
    const firstRequest = core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    const firstRetry = core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {
        afterTaskId: "T0001",
        baseCommit: fixture.initialCommit,
        branchName: "worker-two"
    });
    assert.equal(firstRequest.created, true);
    assert.equal(firstRetry.created, false);
    assert.equal(firstRequest.notification, "CONTROL_ROOM_WAKE");
    assert.equal(firstRetry.notification, "CONTROL_ROOM_WAKE");
    assert.equal(core.getStatus(options, "T0001").task.state, "PLANNING");
    const processed = core.processPendingEvents(options);
    assert.equal(processed.processedCount, 2);
    assert.equal(processed.coordinatorTitle, "⚫️ Control Room");
    const queueResult = core.getQueue(options);
    assert.equal(queueResult.coordinatorTitle, "⚫️ Control Room");
    const queue = queueResult.queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0002"]);
    assert.deepEqual(queue[1].dependencies, ["T0001"]);
    assert.equal(queue[0].title, "⭕️ T0001 - First task");
});

test("enforces dependencies and direct-review approval transitions", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    createWorkerBranch(fixture, "worker-one");
    createWorkerBranch(fixture, "worker-two");
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Second task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {
        afterTaskId: "T0001",
        baseCommit: fixture.initialCommit,
        branchName: "worker-two"
    });
    core.processPendingEvents(options);
    const activation = core.activateNextTask(options);
    assert.equal(activation.task.taskId, "T0001");
    assert.equal(activation.task.title, "🔴 T0001 - First task");
    assert.throws(() => core.activateNextTask(options), /waiting on T0001 in RUNNING/);
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { reviewedCommit: fixture.initialCommit, summary: "Ready" });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.title, "🟡 T0001 - First task");
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    assert.equal(core.getStatus(options, "T0001").task.title, "🟢 T0001 - First task");
    assert.throws(() => core.activateNextTask(options), /waiting on T0001 in APPROVED/);
});

test("fast-forwards the local base branch and completes an approved task", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    runGit(fixture.repositoryRoot, ["checkout", "-b", "worker-one"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "worker.txt"), "worker\n");
    runGit(fixture.repositoryRoot, ["add", "worker.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Worker change"]);
    const workerCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    core.registerTask(options, "thread-one", "Integrate safely");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { reviewedCommit: workerCommit });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    const leasedDatabase = new DatabaseSync(databasePath);
    leasedDatabase.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?").run("T0001", new Date().toISOString());
    leasedDatabase.close();
    assert.throws(() => core.integrateTask(options, "T0001"), /lease is already held/);
    const recovered = core.recoverIntegration(options, "T0001");
    assert.equal(recovered.task.state, "RUNNING");
    core.submitEvent(options, "review-2", "T0001", "REVIEW_REQUESTED", { reviewedCommit: workerCommit });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-2", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-2" });
    core.processPendingEvents(options);
    const integration = core.integrateTask(options, "T0001");
    assert.equal(integration.task.state, "DONE");
    assert.equal(integration.task.title, "✅ T0001 - Integrate safely");
    assert.equal(integration.coordinatorTitle, "⚫️ Control Room");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "main"]), workerCommit);
    assert.equal(core.getQueue(options).queue.length, 0);
});

test("rejects conflicting event-key reuse", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    createWorkerBranch(fixture, "worker-one");
    createWorkerBranch(fixture, "different-worker");
    core.registerTask(options, "thread-one", "Reject conflicts");
    core.submitEvent(options, "same-key", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    assert.throws(
        () => core.submitEvent(options, "same-key", "T0001", "ENQUEUE_REQUESTED", {
            baseCommit: fixture.initialCommit,
            branchName: "different-worker"
        }),
        /different content/
    );
});

test("rejects dependency cycles without poisoning later events", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    createWorkerBranch(fixture, "worker-one");
    createWorkerBranch(fixture, "worker-two");
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Second task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {
        afterTaskId: "T0001",
        baseCommit: fixture.initialCommit,
        branchName: "worker-two"
    });
    core.processPendingEvents(options);
    core.submitEvent(options, "cycle", "T0001", "ENQUEUE_REQUESTED", {
        afterTaskId: "T0002",
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.submitEvent(options, "move-second", "T0002", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-two"
    });
    const processed = core.processPendingEvents(options);
    assert.equal(processed.processedCount, 2);
    assert.equal(processed.results[0].action, "REJECTED");
    assert.match(processed.results[0].error, /dependency cycle/);
    assert.equal(processed.results[1].action, "ENQUEUED");
});

test("pins the reviewed commit and rejects a moved worker branch", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    runGit(fixture.repositoryRoot, ["checkout", "-b", "worker-one"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "reviewed.txt"), "reviewed\n");
    runGit(fixture.repositoryRoot, ["add", "reviewed.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Reviewed change"]);
    const reviewedCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    core.registerTask(options, "thread-one", "Pin reviewed commit");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { reviewedCommit });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    runGit(fixture.repositoryRoot, ["checkout", "worker-one"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "unreviewed.txt"), "unreviewed\n");
    runGit(fixture.repositoryRoot, ["add", "unreviewed.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Unreviewed change"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    assert.throws(() => core.integrateTask(options, "T0001"), /moved from reviewed commit/);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(core.getStatus(options, "T0001").task.state, "RUNNING");
    assert.equal(core.getStatus(options, "T0001").task.reviewedCommit, null);
    assert.equal(core.getStatus(options).integrationTaskId, null);
    const movedWorkerCommit = runGit(fixture.repositoryRoot, ["rev-parse", "worker-one"]);
    core.submitEvent(options, "review-2", "T0001", "REVIEW_REQUESTED", { reviewedCommit: movedWorkerCommit });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.reviewedCommit, movedWorkerCommit);
});

test("requires a stale dependent branch to refresh before review", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    runGit(fixture.repositoryRoot, ["checkout", "-b", "worker-one"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "worker.txt"), "worker\n");
    runGit(fixture.repositoryRoot, ["add", "worker.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Worker change"]);
    const workerCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    createWorkerBranch(fixture, "worker-two");
    core.registerTask(options, "thread-one", "First task");
    core.registerTask(options, "thread-two", "Dependent task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {
        afterTaskId: "T0001",
        baseCommit: fixture.initialCommit,
        branchName: "worker-two"
    });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { reviewedCommit: workerCommit });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    core.integrateTask(options, "T0001");
    const activation = core.activateNextTask(options);
    assert.equal(activation.executionBrief.requiresBaseRefresh, true);
    assert.equal(activation.executionBrief.currentBaseCommit, workerCommit);
    assert.throws(
        () => core.submitEvent(options, "review-too-early", "T0002", "REVIEW_REQUESTED", { reviewedCommit: fixture.initialCommit }),
        /refresh-base/
    );
    runGit(fixture.repositoryRoot, ["branch", "-f", "worker-two", "main"]);
    const refreshed = core.refreshTaskBase(options, "T0002", workerCommit, "worker-two");
    assert.equal(refreshed.task.baseCommit, workerCommit);
});

test("rejects stale-base integration after the base branch moves", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    runGit(fixture.repositoryRoot, ["checkout", "-b", "worker-one"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "worker.txt"), "worker\n");
    runGit(fixture.repositoryRoot, ["add", "worker.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Worker change"]);
    const workerCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    core.registerTask(options, "thread-one", "Stale base");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {
        baseCommit: fixture.initialCommit,
        branchName: "worker-one"
    });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { reviewedCommit: workerCommit });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-1", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-1" });
    core.processPendingEvents(options);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "base-moved.txt"), "base moved\n");
    runGit(fixture.repositoryRoot, ["add", "base-moved.txt"]);
    runGit(fixture.repositoryRoot, ["commit", "-m", "Move base"]);
    const movedBaseCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    assert.throws(() => core.integrateTask(options, "T0001"), /Base branch moved/);
    assert.equal(core.getStatus(options, "T0001").task.state, "RUNNING");
    assert.equal(core.getStatus(options, "T0001").task.reviewedCommit, null);
    assert.equal(core.getStatus(options).integrationTaskId, null);
    runGit(fixture.repositoryRoot, ["checkout", "worker-one"]);
    runGit(fixture.repositoryRoot, ["rebase", "main"]);
    const rebasedWorkerCommit = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    runGit(fixture.repositoryRoot, ["checkout", "main"]);
    core.refreshTaskBase(options, "T0001", movedBaseCommit, "worker-one");
    core.submitEvent(options, "review-2", "T0001", "REVIEW_REQUESTED", { reviewedCommit: rebasedWorkerCommit });
    core.processPendingEvents(options);
    core.submitEvent(options, "approve-2", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-message-2" });
    core.processPendingEvents(options);
    const reintegration = core.integrateTask(options, "T0001");
    assert.equal(reintegration.task.state, "DONE");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "main"]), rebasedWorkerCommit);
});
