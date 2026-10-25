import type { ISerializedTask } from "../scripts/control-room-types.ts";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");
const helpers: import("./helpers.ts").ITestHelpers = require("./helpers.ts");

/** Creates an unchanged shared worker. @param delivery Requested delivery state. */
function stoppedFixture(delivery: "PENDING" | "CLAIMED" | "DELIVERED" = "DELIVERED") {
    const fixture = helpers.createFixture();
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    helpers.initializeFixture(fixture);
    core.installProjectRouting(options);
    core.installWorktreeIgnore(options);
    helpers.runGit(options.projectRoot, ["add", "-A"]);
    helpers.runGit(options.projectRoot, ["commit", "-m", "Install fixture routing"]);
    const activation = helpers.activateTask(options, "stopped", "Stopped work", "start");
    const key = activation.executionBrief!.activationKey;
    if (delivery !== "PENDING") {
        const claim = core.claimActivation(options, key);
        if (delivery === "DELIVERED") { core.confirmActivation(options, key, claim.claimToken!, "app-delivery"); }
    }
    return { options, key, base: activation.executionBrief!.baseCommit };
}

test("releases only explicitly stopped unchanged work and starts the requested predecessor", () => {
    const { options, key, base } = stoppedFixture();
    helpers.registerTask(options, "resumed", "Resumed work");
    assert.throws(() => core.submitEvent(options, "missing", "T0001", "PLANNING_REQUESTED", {}));
    assert.throws(() => core.submitEvent(options, "missing-id", "T0001", "PLANNING_REQUESTED", { stoppedActivationKey: key }));
    const payload = { stoppedActivationKey: key, userRequestId: "direct-stop" };
    core.submitEvent(options, "release", "T0001", "PLANNING_REQUESTED", payload);
    core.submitEvent(options, "resume", "T0002", "RUN_NOW_REQUESTED", { userRequestId: "direct-resume" });
    core.settleProject(options);
    const stopped = core.getStatus(options, "T0001").task as ISerializedTask;
    assert.equal(stopped.state, "PLANNING");
    assert.equal(stopped.branchName, null);
    assert.equal(stopped.approvedCommit, null);
    assert.equal((core.getStatus(options, "T0002").task as ISerializedTask).state, "RUNNING");
    assert.equal(helpers.runGit(options.projectRoot, ["rev-parse", "main"]), base);
    assert.equal(helpers.runGit(options.projectRoot, ["branch", "--list", "control-room/T0001"]), "");
    assert.equal(core.submitEvent(options, "release", "T0001", "PLANNING_REQUESTED", payload).processed, true);
});

for (const change of ["dirty", "commit", "base", "stale-key"] as const) {
    test(`preserves stopped work with ${change}`, () => {
        const { options, key } = stoppedFixture();
        core.submitEvent(options, "release", "T0001", "PLANNING_REQUESTED", { stoppedActivationKey: change === "stale-key" ? "old-key" : key, userRequestId: "direct-stop" });
        if (change === "dirty" || change === "commit" || change === "base") {
            if (change === "base") { helpers.runGit(options.projectRoot, ["checkout", "main"]); }
            fs.writeFileSync(path.join(options.projectRoot, "keep.txt"), "preserve\n");
            if (change !== "dirty") {
                helpers.runGit(options.projectRoot, ["add", "keep.txt"]);
                helpers.runGit(options.projectRoot, ["commit", "-m", "Preserve changed work"]);
            }
        }
        const result = core.processPendingEvents(options);
        assert.equal((result.results as Array<{ action: string }>)[0].action, "REJECTED");
        assert.equal((core.getStatus(options, "T0001").task as ISerializedTask).state, "RUNNING");
        assert.ok(helpers.runGit(options.projectRoot, ["branch", "--list", "control-room/T0001"]));
        if (change !== "stale-key") { assert.equal(fs.readFileSync(path.join(options.projectRoot, "keep.txt"), "utf8"), "preserve\n"); }
    });
}

for (const delivery of ["PENDING", "CLAIMED"] as const) {
    test(`refuses release of ${delivery} delivery`, () => {
        const { options, key } = stoppedFixture(delivery);
        core.submitEvent(options, "release", "T0001", "PLANNING_REQUESTED", { stoppedActivationKey: key, userRequestId: "direct-stop" });
        const result = core.processPendingEvents(options);
        assert.equal((result.results as Array<{ action: string }>)[0].action, "REJECTED");
        assert.equal((core.getStatus(options, "T0001").task as ISerializedTask).state, "RUNNING");
    });
}
for (const prefix of [["checkout", "main"], ["branch", "-d"]]) {
    test(`recovers stopped release after ${prefix.join(" ")}`, () => {
        const { options, key } = stoppedFixture();
        core.submitEvent(options, "release", "T0001", "PLANNING_REQUESTED", { stoppedActivationKey: key, userRequestId: "direct-stop" });
        const program = `const cp = require("node:child_process"); const original = cp.spawnSync; const prefix = ${JSON.stringify(prefix)}; cp.spawnSync = function(...args) { const result = original.apply(this, args); if (result.status === 0 && String(args[0]).endsWith("git") && prefix.every((v, i) => args[1][i] === v)) { process.kill(process.pid, "SIGKILL"); } return result; }; require(${JSON.stringify(path.join(__dirname, "..", "scripts", "control-room-core.ts"))}).processPendingEvents(${JSON.stringify(options)});`;
        const crashed = childProcess.spawnSync(process.execPath, ["-e", program], { encoding: "utf8" });
        assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
        core.settleProject(options);
        assert.equal((core.getStatus(options, "T0001").task as ISerializedTask).state, "PLANNING");
        assert.equal(helpers.runGit(options.projectRoot, ["branch", "--show-current"]), "main");
        assert.equal(helpers.runGit(options.projectRoot, ["branch", "--list", "control-room/T0001"]), "");
    });
}
