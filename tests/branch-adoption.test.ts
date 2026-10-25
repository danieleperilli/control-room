import type { IOptions } from "./helpers.ts";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");
const helpers: import("./helpers.ts").ITestHelpers = require("./helpers.ts");

/** Create an active commit-mode task with confirmed delivery. */
function fixture() {
    const repo = helpers.createFixture();
    helpers.initializeFixture(repo);
    const options: IOptions = { projectRoot: repo.repositoryRoot, stateRoot: repo.stateRoot };
    core.setIntegrationMode(options, "commit", "mode", "mode-message", "worker");
    const activation = helpers.activateTask(options, "worker", "Rename preservation", "enqueue");
    const key = activation.executionBrief!.activationKey;
    const claimed = core.claimActivation(options, key);
    core.confirmActivation(options, key, claimed.claimToken!, "delivery-receipt");
    return { ...repo, options };
}

/** A rename retains dirty files, commits, original baseline, approval mode and later task continuity. */
test("adopting a renamed branch preserves pending work and future commits", function adoptsRename(): void {
    const repo = fixture();
    helpers.runGit(repo.repositoryRoot, ["branch", "-m", "feature/renamed"]);
    fs.writeFileSync(path.join(repo.repositoryRoot, "pending.txt"), "pending work\n");
    const result = core.adoptCurrentBranch(repo.options, "T0001", "feature/renamed", "adopt", "user-rename");
    assert.equal(result.adopted, true);
    assert.equal(helpers.runGit(repo.repositoryRoot, ["branch", "--list", "control-room/codex"]), "");
    assert.equal(helpers.runGit(repo.repositoryRoot, ["rev-parse", "HEAD"]), repo.initialCommit);
    assert.equal(fs.readFileSync(path.join(repo.repositoryRoot, "pending.txt"), "utf8"), "pending work\n");
    assert.equal(core.adoptCurrentBranch(repo.options, "T0001", "feature/renamed", "adopt", "user-rename").alreadyApplied, true);
    assert.throws(() => core.adoptCurrentBranch(repo.options, "T0001", "feature/renamed", "adopt", "different-user"));
    helpers.approveTask(repo.options, "T0001", "approve", "Preserve renamed branch changes");
    const completed = core.commitApprovedTask(repo.options, "T0001");
    assert.equal(completed.task.branchName, "feature/renamed");
    assert.equal(completed.task.baseCommit, repo.initialCommit);
    assert.equal(completed.merged, false);
    assert.equal(helpers.runGit(repo.repositoryRoot, ["rev-parse", "main"]), repo.initialCommit);
    const next = helpers.activateTask(repo.options, "next", "Next behavior", "next-enqueue");
    assert.equal(next.task!.branchName, "feature/renamed");
    assert.equal(next.task!.baseCommit, completed.task.approvedCommit);
});

/** A mistakenly recreated branch must be preserved in full before restoring the intended name. */
test("adoption rejects missing commits and accepts an explicit fast-forward without deleting either ref", function retainsRecreatedBranch(): void {
    const repo = fixture();
    helpers.runGit(repo.repositoryRoot, ["branch", "intended"]);
    fs.writeFileSync(path.join(repo.repositoryRoot, "approved.txt"), "approved work\n");
    helpers.runGit(repo.repositoryRoot, ["add", "."]);
    helpers.runGit(repo.repositoryRoot, ["commit", "-m", "Existing approved work"]);
    const approved = helpers.runGit(repo.repositoryRoot, ["rev-parse", "HEAD"]);
    helpers.runGit(repo.repositoryRoot, ["checkout", "intended"]);
    assert.throws(() => core.adoptCurrentBranch(repo.options, "T0001", "intended", "adopt", "user-restore"), /all commits/u);
    helpers.runGit(repo.repositoryRoot, ["merge", "--ff-only", "control-room/codex"]);
    core.submitEvent(repo.options, "review", "T0001", "REVIEW_REQUESTED", { summary: "Verified" });
    core.processPendingEvents(repo.options);
    const result = helpers.runCli(["adopt-branch", "--project-root", repo.repositoryRoot, "--state-root", repo.stateRoot, "--task", "T0001", "--branch", "intended", "--event-key", "adopt", "--user-request-id", "user-restore"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).task.state, "REVIEW");
    for (const ref of ["HEAD", "intended", "control-room/codex"]) assert.equal(helpers.runGit(repo.repositoryRoot, ["rev-parse", ref]), approved);
    assert.equal(core.doctorProject(repo.options, "T0001").checks.some((check) => check.code === "WORKSPACE_MISMATCH"), false);
});

/** Restrict registration changes to authorized active commit-mode work before approval. */
test("adoption rejects main, wrong mode, unconfirmed delivery and pending approval", function enforcesBoundaries(): void {
    const repo = fixture();
    helpers.runGit(repo.repositoryRoot, ["checkout", "main"]);
    assert.throws(() => core.adoptCurrentBranch(repo.options, "T0001", "main", "main", "message"));
    helpers.runGit(repo.repositoryRoot, ["checkout", "control-room/codex"]);
    helpers.runGit(repo.repositoryRoot, ["branch", "-m", "renamed"]);
    core.setIntegrationMode(repo.options, "merge", "merge", "mode-message", "worker");
    assert.throws(() => core.adoptCurrentBranch(repo.options, "T0001", "renamed", "wrong-mode", "message"));
    core.setIntegrationMode(repo.options, "commit", "commit-again", "mode-message", "worker");
    core.submitEvent(repo.options, "approve", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Preserve authorized work", userRequestId: "approval-message" });
    assert.throws(() => core.adoptCurrentBranch(repo.options, "T0001", "renamed", "pending", "message"), /pending task events/u);
    core.processPendingEvents(repo.options);
    assert.throws(() => core.adoptCurrentBranch(repo.options, "T0001", "renamed", "approved", "message"));
    const other = helpers.createFixture();
    helpers.initializeFixture(other);
    const options = { projectRoot: other.repositoryRoot, stateRoot: other.stateRoot };
    core.setIntegrationMode(options, "commit", "mode", "message", "worker");
    helpers.activateTask(options, "worker", "Pending delivery", "enqueue");
    helpers.runGit(other.repositoryRoot, ["branch", "-m", "renamed"]);
    assert.throws(() => core.adoptCurrentBranch(options, "T0001", "renamed", "pending-delivery", "message"), /activation delivery/u);
    assert.equal(helpers.runCli(["adopt-branch", "--project-root", other.repositoryRoot, "--state-root", other.stateRoot, "--task", "T0001", "--branch", "renamed", "--event-key", "no-user"]).status, 1);
});
