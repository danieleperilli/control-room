import type { IControlRoomOptions } from "../scripts/control-room-types.ts";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const test: typeof import("node:test") = require("node:test");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");
const helpers: import("./helpers.ts").ITestHelpers = require("./helpers.ts");

/** Create a disposable initialized project with explicit commit-mode authorization. */
function createCommitFixture() {
    const fixture = helpers.createFixture();
    const databasePath = helpers.initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.setIntegrationMode(options, "commit", "commit-mode", "commit-mode-message", "side-chat");
    return { ...fixture, databasePath, options };
}

test("commit mode creates its shared branch from main and continues the approved history", () => {
    const fixture = createCommitFixture();
    const first = helpers.activateTask(fixture.options, "first", "First behavior", "enqueue-first");
    assert.equal(first.task!.branchName, "control-room/codex");
    assert.equal(first.task!.baseCommit, fixture.initialCommit);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "first.txt"), "first behavior\n");
    const second = helpers.registerTask(fixture.options, "second", "Second behavior");
    core.submitEvent(fixture.options, "second-dependency", second.taskId, "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(fixture.options, "enqueue-second", second.taskId, "ENQUEUE_REQUESTED", {});
    helpers.approveTask(fixture.options, "T0001", "first", "Implement first behavior");
    const completed = core.settleProject(fixture.options) as any;
    assert.equal(completed.completion.task.state, "DONE");
    assert.equal(completed.completion.merged, false);
    assert.equal(completed.completion.branchDeleted, false);
    assert.equal(completed.activation.task.taskId, second.taskId);
    assert.equal(completed.activation.task.branchName, "control-room/codex");
    assert.equal(completed.activation.task.baseCommit, completed.completion.task.approvedCommit);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "second.txt"), "second behavior\n");
    helpers.approveTask(fixture.options, second.taskId, "second", "Implement second behavior");
    const next = core.settleProject(fixture.options) as any;
    assert.equal(next.completion.task.state, "DONE");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD^"]), completed.completion.task.approvedCommit);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/codex");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(core.doctorProject(fixture.options).checks.some((check) => check.code === "SHARED_CHECKOUT_UNASSIGNED"), false);
});

test("new merge-mode tasks start from base after commit-mode completion and retain the saved branch", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "first", "Save branch behavior", "enqueue-first");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "saved.txt"), "saved behavior\n");
    helpers.approveTask(fixture.options, "T0001", "first", "Persist saved branch changes");
    const completed = core.commitApprovedTask(fixture.options, "T0001");
    core.setIntegrationMode(fixture.options, "merge", "merge-mode", "merge-mode-message", "side-chat");
    const next = helpers.activateTask(fixture.options, "second", "Independent behavior", "enqueue-second");
    assert.equal(next.task!.branchName, "control-room/T0002");
    assert.equal(next.task!.baseCommit, fixture.initialCommit);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/codex"]), completed.task.approvedCommit);
    assert.equal(fs.existsSync(path.join(fixture.repositoryRoot, "saved.txt")), false);
});

test("commit mode adopts an existing branch and excludes earlier commits from the task baseline", () => {
    const fixture = createCommitFixture();
    helpers.runGit(fixture.repositoryRoot, ["checkout", "-b", "feature/existing"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "earlier.txt"), "earlier work\n");
    helpers.runGit(fixture.repositoryRoot, ["add", "."]);
    helpers.runGit(fixture.repositoryRoot, ["commit", "-m", "Existing feature history"]);
    const baseline = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const activated = helpers.activateTask(fixture.options, "worker", "Existing branch behavior", "enqueue");
    assert.equal(activated.task!.branchName, "feature/existing");
    assert.equal(activated.task!.baseCommit, baseline);
    helpers.approveTask(fixture.options, "T0001", "clean", "Verify existing feature behavior");
    const completed = core.commitApprovedTask(fixture.options, "T0001");
    assert.equal(completed.committed, false);
    assert.equal(completed.task.state, "DONE");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), baseline);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "feature/existing");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--list", "control-room/codex"]), "");
});

test("commit mode keeps a non-main current branch even when it is the configured integration base", () => {
    const fixture = helpers.createFixture();
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    helpers.runGit(fixture.repositoryRoot, ["checkout", "-b", "develop"]);
    core.initializeProject(options, "control-room-thread", "develop");
    core.setIntegrationMode(options, "commit", "mode", "mode-message", "side-chat");
    const activation = helpers.activateTask(options, "worker", "Current branch behavior", "enqueue");
    assert.equal(activation.task!.branchName, "develop");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "current.txt"), "current behavior\n");
    helpers.approveTask(options, "T0001", "approve", "Save current branch changes");
    const completed = core.commitApprovedTask(options, "T0001");
    assert.equal(completed.merged, false);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "develop");
});

test("commit mode resumes its existing branch from main without resetting saved commits", () => {
    const fixture = createCommitFixture();
    helpers.runGit(fixture.repositoryRoot, ["checkout", "-b", "control-room/codex"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "saved.txt"), "saved work\n");
    helpers.runGit(fixture.repositoryRoot, ["add", "."]);
    helpers.runGit(fixture.repositoryRoot, ["commit", "-m", "Preserve saved work"]);
    const saved = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    helpers.runGit(fixture.repositoryRoot, ["checkout", "main"]);
    const activation = helpers.activateTask(fixture.options, "worker", "Continue saved behavior", "enqueue");
    assert.equal(activation.task!.baseCommit, saved);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), saved);
});

for (const target of ["DONE", "PAUSED"] as const) {
    test(`commit-mode ${target} preserves its checkout through reopening or resuming`, () => {
        const fixture = createCommitFixture();
        helpers.activateTask(fixture.options, "worker", "Checkpoint behavior", "enqueue");
        fs.writeFileSync(path.join(fixture.repositoryRoot, "checkpoint.txt"), "checkpoint\n");
        core.submitEvent(fixture.options, "approve", "T0001", "APPROVAL_REQUESTED", { approvalTarget: target, commitMessage: "Save checkpoint behavior", userRequestId: "approve-message" });
        core.processPendingEvents(fixture.options);
        core.commitApprovedTask(fixture.options, "T0001");
        const saved = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
        assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, target);
        core.resumeTask(fixture.options, "T0001", target === "DONE");
        assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, "PLANNING");
        assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/codex");
        assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), saved);
        core.submitEvent(fixture.options, "continue", "T0001", "RUN_NOW_REQUESTED", { userRequestId: "continue-message" });
        assert.equal((core.settleProject(fixture.options) as any).activation.task.baseCommit, saved);
    });
}

test("an approved commit-mode snapshot survives a later mode selection", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "worker", "Snapshot behavior", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "snapshot.txt"), "snapshot\n");
    core.submitEvent(fixture.options, "approve", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Save snapshot behavior", userRequestId: "approve-message" });
    core.setIntegrationMode(fixture.options, "pr", "select-pr", "select-pr-message", "side-chat");
    core.processPendingEvents(fixture.options);
    const completed = core.commitApprovedTask(fixture.options, "T0001");
    assert.equal(completed.task.integrationMode, "commit");
    assert.equal(completed.merged, false);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(core.getStatus(fixture.options).integrationMode, "pr");
});

test("autopilot approval follows commit mode and retains the shared branch", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "worker", "Automatic behavior", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "automatic.txt"), "automatic behavior\n");
    core.submitEvent(fixture.options, "review", "T0001", "REVIEW_REQUESTED", { summary: "Fixture behavior verified" });
    core.processPendingEvents(fixture.options);
    core.setAutopilot(fixture.options, true, "auto-on", "auto-message", "side-chat");
    core.submitEvent(fixture.options, "approve", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Save automatic behavior", autopilotEventKey: "auto-on", reviewEventKey: "review", verification: "Fixture behavior checks passed" });
    const completed = core.settleProject(fixture.options) as any;
    assert.equal(completed.completion.task.state, "DONE");
    assert.equal(completed.completion.merged, false);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/codex");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
});

test("reopening a commit-mode sender defers its undelivered successor without deleting the shared branch", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "first", "First behavior", "enqueue-first");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "first.txt"), "first behavior\n");
    helpers.registerTask(fixture.options, "second", "Second behavior");
    core.submitEvent(fixture.options, "enqueue-second", "T0002", "ENQUEUE_REQUESTED", {});
    helpers.approveTask(fixture.options, "T0001", "first", "Save first behavior");
    const completed = core.settleProject(fixture.options) as any;
    core.submitEvent(fixture.options, "handoff-wait", "T0001", "USER_INPUT_REQUESTED", { handoffTaskId: "T0002" });
    core.processPendingEvents(fixture.options);
    const reopened = core.resumeTask(fixture.options, "T0001", true);
    assert.deepEqual(reopened.deferredTaskIds, ["T0002"]);
    assert.equal((core.getStatus(fixture.options, "T0002").task as any).state, "QUEUED");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/codex"]), completed.completion.task.approvedCommit);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/codex");
});

test("commit mode selection requires user provenance and old retries retain the latest mode", () => {
    const fixture = createCommitFixture();
    const args = ["--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot];
    assert.notEqual(helpers.runCli(["mode", ...args, "--mode", "commit"]).status, 0);
    const selection = helpers.runCli(["mode", ...args, "--mode", "commit", "--event-key", "cli-mode", "--user-request-id", "cli-message", "--thread-id", "side-chat"]);
    assert.equal(selection.status, 0, selection.stderr);
    assert.equal(JSON.parse(selection.stdout).integrationMode, "commit");
    assert.equal(core.getStatus(fixture.options).nextTaskId, "T0001");
    core.setIntegrationMode(fixture.options, "merge", "merge-mode", "merge-mode-message", "side-chat");
    assert.equal(core.setIntegrationMode(fixture.options, "commit", "cli-mode", "cli-message", "side-chat").integrationMode, "merge");
});

test("merge approval after commit-mode activation preserves the adopted branch", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "worker", "Mode transition behavior", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "transition.txt"), "transition\n");
    core.setIntegrationMode(fixture.options, "merge", "select-merge", "select-merge-message", "side-chat");
    helpers.approveTask(fixture.options, "T0001", "merge", "Integrate transition behavior");
    const completed = core.commitApprovedTask(fixture.options, "T0001");
    assert.equal(completed.merged, true);
    assert.equal(completed.branchDeleted, false);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/codex"]), completed.task.approvedCommit);
    core.resumeTask(fixture.options, "T0001", true);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/codex"]), completed.task.approvedCommit);
});

test("commit mode rejects main approval, detached activation, and isolated execution before Git mutations", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "worker", "Protected branch behavior", "enqueue");
    helpers.runGit(fixture.repositoryRoot, ["checkout", "main"]);
    fs.writeFileSync(path.join(fixture.repositoryRoot, "protected.txt"), "preserve\n");
    helpers.approveTask(fixture.options, "T0001", "main", "Preserve protected branch behavior");
    assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"));
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(core.getStatus(fixture.options).commitTaskId, null);
    const detached = createCommitFixture();
    helpers.runGit(detached.repositoryRoot, ["checkout", "--detach"]);
    assert.throws(() => helpers.activateTask(detached.options, "worker", "Detached behavior", "enqueue"));
    assert.equal((core.getStatus(detached.options, "T0001").task as any).state, "QUEUED");
    const isolated = createCommitFixture();
    helpers.registerTask(isolated.options, "worker", "Isolated behavior");
    core.submitEvent(isolated.options, "isolated", "T0001", "RUN_ISOLATED_NOW_REQUESTED", { userRequestId: "isolated-message" });
    assert.throws(() => core.settleProject(isolated.options));
    assert.equal(helpers.runGit(isolated.repositoryRoot, ["branch", "--format=%(refname:short)"]), "main");
});

test("commit mode creates an initial commit without establishing or merging the unborn main branch", () => {
    const fixture = helpers.createUnbornFixture();
    helpers.initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.setIntegrationMode(options, "commit", "mode", "mode-message", "side-chat");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "initial.txt"), "initial behavior\n");
    helpers.activateTask(options, "worker", "Initial behavior", "enqueue");
    helpers.approveTask(options, "T0001", "initial", "Create initial behavior");
    const completed = core.commitApprovedTask(options, "T0001");
    assert.equal(completed.task.state, "DONE");
    assert.equal(completed.merged, false);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-list", "--count", "HEAD"]), "1");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--list", "main"]), "");
});

test("commit recovery recognizes the exact approved commit and never merges or duplicates it", () => {
    const fixture = createCommitFixture();
    helpers.activateTask(fixture.options, "worker", "Recovery behavior", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "recovery.txt"), "recovery\n");
    helpers.approveTask(fixture.options, "T0001", "recover", "Save recovery behavior");
    const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-operation.ts"), fixture.repositoryRoot, fixture.stateRoot, "T0001", "commit", JSON.stringify(["commit"])], { encoding: "utf8", shell: false });
    assert.equal(killed.signal, "SIGKILL");
    const saved = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    assert.equal(core.getStatus(fixture.options).commitTaskId, "T0001");
    const recovered = core.recoverCommit(fixture.options, "T0001");
    assert.equal(recovered.finalized, true);
    assert.equal(recovered.task.state, "DONE");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), saved);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(core.recoverCommit(fixture.options, "T0001").alreadyFinalized, true);
});

test("schema 20 migration retains approvals, dependencies, delivery records, and mode history", () => {
    const fixture = helpers.createFixture();
    const databasePath = helpers.initializeFixture(fixture);
    const options: IControlRoomOptions = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    helpers.activateTask(options as import("./helpers.ts").IOptions, "worker", "Migration behavior", "enqueue");
    helpers.registerTask(options as import("./helpers.ts").IOptions, "dependent", "Dependent behavior");
    core.submitEvent(options, "dependency", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.setIntegrationMode(options, "pr", "mode", "mode-message", "side-chat");
    helpers.approveTask(options as import("./helpers.ts").IOptions, "T0001", "migration", "Preserve migration behavior");
    const old = new DatabaseSync(databasePath);
    old.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    for (const tableName of ["projects", "tasks", "integration_mode_requests"]) {
        const schema = old.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'").get(tableName) as { sql: string };
        old.exec(schema.sql.replace(/^CREATE TABLE\s+(?:"[a-z_]+"|[a-z_]+)/u, `CREATE TABLE ${tableName}_v20`).replace("'merge', 'pr', 'commit'", "'merge', 'pr'"));
        old.exec(`INSERT INTO ${tableName}_v20 SELECT * FROM ${tableName}; DROP TABLE ${tableName}; ALTER TABLE ${tableName}_v20 RENAME TO ${tableName}`);
    }
    old.exec("ALTER TABLE tasks DROP COLUMN branch_owned; PRAGMA user_version = 20; COMMIT");
    old.close();
    assert.equal(core.getStatus(options).reason, "MIGRATION_REQUIRED");
    core.installProjectRouting(options);
    assert.equal(core.getStatus(options).integrationMode, "pr");
    assert.equal((core.getStatus(options, "T0001").task as any).integrationMode, "pr");
    const migrated = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 21);
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM dependencies").get()!.n, 1);
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM activation_deliveries").get()!.n, 1);
    assert.equal(migrated.prepare("SELECT count(*) AS n FROM integration_mode_requests").get()!.n, 1);
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(migrated.prepare("SELECT branch_owned FROM tasks WHERE task_id = 'T0001'").get()!.branch_owned, 1);
    migrated.close();
    core.setIntegrationMode(options, "commit", "commit", "commit-message", "side-chat");
    assert.equal(core.getStatus(options).integrationMode, "commit");
});
