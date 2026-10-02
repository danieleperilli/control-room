import type { IControlRoomOptions } from "../scripts/control-room-types.ts";
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");
const { syncPullRequests }: import("../scripts/control-room-pr.ts").IPullRequestApi = require("../scripts/control-room-pr.ts");
const helpers: import("./helpers.ts").ITestHelpers = require("./helpers.ts");
const originalSpawn = childProcess.spawnSync;

interface IRemotePr {
    number: number;
    url: string;
    state: "OPEN" | "MERGED" | "CLOSED";
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    isCrossRepository: boolean;
    mergeCommit: { oid: string } | null;
}

interface IPrFixture {
    repositoryRoot: string;
    remoteRoot: string;
    initialCommit: string;
    databasePath: string;
    options: IControlRoomOptions;
    prs: IRemotePr[];
    calls: string[][];
    failCreateReceipt: boolean;
    failAuthentication: boolean;
    failPushReceipt: boolean;
    failCommitReceipt: boolean;
    failCheckoutReceipt: boolean;
    provider: "github" | "azure-devops";
    invalidJson: boolean;
}

/** Restore the process boundary mock after each independent test. */
test.afterEach(() => {
    childProcess.spawnSync = originalSpawn;
});

/**
 * Create real local Git repositories with a simulated PR provider boundary.
 * @param provider Remote PR service used by the fixture.
 * @param origin Optional clone URL whose normalization is under test.
 */
function createPrFixture(provider: "github" | "azure-devops" = "github", origin?: string): IPrFixture {
    const fixture = helpers.createFixture();
    fs.writeFileSync(path.join(fixture.repositoryRoot, ".gitignore"), ".control-room/\n");
    helpers.runGit(fixture.repositoryRoot, ["add", ".gitignore"]);
    helpers.runGit(fixture.repositoryRoot, ["commit", "-m", "Ignore fixture coordination state"]);
    fixture.initialCommit = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const databasePath = helpers.initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const remoteRoot = path.join(path.dirname(fixture.repositoryRoot), "remote.git");
    helpers.runGit(fixture.repositoryRoot, ["init", "--bare", remoteRoot]);
    helpers.runGit(fixture.repositoryRoot, ["push", remoteRoot, "main:refs/heads/main"]);
    helpers.runGit(fixture.repositoryRoot, ["remote", "add", "origin", origin || (provider === "github" ? "git@github.com:fixture/project.git" : "https://fixture@dev.azure.com/fixture/project/_git/repository")]);
    const state: IPrFixture = { ...fixture, databasePath, options, remoteRoot, prs: [], calls: [], failCreateReceipt: false, failAuthentication: false, failPushReceipt: false, failCommitReceipt: false, failCheckoutReceipt: false, provider, invalidJson: false };
    /**
     * Simulate provider responses and route network Git to the disposable bare repository.
     * @param command Executable requested by production code.
     * @param argumentsList Unmodified argument boundaries.
     * @param spawnOptions Process options supplied by production code.
     */
    childProcess.spawnSync = ((command: string, argumentsList: string[], spawnOptions: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {
        if (command === "git" && ["push", "fetch"].includes(argumentsList[0]) && argumentsList.includes("origin")) {
            state.calls.push([...argumentsList]);
            const actual = originalSpawn(command, argumentsList.map((argument) => argument === "origin" ? remoteRoot : argument), spawnOptions);
            if (argumentsList[0] === "push" && state.failPushReceipt) {
                state.failPushReceipt = false;
                return { ...actual, status: 1, stderr: "Lost push response" };
            }
            return actual;
        }
        if (command !== "gh" && command !== "az") {
            const result = originalSpawn(command, argumentsList, spawnOptions);
            if (command === "git" && ((argumentsList[0] === "commit" && state.failCommitReceipt) || (argumentsList[0] === "checkout" && argumentsList[1] === "main" && state.failCheckoutReceipt))) {
                state.failCommitReceipt = false;
                state.failCheckoutReceipt = false;
                return { ...result, status: 1, stderr: "Lost Git response" };
            }
            return result;
        }
        state.calls.push([...argumentsList]);
        assert.equal(spawnOptions.shell, false);
        const success = { pid: 1, output: [], stdout: "", stderr: "", status: 0, signal: null };
        if (state.invalidJson && argumentsList[0] !== "auth") return { ...success, stdout: "fictional-secret-provider-output" };
        if (command === "az") {
            assert.equal(state.provider, "azure-devops");
            assert.equal(spawnOptions.env!.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, "no");
            assert.equal(argumentsList[argumentsList.indexOf("--organization") + 1], "https://dev.azure.com/fixture");
            assert.equal(argumentsList[argumentsList.indexOf("--detect") + 1], "false");
            if (argumentsList[1] === "show") {
                return state.failAuthentication ? { ...success, status: 1, stderr: "Sensitive authentication output" } : { ...success, stdout: JSON.stringify({ remoteUrl: "https://fixture@dev.azure.com/fixture/project/_git/repository" }) };
            }
            if (argumentsList[2] === "list") {
                const head = argumentsList[argumentsList.indexOf("--source-branch") + 1];
                return { ...success, stdout: JSON.stringify(state.prs.filter((pr) => pr.headRefName === head).map(azurePrPayload)) };
            }
            if (argumentsList[2] === "create") {
                const branch = argumentsList[argumentsList.indexOf("--source-branch") + 1];
                const base = argumentsList[argumentsList.indexOf("--target-branch") + 1];
                const number = state.prs.length + 1;
                const pr: IRemotePr = { number, url: `https://dev.azure.com/fixture/project/_git/repository/pullrequest/${number}`, state: "OPEN", headRefName: branch, headRefOid: helpers.runGit(fixture.repositoryRoot, ["rev-parse", branch]), baseRefName: base, isCrossRepository: false, mergeCommit: null };
                state.prs.push(pr);
                assert.ok(argumentsList[argumentsList.indexOf("--description") + 1].includes("\n"));
                assert.equal(argumentsList[argumentsList.indexOf("--auto-complete") + 1], "false");
                if (state.failCreateReceipt) {
                    state.failCreateReceipt = false;
                    return { ...success, status: 1 };
                }
                return { ...success, stdout: JSON.stringify(azurePrPayload(pr)) };
            }
            const pr = state.prs.find((candidate) => candidate.number === Number(argumentsList[argumentsList.indexOf("--id") + 1]));
            assert.ok(pr);
            return { ...success, stdout: JSON.stringify(azurePrPayload(pr)) };
        }
        assert.equal(state.provider, "github");
        if (argumentsList[0] === "auth") {
            return state.failAuthentication ? { ...success, status: 1, stderr: "Sensitive authentication output" } : success;
        }
        if (argumentsList[1] === "list") {
            const head = argumentsList[argumentsList.indexOf("--head") + 1];
            return { ...success, stdout: JSON.stringify(state.prs.filter((pr) => pr.headRefName === head)) };
        }
        if (argumentsList[1] === "create") {
            const branch = argumentsList[argumentsList.indexOf("--head") + 1];
            const base = argumentsList[argumentsList.indexOf("--base") + 1];
            const number = state.prs.length + 1;
            const pr: IRemotePr = { number, url: `https://github.com/fixture/project/pull/${number}`, state: "OPEN", headRefName: branch, headRefOid: helpers.runGit(fixture.repositoryRoot, ["rev-parse", branch]), baseRefName: base, isCrossRepository: false, mergeCommit: null };
            state.prs.push(pr);
            assert.ok(fs.readFileSync(argumentsList[argumentsList.indexOf("--body-file") + 1], "utf8").length > 0);
            if (state.failCreateReceipt) {
                state.failCreateReceipt = false;
                return { ...success, status: 1 };
            }
            return { ...success, stdout: `${pr.url}\n` };
        }
        const pr = state.prs.find((candidate) => candidate.url === argumentsList[2]);
        assert.ok(pr, `Unexpected GitHub CLI operation: ${argumentsList.join(" ")}`);
        return { ...success, stdout: JSON.stringify(pr) };
    }) as typeof childProcess.spawnSync;
    core.setIntegrationMode(options, "pr", "select-pr", "select-pr-message", "mode-side-chat");
    return state;
}

/**
 * Serialize independent Azure DevOps response fields from a simulated remote PR.
 * @param pr PR persisted by the fake remote service.
 */
function azurePrPayload(pr: IRemotePr): Record<string, unknown> {
    return { pullRequestId: pr.number, status: pr.state === "OPEN" ? "active" : pr.state === "MERGED" ? "completed" : "abandoned", sourceRefName: `refs/heads/${pr.headRefName}`, targetRefName: `refs/heads/${pr.baseRefName}`, repository: { remoteUrl: pr.url.replace(/\/pullrequest\/\d+$/u, "") }, forkSource: pr.isCrossRepository ? { repository: { id: "different-repository" } } : null, lastMergeSourceCommit: { commitId: pr.headRefOid }, lastMergeCommit: pr.mergeCommit ? { commitId: pr.mergeCommit.oid } : null };
}

/**
 * Activate and approve one changed shared task.
 * @param fixture Local Git and simulated provider state.
 */
function approveChangedTask(fixture: IPrFixture): void {
    helpers.activateTask(fixture.options as import("./helpers.ts").IOptions, "worker-one", "Implement fixture behavior", "enqueue-one");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "feature.txt"), "approved behavior\n");
    helpers.approveTask(fixture.options as import("./helpers.ts").IOptions, "T0001", "approve-one", "Implement fixture behavior changes");
}

/**
 * Simulate a server-side squash merge into the remote main branch.
 * @param fixture Local Git and simulated provider state.
 */
function mergeRemotePr(fixture: IPrFixture): string {
    const pr = fixture.prs[0];
    const tree = helpers.runGit(fixture.repositoryRoot, ["rev-parse", `${pr.headRefOid}^{tree}`]);
    const merged = helpers.runGit(fixture.repositoryRoot, ["commit-tree", tree, "-p", fixture.initialCommit, "-m", "Merge fixture PR"]);
    helpers.runGit(fixture.repositoryRoot, ["push", fixture.remoteRoot, `${merged}:refs/heads/main`]);
    pr.state = "MERGED";
    pr.mergeCommit = { oid: merged };
    return merged;
}

test("project modes persist without registering callers and old retries retain the current selection", () => {
    const fixture = helpers.createFixture();
    helpers.initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    assert.equal(core.getStatus(options).integrationMode, "merge");
    core.excludeTask(options, "excluded-side-chat", "User preference");
    core.setIntegrationMode(options, "pr", "pr-command", "pr-message", "excluded-side-chat");
    assert.equal(core.getStatus(options, undefined, "excluded-side-chat").role, "EXCLUDED");
    core.setIntegrationMode(options, "merge", "merge-command", "merge-message", "other-chat");
    assert.equal(core.setIntegrationMode(options, "pr", "pr-command", "pr-message", "excluded-side-chat").integrationMode, "merge");
    assert.equal(core.getStatus(options).nextTaskId, "T0001");
    assert.throws(() => core.setIntegrationMode(options, "merge", "pr-command", "pr-message", "excluded-side-chat"), /different content/u);
    const before = fs.readFileSync(fixture.repositoryRoot + "/base.txt", "utf8");
    const status = helpers.runCli(["mode", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--mode", "status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).integrationMode, "merge");
    assert.equal(fs.readFileSync(fixture.repositoryRoot + "/base.txt", "utf8"), before);
});

test("approval snapshots PR mode before settlement and never integrates its worker locally", () => {
    const fixture = createPrFixture();
    helpers.activateTask(fixture.options as import("./helpers.ts").IOptions, "worker-one", "Implement fixture behavior", "enqueue-one");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "feature.txt"), "approved behavior\n");
    core.submitEvent(fixture.options, "approve-one-approve", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Implement fixture behavior changes", userRequestId: "approve-one-user-message" });
    core.setIntegrationMode(fixture.options, "merge", "switch-after-approval", "switch-message", "other-chat");
    core.submitEvent(fixture.options, "approve-one-approve", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Implement fixture behavior changes", userRequestId: "approve-one-user-message" });
    const result = core.settleProject(fixture.options) as any;
    assert.equal(result.completion.task.state, "PR_OPEN");
    assert.equal(result.completion.task.integrationMode, "pr");
    assert.equal(result.completion.pullRequestUrl, fixture.prs[0].url);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]), fixture.prs[0].headRefOid);
    assert.equal(fixture.calls.filter((call) => call[0] === "push").length, 1);
    assert.ok(fixture.calls.find((call) => call[0] === "push")!.at(-1)!.endsWith(":refs/heads/control-room/T0001"));
    assert.equal(core.settleProject(fixture.options).completions instanceof Array, true);
    assert.equal(fixture.prs.length, 1);
    assert.equal(core.getStatus(fixture.options).integrationMode, "merge");
});

test("open PRs hold all queued tasks until remote merge and base synchronization", () => {
    const fixture = createPrFixture();
    approveChangedTask(fixture);
    helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "dependent", "Dependent behavior");
    helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "independent", "Independent behavior");
    core.submitEvent(fixture.options, "depend", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(fixture.options, "enqueue-dependent", "T0002", "ENQUEUE_REQUESTED", {});
    core.submitEvent(fixture.options, "enqueue-independent", "T0003", "ENQUEUE_REQUESTED", {});
    const opened = core.settleProject(fixture.options) as any;
    assert.equal(opened.activation.activated, false);
    assert.equal(opened.activation.reason, "PR_MERGE_PENDING");
    assert.equal(core.activateNextTask(fixture.options).reason, "PR_MERGE_PENDING");
    assert.equal(core.getStatus(fixture.options, "T0002").task && (core.getStatus(fixture.options, "T0002").task as any).state, "QUEUED");
    assert.equal((core.getStatus(fixture.options, "T0003").task as any).state, "QUEUED");
    const merged = mergeRemotePr(fixture);
    const synchronized = syncPullRequests(fixture.options);
    assert.equal(synchronized.warnings.length, 0);
    assert.equal(synchronized.tasks[0].task.state, "DONE");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), merged);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), merged);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--list", "control-room/T0001"]), "");
    const next = core.settleProject(fixture.options) as any;
    assert.equal(next.activation.task.taskId, "T0002");
    assert.equal(next.activation.task.baseCommit, merged);
});

test("merged PR synchronization activates a waiting dependent and supports squash history", () => {
    const fixture = createPrFixture();
    approveChangedTask(fixture);
    helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "dependent", "Dependent behavior");
    core.submitEvent(fixture.options, "depend", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(fixture.options, "enqueue-dependent", "T0002", "ENQUEUE_REQUESTED", {});
    core.settleProject(fixture.options);
    const merged = mergeRemotePr(fixture);
    const result = core.settleProject(fixture.options) as any;
    assert.equal(result.completions[0].task.state, "DONE");
    assert.equal(result.activation.task.taskId, "T0002");
    assert.equal(result.activation.task.baseCommit, merged);
});

for (const provider of ["github", "azure-devops"] as const) {
    test(`${provider} PR gates explicit isolated activation until synchronization succeeds`, () => {
        const fixture = createPrFixture(provider);
        approveChangedTask(fixture);
        core.settleProject(fixture.options);
        helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "isolated", "Next isolated behavior");
        core.submitEvent(fixture.options, "run-next-isolated", "T0002", "RUN_ISOLATED_NOW_REQUESTED", { userRequestId: "run-isolated-message" });
        const waiting = core.settleProject(fixture.options) as any;
        assert.equal(waiting.isolatedActivations[0].reason, "PR_MERGE_PENDING");
        assert.equal(fs.existsSync(path.join(fixture.repositoryRoot, ".control-room", "worktrees", "T0002")), false);
        const merged = mergeRemotePr(fixture);
        const released = core.settleProject(fixture.options) as any;
        assert.equal(released.isolatedActivations[0].task.baseCommit, merged);
        assert.equal(helpers.runGit(released.isolatedActivations[0].task.worktreePath, ["rev-parse", "HEAD"]), merged);
    });
}

test("PR approval after commit-mode activation preserves the adopted branch after merge", () => {
    const fixture = createPrFixture();
    core.setIntegrationMode(fixture.options, "commit", "commit-mode", "commit-mode-message", "side-chat");
    helpers.activateTask(fixture.options as import("./helpers.ts").IOptions, "worker", "Adopted behavior", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "feature.txt"), "adopted behavior\n");
    core.setIntegrationMode(fixture.options, "pr", "pr-mode", "pr-mode-message", "side-chat");
    helpers.approveTask(fixture.options as import("./helpers.ts").IOptions, "T0001", "approve", "Publish adopted behavior");
    core.settleProject(fixture.options);
    const approved = fixture.prs[0].headRefOid;
    assert.equal(fixture.prs[0].headRefName, "control-room/codex");
    mergeRemotePr(fixture);
    const synced = syncPullRequests(fixture.options);
    assert.equal(synced.tasks[0].task.state, "DONE");
    assert.equal(synced.tasks[0].branchDeleted, false);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/codex"]), approved);
});

for (const provider of ["github", "azure-devops"] as const) {
    for (const failure of ["failCreateReceipt", "failPushReceipt", "failCommitReceipt", "failCheckoutReceipt"] as const) {
        test(`${provider} recovery preserves approval after ${failure} without duplicate commits or PRs`, () => {
            const fixture = createPrFixture(provider);
            approveChangedTask(fixture);
            fixture[failure] = true;
            assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"));
            const commit = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]);
            core.setIntegrationMode(fixture.options, "merge", "switch-during-recovery", "switch-message", "other-chat");
            const recovered = core.recoverCommit(fixture.options, "T0001");
            assert.equal(recovered.task.state, "PR_OPEN");
            assert.equal(recovered.task.approvedCommit, commit);
            assert.equal(fixture.prs.length, 1);
            assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
            assert.equal(core.getStatus(fixture.options).commitTaskId, null);
            helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "next-worker", "Next behavior");
            core.submitEvent(fixture.options, "enqueue-next", "T0002", "ENQUEUE_REQUESTED", {});
            const held = core.settleProject(fixture.options) as any;
            assert.equal(held.activation.reason, "PR_MERGE_PENDING");
            assert.equal((core.getStatus(fixture.options, "T0002").task as any).state, "QUEUED");
        });
    }

    test(`${provider} authentication failures preserve uncommitted work before acquiring an approval lease`, () => {
        const fixture = createPrFixture(provider);
        approveChangedTask(fixture);
        fixture.failAuthentication = true;
        assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"), (error: Error) => /authentication/u.test(error.message) && !error.message.includes("Sensitive"));
        assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
        assert.equal(core.getStatus(fixture.options).commitTaskId, null);
        assert.ok(helpers.runGit(fixture.repositoryRoot, ["status", "--porcelain"]).includes("feature.txt"));
        assert.equal(fixture.prs.length, 0);
    });

    for (const problem of ["closed", "changed-head", "wrong-repository", "fork", "wrong-base", "divergent-base", "dirty-base", "dirty-worker", "other-worktree"] as const) {
        test(`${provider} PR synchronization preserves work and dependencies for ${problem}`, () => {
            const fixture = createPrFixture(provider);
            approveChangedTask(fixture);
            core.settleProject(fixture.options);
            const worker = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]);
            if (problem === "closed") fixture.prs[0].state = "CLOSED";
            if (problem === "changed-head") fixture.prs[0].headRefOid = fixture.initialCommit;
            if (problem === "wrong-repository") fixture.prs[0].url = provider === "github" ? "https://github.com/other/project/pull/1" : "https://dev.azure.com/fixture/project/_git/other/pullrequest/1";
            if (problem === "fork") fixture.prs[0].isCrossRepository = true;
            if (problem === "wrong-base") fixture.prs[0].baseRefName = "another-base";
            if (["divergent-base", "dirty-base", "dirty-worker", "other-worktree"].includes(problem)) {
                mergeRemotePr(fixture);
                if (problem === "divergent-base") {
                    fs.writeFileSync(path.join(fixture.repositoryRoot, "local.txt"), "local base commit\n");
                    helpers.runGit(fixture.repositoryRoot, ["add", "local.txt"]);
                    helpers.runGit(fixture.repositoryRoot, ["commit", "-m", "Preserve local base change"]);
                } else if (problem === "dirty-base") {
                    fs.writeFileSync(path.join(fixture.repositoryRoot, "base.txt"), "dirty base\n");
                } else if (problem === "dirty-worker") {
                    helpers.runGit(fixture.repositoryRoot, ["checkout", "control-room/T0001"]);
                    fs.writeFileSync(path.join(fixture.repositoryRoot, "feature.txt"), "new worker changes\n");
                } else {
                    helpers.runGit(fixture.repositoryRoot, ["worktree", "add", path.join(path.dirname(fixture.repositoryRoot), "review-checkout"), "control-room/T0001"]);
                }
            }
            const sync = syncPullRequests(fixture.options);
            assert.equal(sync.tasks.length, 0);
            assert.equal(sync.warnings.length, 1);
            assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, "PR_OPEN");
            assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]), worker);
            assert.equal(core.getStatus(fixture.options).commitTaskId, null);
            helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "next-worker", "Next behavior");
            core.submitEvent(fixture.options, "enqueue-next", "T0002", "ENQUEUE_REQUESTED", {});
            const held = core.settleProject(fixture.options) as any;
            assert.equal(held.activation.reason, "PR_MERGE_PENDING");
            assert.equal((core.getStatus(fixture.options, "T0002").task as any).state, "QUEUED");
        });
    }
}

test("isolated PR worktrees remain until merge and approve-and-pause preserves its final target", () => {
    const fixture = createPrFixture();
    helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "isolated", "Isolated behavior");
    core.submitEvent(fixture.options, "run-isolated", "T0001", "RUN_ISOLATED_NOW_REQUESTED", {});
    const running = core.settleProject(fixture.options) as any;
    const workspace = running.isolatedActivations[0].executionBrief.workspacePath;
    fs.writeFileSync(path.join(workspace, "feature.txt"), "isolated changes\n");
    core.submitEvent(fixture.options, "approve-isolated", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Add isolated fixture behavior", userRequestId: "approve-message", approvalTarget: "PAUSED" });
    const opened = core.settleProject(fixture.options) as any;
    assert.equal(opened.completion.task.state, "PR_OPEN");
    assert.equal(fs.existsSync(workspace), true);
    mergeRemotePr(fixture);
    const sync = syncPullRequests(fixture.options);
    assert.equal(sync.tasks[0].task.state, "PAUSED");
    assert.equal(fs.existsSync(workspace), false);
    assert.equal(core.resumeTask(fixture.options, "T0001").resumed, true);
});

test("autopilot approval uses PR mode without merging or publishing to the base branch", () => {
    const fixture = createPrFixture();
    helpers.activateTask(fixture.options as import("./helpers.ts").IOptions, "worker", "Automatic behavior", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "feature.txt"), "automatic changes\n");
    core.submitEvent(fixture.options, "review", "T0001", "REVIEW_REQUESTED", { summary: "Behavior verified" });
    core.processPendingEvents(fixture.options);
    core.setAutopilot(fixture.options, true, "auto-on", "auto-message", "auto-chat");
    core.submitEvent(fixture.options, "automatic-approval", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Add automatic fixture behavior", autopilotEventKey: "auto-on", reviewEventKey: "review", verification: "Fixture behavior checks passed" });
    const result = core.settleProject(fixture.options) as any;
    assert.equal(result.completion.task.state, "PR_OPEN");
    assert.equal(fixture.prs.length, 1);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
});

test("schema migration preserves task relationships, pending delivery and approval metadata", () => {
    const fixture = helpers.createFixture();
    const databasePath = helpers.initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    helpers.activateTask(options, "worker", "Existing approval", "enqueue");
    fs.writeFileSync(path.join(fixture.repositoryRoot, "feature.txt"), "pending work\n");
    helpers.approveTask(options, "T0001", "existing", "Preserve existing approved behavior");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE projects DROP COLUMN integration_mode; ALTER TABLE tasks DROP COLUMN integration_mode; ALTER TABLE tasks DROP COLUMN pr_url; ALTER TABLE tasks DROP COLUMN pr_repository; DROP TABLE integration_mode_requests");
    const previousSchema = String(database.prepare("SELECT sql FROM sqlite_master WHERE name = 'tasks'").get()!.sql).replace(/^CREATE TABLE\s+(?:"tasks"|tasks)/u, "CREATE TABLE tasks_before_pr").replace("'PR_OPEN', ", "");
    database.exec(previousSchema);
    database.exec("INSERT INTO tasks_before_pr SELECT * FROM tasks; DROP TABLE tasks; ALTER TABLE tasks_before_pr RENAME TO tasks; PRAGMA user_version = 19");
    database.close();
    assert.equal(core.getStatus(options).reason, "MIGRATION_REQUIRED");
    core.installProjectRouting(options);
    assert.equal(core.getStatus(options).integrationMode, "merge");
    assert.equal((core.getStatus(options, "T0001").task as any).integrationMode, "merge");
    const migrated = new DatabaseSync(databasePath);
    assert.equal(migrated.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM activation_deliveries").get()!.count, 1);
    migrated.close();
    assert.equal(core.settleProject(options).completion && (core.getStatus(options, "T0001").task as any).state, "DONE");
});

test("unchanged PR-mode approvals complete without authentication, commits or publication", () => {
    const fixture = createPrFixture();
    helpers.activateTask(fixture.options as import("./helpers.ts").IOptions, "worker", "Inspect fixture behavior", "enqueue");
    core.submitEvent(fixture.options, "approve-clean", "T0001", "APPROVAL_REQUESTED", { commitMessage: "Complete fixture behavior inspection", userRequestId: "approve-clean-message" });
    fixture.failAuthentication = true;
    const result = core.settleProject(fixture.options) as any;
    assert.equal(result.completion.task.state, "DONE");
    assert.equal(result.completion.committed, false);
    assert.equal(fixture.prs.length, 0);
    assert.equal(fixture.calls.length, 0);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
});

test("PR mode rejects base-branch approval and differing push origins before committing", () => {
    const fixture = createPrFixture();
    approveChangedTask(fixture);
    helpers.runGit(fixture.repositoryRoot, ["config", "remote.origin.pushurl", "git@github.com:other/project.git"]);
    assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"), /same single origin/u);
    helpers.runGit(fixture.repositoryRoot, ["config", "--unset", "remote.origin.pushurl"]);
    helpers.runGit(fixture.repositoryRoot, ["checkout", "main"]);
    assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"), /recorded worker branch/u);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(core.getStatus(fixture.options).commitTaskId, null);
});

test("a stored PR URL outside its recorded repository is rejected before any PR request", () => {
    const fixture = createPrFixture();
    approveChangedTask(fixture);
    core.settleProject(fixture.options);
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE tasks SET pr_url = ? WHERE task_id = 'T0001'").run("https://unexpected.invalid/fixture/project/pull/1");
    database.close();
    const callsBefore = fixture.calls.filter((call) => call[0] === "pr").length;
    const result = syncPullRequests(fixture.options);
    assert.equal(result.warnings.length, 1);
    assert.equal(fixture.calls.filter((call) => call[0] === "pr").length, callsBefore);
    assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, "PR_OPEN");
});

test("canceling a published task preserves its PR, commit and dependent blocker", () => {
    const fixture = createPrFixture();
    approveChangedTask(fixture);
    core.settleProject(fixture.options);
    const commit = fixture.prs[0].headRefOid;
    core.submitEvent(fixture.options, "cancel-published", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-message" });
    core.settleProject(fixture.options);
    assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, "CANCELED");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]), commit);
    assert.equal(fixture.prs[0].state, "OPEN");
    assert.equal(fixture.calls.filter((call) => call[0] === "pr" && ["close", "merge", "edit"].includes(call[1])).length, 0);
});

test("current mode does not create state and mode selection through the CLI requires user provenance", () => {
    const fixture = helpers.createFixture();
    const argumentsList = ["--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot];
    const absent = helpers.runCli(["mode", ...argumentsList, "--mode", "status"]);
    assert.equal(absent.status, 0);
    assert.equal(JSON.parse(absent.stdout).reason, "NOT_INITIALIZED");
    assert.equal(fs.existsSync(fixture.stateRoot), false);
    helpers.initializeFixture(fixture);
    const missingProvenance = helpers.runCli(["mode", ...argumentsList, "--mode", "pr"]);
    assert.notEqual(missingProvenance.status, 0);
    const selected = helpers.runCli(["mode", ...argumentsList, "--mode", "pr", "--event-key", "mode-command", "--user-request-id", "mode-message", "--thread-id", "mode-chat"]);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(JSON.parse(selected.stdout).integrationMode, "pr");
});

test("Azure DevOps publication pins repository, branches and approved commit and synchronizes a squash merge", () => {
    const fixture = createPrFixture("azure-devops");
    approveChangedTask(fixture);
    const opened = core.settleProject(fixture.options) as any;
    const task = opened.completion.task;
    assert.equal(task.state, "PR_OPEN");
    const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT pr_repository FROM tasks WHERE task_id = 'T0001'").get()!.pr_repository, "https://dev.azure.com/fixture/project/_git/repository");
    database.close();
    assert.equal(opened.completion.pullRequestUrl, fixture.prs[0].url);
    assert.equal(helpers.runGit(fixture.remoteRoot, ["rev-parse", "main"]), fixture.initialCommit);
    assert.equal(helpers.runGit(fixture.remoteRoot, ["rev-parse", "control-room/T0001"]), task.approvedCommit);
    const create = fixture.calls.find((call) => call[2] === "create")!;
    assert.equal(create[create.indexOf("--project") + 1], "project");
    assert.equal(create[create.indexOf("--repository") + 1], "repository");
    assert.equal(create[create.indexOf("--source-branch") + 1], "control-room/T0001");
    assert.equal(create[create.indexOf("--target-branch") + 1], "main");
    assert.equal(fixture.calls.filter((call) => call[0] === "push").length, 1);
    assert.ok(fixture.calls.find((call) => call[0] === "push")!.at(-1)!.endsWith(":refs/heads/control-room/T0001"));
    helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "dependent", "Dependent behavior");
    helpers.registerTask(fixture.options as import("./helpers.ts").IOptions, "independent", "Independent behavior");
    core.submitEvent(fixture.options, "depend", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(fixture.options, "enqueue-dependent", "T0002", "ENQUEUE_REQUESTED", {});
    core.submitEvent(fixture.options, "enqueue-independent", "T0003", "ENQUEUE_REQUESTED", {});
    assert.equal((core.settleProject(fixture.options) as any).activation.reason, "PR_MERGE_PENDING");
    assert.equal((core.getStatus(fixture.options, "T0003").task as any).state, "QUEUED");
    const merged = mergeRemotePr(fixture);
    const synchronized = syncPullRequests(fixture.options);
    assert.equal(synchronized.warnings.length, 0);
    assert.equal(synchronized.tasks[0].task.state, "DONE");
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "main"]), merged);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), merged);
    assert.equal(helpers.runGit(fixture.repositoryRoot, ["branch", "--list", "control-room/T0001"]), "");
    assert.equal((core.getStatus(fixture.options, "T0002").task as any).state, "QUEUED");
    const next = core.settleProject(fixture.options) as any;
    assert.equal(next.activation.task.taskId, "T0002");
    assert.equal(next.activation.task.baseCommit, merged);
});

test("Azure DevOps clone formats identify the same repository for fetch and push", () => {
    for (const origin of ["git@SSH.DEV.AZURE.COM:v3/fixture/project/repository", "ssh://git@ssh.dev.azure.com/v3/fixture/project/repository", "git@vs-ssh.visualstudio.com:v3/fixture/project/repository", "fixture@vs-ssh.visualstudio.com:v3/fixture/project/repository", "https://fixture.visualstudio.com/project/_git/repository", "https://fixture.visualstudio.com/DefaultCollection/project/_git/repository", "https://fixture.visualstudio.com/defaultcollection/project/_git/repository"]) {
        const fixture = createPrFixture("azure-devops", origin);
        helpers.runGit(fixture.repositoryRoot, ["config", "remote.origin.pushurl", "https://fixture@dev.azure.com/fixture/project/_git/repository"]);
        approveChangedTask(fixture);
        assert.equal((core.settleProject(fixture.options) as any).completion.task.state, "PR_OPEN");
        assert.equal(fixture.prs.length, 1);
    }
});

test("GitHub SSH host case does not change destination identity or the selected provider", () => {
    const fixture = createPrFixture("github", "git@GITHUB.COM:fixture/project.git");
    helpers.runGit(fixture.repositoryRoot, ["config", "remote.origin.pushurl", "https://github.com/fixture/project.git"]);
    approveChangedTask(fixture);
    assert.equal((core.settleProject(fixture.options) as any).completion.task.state, "PR_OPEN");
    assert.equal(fixture.prs.length, 1);
});

test("Azure DevOps rejects credentials, option names and mismatched destinations before commit or provider calls", () => {
    for (const origin of ["https://fixture:fictional-secret@dev.azure.com/fixture/project/_git/repository", "https://fictional-token@dev.azure.com/fixture/project/_git/repository", "fictional-token@vs-ssh.visualstudio.com:v3/fixture/project/repository", "fixture@ssh.dev.azure.com:v3/fixture/project/repository", "https://dev.azure.com/fixture/--project/_git/repository", "https://dev.azure.com/fixture/project/_git/repository?token=fictional", "https://dev.azure.com/fixture/project/_git/encoded%2Frepository"]) {
        const fixture = createPrFixture("azure-devops", origin);
        approveChangedTask(fixture);
        assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"), (error: Error) => !error.message.includes("fictional"));
        assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
        assert.equal(core.getStatus(fixture.options).commitTaskId, null);
        assert.equal(fixture.calls.length, 0);
    }
    const fixture = createPrFixture("azure-devops");
    approveChangedTask(fixture);
    helpers.runGit(fixture.repositoryRoot, ["config", "remote.origin.pushurl", "git@ssh.dev.azure.com:v3/fixture/project/other"]);
    assert.throws(() => core.commitApprovedTask(fixture.options, "T0001"), /same single origin/u);
    assert.equal(core.getStatus(fixture.options).commitTaskId, null);
    assert.equal(fixture.calls.length, 0);
});

test("Azure DevOps rejects a stored PR receipt outside its repository before requesting the PR", () => {
    const fixture = createPrFixture("azure-devops");
    approveChangedTask(fixture);
    core.settleProject(fixture.options);
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare("UPDATE tasks SET pr_url = ? WHERE task_id = 'T0001'").run("https://dev.azure.com/fixture/project/_git/other/pullrequest/1");
    database.close();
    const callsBefore = fixture.calls.filter((call) => call[1] === "pr").length;
    const result = syncPullRequests(fixture.options);
    assert.equal(result.warnings.length, 1);
    assert.equal(fixture.calls.filter((call) => call[1] === "pr").length, callsBefore);
    assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, "PR_OPEN");
});

for (const provider of ["github", "azure-devops"] as const) {
    test(`${provider} malformed JSON diagnostics preserve PR work without exposing provider output`, () => {
        const fixture = createPrFixture(provider);
        approveChangedTask(fixture);
        core.settleProject(fixture.options);
        const worker = helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]);
        fixture.invalidJson = true;
        const result = syncPullRequests(fixture.options);
        assert.equal(result.warnings.length, 1);
        assert.ok(result.warnings[0].reason.includes("invalid JSON"));
        assert.ok(!result.warnings[0].reason.includes("fictional"));
        assert.equal((core.getStatus(fixture.options, "T0001").task as any).state, "PR_OPEN");
        assert.equal(helpers.runGit(fixture.repositoryRoot, ["rev-parse", "control-room/T0001"]), worker);
    });
}
