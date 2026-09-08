import type { IControlRoomOptions, ISerializedTask } from "../scripts/control-room-types.ts";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { promisify }: typeof import("node:util") = require("node:util");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");
const helpers: import("./helpers.ts").ITestHelpers = require("./helpers.ts");
const execFile = promisify(childProcess.execFile);
const cliPath = path.join(__dirname, "..", "scripts", "control-room.ts");

/** Create a fixture whose routing is committed before activation. */
function readyFixture() {
    const fixture = helpers.createFixture();
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const databasePath = helpers.initializeFixture(fixture);
    core.installProjectRouting(options);
    core.installWorktreeIgnore(options);
    helpers.runGit(options.projectRoot, ["add", "-A"]);
    helpers.runGit(options.projectRoot, ["commit", "-m", "Install fixture routing"]);
    return { options, databasePath };
}

/** Kill a disposable operation after one Git step. @param options Fixture options. @param taskId Task ID. @param prefix Git argument prefix. @param operation Operation to interrupt. */
function interruptOperation(options: IControlRoomOptions, taskId: string, prefix: string[], operation = "commit"): void {
    const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-operation.ts"), options.projectRoot, options.stateRoot!, taskId, operation, JSON.stringify(prefix)], { encoding: "utf8" });
    assert.equal(result.signal, "SIGKILL", result.stderr || result.stdout);
}

test("status, queue and doctor leave absent state absent", () => {
    const fixture = helpers.createFixture();
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    assert.equal(core.getStatus(options).reason, "NOT_INITIALIZED");
    assert.equal(core.getQueue(options).reason, "NOT_INITIALIZED");
    assert.ok(core.doctorProject(options).checks.some((check) => check.code === "NOT_INITIALIZED"));
    assert.equal(fs.existsSync(options.stateRoot), false);
    assert.equal(helpers.runGit(options.projectRoot, ["status", "--porcelain"]), "");
});

test("reads report migration without rewriting an existing database", () => {
    const { options, databasePath } = readyFixture();
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA user_version = 16");
    database.close();
    const original = fs.readFileSync(databasePath);
    const mode = fs.statSync(databasePath).mode;
    assert.equal(core.getStatus(options).reason, "MIGRATION_REQUIRED");
    assert.equal(core.getQueue(options).reason, "MIGRATION_REQUIRED");
    assert.ok(core.doctorProject(options).checks.some((check) => check.code === "MIGRATION_REQUIRED"));
    assert.deepEqual(fs.readFileSync(databasePath), original);
    assert.equal(fs.statSync(databasePath).mode, mode);
    core.installProjectRouting(options);
    assert.equal(core.getStatus(options).baseBranch, "main");
});

for (const prefix of [["update-ref", "refs/heads/main"], ["checkout", "main"], ["update-ref", "-d", "refs/heads/control-room/T0001"]]) {
    test(`recovers shared linear integration after ${prefix.join(" ")}`, () => {
        const { options } = readyFixture();
        helpers.activateTask(options, "shared", "Shared work", "start-shared");
        fs.writeFileSync(path.join(options.projectRoot, "shared.txt"), "shared\n");
        helpers.registerTask(options, "isolated", "Isolated work");
        core.submitEvent(options, "start-isolated", "T0002", "RUN_ISOLATED_NOW_REQUESTED", {});
        core.processPendingEvents(options);
        const activation = core.activateIsolatedTask(options, "T0002");
        assert.ok(activation.executionBrief);
        fs.writeFileSync(path.join(activation.executionBrief.workspacePath, "isolated.txt"), "isolated\n");
        helpers.approveTask(options, "T0002", "approve-isolated");
        core.commitApprovedTask(options, "T0002");
        helpers.approveTask(options, "T0001", "approve-shared");
        interruptOperation(options, "T0001", prefix);
        assert.equal(core.getStatus(options).commitTaskId, "T0001");
        assert.equal(core.recoverCommit(options, "T0001").finalized, true);
        assert.equal((core.getStatus(options, "T0001").task as ISerializedTask).state, "DONE");
        assert.equal(core.getStatus(options).commitTaskId, null);
        assert.equal(helpers.runGit(options.projectRoot, ["show", "main:shared.txt"]), "shared");
        assert.equal(helpers.runGit(options.projectRoot, ["show", "main:isolated.txt"]), "isolated");
        assert.equal(helpers.runGit(options.projectRoot, ["branch", "--format=%(refname:short)"]), "main");
        assert.equal(core.recoverCommit(options, "T0001").alreadyFinalized, true);
    });
}

for (const checkpoint of [false, true]) {
    for (const step of ["worktree", "branch"]) {
        test(`recovers unchanged isolated ${checkpoint ? "checkpoint" : "approval"} after ${step} removal`, () => {
            const { options } = readyFixture();
            helpers.registerTask(options, "isolated", "Unchanged work");
            core.submitEvent(options, "start", "T0001", "RUN_ISOLATED_NOW_REQUESTED", {});
            core.processPendingEvents(options);
            const activation = core.activateIsolatedTask(options, "T0001");
            assert.ok(activation.executionBrief);
            core.submitEvent(options, "approval", "T0001", "APPROVAL_REQUESTED", { userRequestId: "approval-message", commitMessage: "Finalize unchanged fixture work", approvalTarget: checkpoint ? "PAUSED" : "DONE" });
            core.processPendingEvents(options);
            const before = helpers.runGit(options.projectRoot, ["rev-parse", "main"]);
            interruptOperation(options, "T0001", step === "worktree" ? ["worktree", "remove"] : ["update-ref", "-d"]);
            assert.ok(core.doctorProject(options).checks.some((check) => check.code === "CLEANUP_PENDING"));
            assert.equal(core.recoverCommit(options, "T0001").finalized, true);
            assert.equal((core.getStatus(options, "T0001").task as ISerializedTask).state, checkpoint ? "PAUSED" : "DONE");
            assert.equal(helpers.runGit(options.projectRoot, ["rev-parse", "main"]), before);
            assert.equal(fs.existsSync(activation.executionBrief.workspacePath), false);
            assert.equal(core.getStatus(options).commitTaskId, null);
        });
    }
}

test("recovers unchanged shared checkpoint after its branch was deleted", () => {
    const { options } = readyFixture();
    helpers.activateTask(options, "shared", "Unchanged shared checkpoint", "start");
    core.submitEvent(options, "approval", "T0001", "APPROVAL_REQUESTED", { userRequestId: "checkpoint-message", commitMessage: "Finalize unchanged shared checkpoint", approvalTarget: "PAUSED" });
    core.processPendingEvents(options);
    interruptOperation(options, "T0001", ["update-ref", "-d"]);
    assert.equal(core.recoverCommit(options, "T0001").finalized, true);
    assert.equal((core.getStatus(options, "T0001").task as ISerializedTask).state, "PAUSED");
    assert.equal(core.resumeTask(options, "T0001").resumed, true);
});

test("recovers activation after checkout and persists exactly one brief", () => {
    const { options } = readyFixture();
    helpers.registerTask(options, "worker", "Interrupted activation");
    core.submitEvent(options, "start", "T0001", "ENQUEUE_REQUESTED", { userRequestId: "original-message" });
    core.processPendingEvents(options);
    interruptOperation(options, "T0001", ["checkout", "-b"], "activate");
    assert.equal(core.getPendingActivations(options).length, 0);
    const activation = core.activateNextTask(options);
    assert.ok(activation.executionBrief);
    assert.equal(core.getPendingActivations(options).length, 1);
    assert.equal(core.getPendingActivations(options)[0].executionBrief.activationRequest?.userRequestId, "original-message");
    assert.equal(core.activateNextTask(options).activated, false);
    assert.equal(core.getPendingActivations(options)[0].activationKey, activation.executionBrief.activationKey);
});

test("settlement preserves unconfirmed briefs and a successful receipt stops replay", () => {
    const { options } = readyFixture();
    const activated = helpers.activateTask(options, "worker", "Deliver work", "start");
    assert.ok(activated.executionBrief);
    const key = activated.executionBrief.activationKey;
    const repeated = core.settleProject(options);
    assert.equal((repeated.pendingActivations as unknown[]).length, 1);
    const claim = core.claimActivation(options, key);
    assert.equal(claim.claimed, true);
    assert.ok(claim.claimToken);
    assert.equal(core.claimActivation(options, key).reason, "DELIVERY_UNCONFIRMED");
    assert.equal(core.confirmActivation(options, key, claim.claimToken, "app-message-1").confirmed, true);
    assert.equal(core.confirmActivation(options, key, claim.claimToken, "app-message-1").alreadyConfirmed, true);
    assert.equal(core.getPendingActivations(options).length, 0);
    assert.equal(core.claimActivation(options, key).reason, "DELIVERED");
});

test("concurrent processes allocate unique task IDs and only one delivery claim", async () => {
    const { options } = readyFixture();
    const common = ["--project-root", options.projectRoot, "--state-root", options.stateRoot];
    const registrations = await Promise.all(Array.from({ length: 6 }, (_, index) => execFile(process.execPath, [cliPath, "register", ...common, "--thread-id", `worker-${index}`, "--name", `Worker ${index}`])));
    const taskIds = registrations.map((result) => (JSON.parse(result.stdout) as { taskId: string }).taskId);
    assert.deepEqual([...taskIds].sort(), ["T0001", "T0002", "T0003", "T0004", "T0005", "T0006"]);
    core.submitEvent(options, "start", "T0001", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    const activation = core.activateNextTask(options);
    assert.ok(activation.executionBrief);
    const claims = await Promise.all(Array.from({ length: 6 }, () => execFile(process.execPath, [cliPath, "claim-activation", ...common, "--activation-key", activation.executionBrief!.activationKey])));
    assert.equal(claims.filter((result) => (JSON.parse(result.stdout) as { claimed: boolean }).claimed).length, 1);
});

test("an explicit delivery retry invalidates stale claims and is consumed once", () => {
    const { options } = readyFixture();
    const activation = helpers.activateTask(options, "worker", "Retry delivery", "start");
    assert.ok(activation.executionBrief);
    const key = activation.executionBrief.activationKey;
    const original = core.claimActivation(options, key);
    const retry = core.claimActivation(options, key, "new-direct-retry-message");
    assert.equal(retry.claimed, true);
    assert.ok(original.claimToken && retry.claimToken);
    assert.notEqual(original.claimToken, retry.claimToken);
    assert.equal(core.claimActivation(options, key, "new-direct-retry-message").claimed, false);
    assert.throws(() => core.confirmActivation(options, key, original.claimToken!, "old-receipt"), /stale confirmation/);
    assert.equal(core.confirmActivation(options, key, retry.claimToken, "verified-new-receipt").confirmed, true);
});

test("canceling a task prevents delivery of its old activation", () => {
    const { options } = readyFixture();
    const activation = helpers.activateTask(options, "worker", "Canceled delivery", "start");
    assert.ok(activation.executionBrief);
    core.submitEvent(options, "cancel", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-message" });
    core.processPendingEvents(options);
    assert.equal(core.getPendingActivations(options).length, 0);
    assert.equal(core.claimActivation(options, activation.executionBrief.activationKey).reason, "CANCELED");
});

test("doctor explains queue blockers and uncertain delivery without changing state", () => {
    const { options, databasePath } = readyFixture();
    const activation = helpers.activateTask(options, "worker", "Active task", "start");
    assert.ok(activation.executionBrief);
    helpers.registerTask(options, "waiting", "Waiting task");
    core.submitEvent(options, "dependency", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(options, "enqueue", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    core.claimActivation(options, activation.executionBrief.activationKey);
    const before = fs.readFileSync(databasePath);
    const report = core.doctorProject(options);
    assert.ok(report.checks.some((check) => check.code === "SHARED_CHECKOUT_BUSY" && check.taskId === "T0002"));
    assert.ok(report.checks.some((check) => check.code === "DEPENDENCIES_PENDING" && check.taskId === "T0002"));
    assert.ok(report.checks.some((check) => check.code === "DELIVERY_UNCONFIRMED" && check.taskId === "T0001"));
    assert.deepEqual(fs.readFileSync(databasePath), before);
    const cli = helpers.runCli(["doctor", "--project-root", options.projectRoot, "--state-root", options.stateRoot, "--task", "T0002"]);
    assert.equal(cli.status, 0, cli.stderr);
    const filtered = JSON.parse(cli.stdout) as import("../scripts/control-room-types.ts").IDoctorResult;
    assert.equal(filtered.checks.some((check) => check.taskId === "T0001"), false);
});

test("doctor reports a missing worktree and an unsafe instruction file", () => {
    const { options } = readyFixture();
    helpers.registerTask(options, "isolated", "Lost workspace");
    core.submitEvent(options, "start", "T0001", "RUN_ISOLATED_NOW_REQUESTED", {});
    core.processPendingEvents(options);
    const activation = core.activateIsolatedTask(options, "T0001");
    assert.ok(activation.executionBrief);
    helpers.runGit(options.projectRoot, ["worktree", "remove", activation.executionBrief.workspacePath]);
    assert.ok(core.doctorProject(options).checks.some((check) => check.code === "WORKSPACE_MISMATCH"));
    const agents = path.join(options.projectRoot, "AGENTS.md");
    fs.renameSync(agents, `${agents}.original`);
    fs.symlinkSync(`${agents}.original`, agents);
    assert.ok(core.doctorProject(options).checks.some((check) => check.code === "DIAGNOSTIC_FAILED" && check.message.includes("symbolic link")));
});

test("all local documentation links resolve after progressive disclosure", () => {
    const root = path.resolve(__dirname, "..");
    const documents = ["SKILL.md", "README.md", ...fs.readdirSync(path.join(root, "references")).filter((name) => name.endsWith(".md")).map((name) => `references/${name}`)];
    for (const document of documents) {
        const text = fs.readFileSync(path.join(root, document), "utf8");
        for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
            const target = match[1].split("#")[0];
            if (target && !target.includes(":") && !target.includes("<")) {
                assert.ok(fs.existsSync(path.resolve(root, path.dirname(document), target)), `${document}: missing ${target}`);
            }
        }
    }
});

test("cleanup recovery preserves a worker ref changed after worktree removal", () => {
    const { options } = readyFixture();
    helpers.registerTask(options, "isolated", "Preserve changed ref");
    core.submitEvent(options, "start", "T0001", "RUN_ISOLATED_NOW_REQUESTED", {});
    core.processPendingEvents(options);
    core.activateIsolatedTask(options, "T0001");
    helpers.approveTask(options, "T0001", "approval");
    interruptOperation(options, "T0001", ["worktree", "remove"]);
    const previous = helpers.runGit(options.projectRoot, ["rev-parse", "control-room/T0001"]);
    const tree = helpers.runGit(options.projectRoot, ["rev-parse", "control-room/T0001^{tree}"]);
    const changed = helpers.runGit(options.projectRoot, ["commit-tree", tree, "-p", previous, "-m", "Preserve intervening worker commit"]);
    helpers.runGit(options.projectRoot, ["update-ref", "refs/heads/control-room/T0001", changed, previous]);
    assert.throws(() => core.recoverCommit(options, "T0001"), /Worker branch moved before cleanup/);
    assert.equal(helpers.runGit(options.projectRoot, ["rev-parse", "control-room/T0001"]), changed);
    assert.equal(core.getStatus(options).commitTaskId, "T0001");
});

test("doctor identifies the checkout left by a canceled shared task", () => {
    const { options } = readyFixture();
    helpers.activateTask(options, "worker", "Canceled shared work", "start");
    fs.writeFileSync(path.join(options.projectRoot, "preserved.txt"), "preserve\n");
    core.submitEvent(options, "cancel", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-message" });
    core.processPendingEvents(options);
    assert.ok(core.doctorProject(options).checks.some((check) => check.code === "SHARED_CHECKOUT_UNASSIGNED"));
    assert.equal(fs.readFileSync(path.join(options.projectRoot, "preserved.txt"), "utf8"), "preserve\n");
});
