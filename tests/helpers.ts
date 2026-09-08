const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const childProcess: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const fixtureRoots = new Set<string>();

/** Remove disposable repositories after this test process finishes. */
test.after(() => {
    for (const root of fixtureRoots) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");

export interface IFixture {
    initialCommit: string;
    repositoryRoot: string;
    stateRoot: string;
}

export interface IOptions {
    projectRoot: string;
    stateRoot: string;
}

export interface IRegisteredTask extends Record<string, unknown> {
    taskId: string;
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
 * @param environment Additional environment variables for the child process.
 */
function runCli(argumentsList: string[], environment: Record<string, string> = {}) {
    return childProcess.spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "control-room.ts"), ...argumentsList], {
        encoding: "utf8",
        env: { ...process.env, ...environment },
        shell: false
    });
}

/**
 * Create an isolated Git repository and ControlRoom state root.
 */
function createFixture(): IFixture {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "control-room-test-"));
    fixtureRoots.add(fixtureRoot);
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
    fixtureRoots.add(fixtureRoot);
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
    return String(initialized.databasePath);
}

/**
 * Register one task.
 * @param options ControlRoom project options.
 * @param threadId Worker thread identifier.
 * @param semanticName Worker semantic name.
 */
function registerTask(options: IOptions, threadId: string, semanticName: string): IRegisteredTask {
    return core.registerTask(options, threadId, semanticName) as IRegisteredTask;
}

/**
 * Register, queue, process, and activate one task.
 * @param options ControlRoom project options.
 * @param threadId Worker thread identifier.
 * @param semanticName Worker semantic name.
 * @param eventKey Stable enqueue event key.
 */
function activateTask(options: IOptions, threadId: string, semanticName: string, eventKey: string): import("../scripts/control-room-types.ts").IActivationResult {
    const registered = registerTask(options, threadId, semanticName);
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

const api = { runGit, runCli, createFixture, createUnbornFixture, initializeFixture, registerTask, activateTask, approveTask };
module.exports = api;
export interface ITestHelpers extends Readonly<typeof api> {}
