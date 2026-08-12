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

interface IRegisteredTask extends Record<string, unknown> {
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

/**
 * Build the minimal complete mental-model fixture used by legacy workflow tests.
 */
function buildMentalModel(): Record<string, string> {
    return {
        currentState: "The requested task has not been implemented.",
        desiredOutcome: "The requested task is implemented and ready for review.",
        approach: "Apply the requested change on the active worker branch.",
        affectedAreas: "The files in scope for the task.",
        invariants: "ControlRoom state and Git behavior remain valid.",
        nonGoals: "No unrelated project changes.",
        verification: "Run the relevant automated checks."
    };
}

/**
 * Register one task and seed its required review-contract baseline.
 * @param options ControlRoom project options.
 * @param threadId Worker thread identifier.
 * @param semanticName Worker semantic name.
 */
function registerTask(options: IOptions, threadId: string, semanticName: string): IRegisteredTask {
    const registered = core.registerTask(options, threadId, semanticName) as IRegisteredTask;
    const reviewPacket = core.getReviewPacket(options, registered.taskId);
    if (!reviewPacket.baseline) {
        core.submitEvent(options, `fixture-mental-${registered.taskId}`, registered.taskId, "MENTAL_MODEL_RECORDED", buildMentalModel());
        core.processPendingEvents(options);
    }
    return registered;
}

test("initializes and completes the first task in a repository without commits", () => {
    const fixture = createUnbornFixture();
    const codexHome = path.join(path.dirname(fixture.stateRoot), "codex-home");
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
    ], { CODEX_HOME: codexHome });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const initializationResult = JSON.parse(initialized.stdout);
    const databasePath = initializationResult.databasePath;
    assert.equal(initializationResult.controlRoomTitle, "⚫️ Control Room");
    assert.equal(initializationResult.baseCommit, null);
    assert.equal(initializationResult.routing.installed, true);
    assert.equal(initializationResult.routing.agentsPath, path.join(fs.realpathSync(fixture.repositoryRoot), "AGENTS.md"));
    assert.match(fs.readFileSync(path.join(fixture.repositoryRoot, "AGENTS.md"), "utf8"), /\$control-room/);
    assert.equal(fs.statSync(path.join(fixture.repositoryRoot, "AGENTS.md")).mode & 0o777, 0o644);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    assert.equal(core.getStatus(options).baseBranch, "main");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--all", "--count"]), "0");

    fs.writeFileSync(path.join(fixture.repositoryRoot, "existing.txt"), "present before activation\n");
    registerTask(options, "thread-one", "Create initial project");
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
    assert.match(runGit(fixture.repositoryRoot, ["show", "HEAD:AGENTS.md"]), /\$control-room/);
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

test("allocates four-digit task IDs and preserves IDs across registration retries", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const first = registerTask(options, "thread-one", "Build queue");
    const retry = registerTask(options, "thread-one", "Build queue");
    const second = registerTask(options, "thread-two", "Add review");
    assert.equal(first.taskId, "T0001");
    assert.equal(first.title, "⚪️ T0001 - Build queue");
    assert.equal(retry.taskId, "T0001");
    assert.equal(retry.created, false);
    assert.equal(second.taskId, "T0002");
    assert.throws(
        () => registerTask(options, "control-room-thread", "Invalid worker"),
        /Control Room task cannot be registered/
    );
});

test("resolves Control Room, registered worker, excluded, and unregistered thread roles", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Build queue");
    core.excludeTask(options, "excluded-thread", "brand-forge");

    const controlRoom = core.getStatus(options, undefined, "control-room-thread");
    const worker = core.getStatus(options, undefined, "thread-one");
    const excluded = core.getStatus(options, undefined, "excluded-thread");
    const unregistered = core.getStatus(options, undefined, "new-thread");
    assert.equal(controlRoom.role, "CONTROL_ROOM");
    assert.equal(controlRoom.task, null);
    assert.equal(worker.role, "WORKER");
    assert.equal(worker.task.taskId, "T0001");
    assert.equal(excluded.role, "EXCLUDED");
    assert.equal(excluded.task, null);
    assert.equal(excluded.exclusion.reason, "brand-forge");
    assert.equal(unregistered.role, "UNREGISTERED");
    assert.equal(unregistered.task, null);

    const cliResult = runCli(["status", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--thread-id", "new-thread"]);
    assert.equal(cliResult.status, 0, cliResult.stderr || cliResult.stdout);
    assert.equal(JSON.parse(cliResult.stdout).role, "UNREGISTERED");
    assert.throws(() => core.getStatus(options, "T0001", "thread-one"), /either a task ID or a thread ID/);
});

test("persists task exclusions and requires explicit adoption", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const commonArguments = ["--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--thread-id", "brand-thread"];

    const excluded = runCli(["exclude", ...commonArguments, "--reason", "brand-forge"]);
    assert.equal(excluded.status, 0, excluded.stderr || excluded.stdout);
    assert.equal(JSON.parse(excluded.stdout).created, true);
    assert.equal(JSON.parse(excluded.stdout).role, "EXCLUDED");

    const retry = runCli(["exclude", ...commonArguments, "--reason", "manual directive"]);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(retry.stdout).created, false);
    assert.equal(JSON.parse(retry.stdout).exclusion.reason, "brand-forge");

    const status = runCli(["status", ...commonArguments]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.equal(JSON.parse(status.stdout).role, "EXCLUDED");
    assert.equal(core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }).nextTaskId, "T0001");

    const automaticRegistration = runCli(["register", ...commonArguments, "--name", "Name product"]);
    assert.notEqual(automaticRegistration.status, 0);
    assert.match(automaticRegistration.stderr, /use \$control-room join to adopt it explicitly/);

    const invalidAdoption = runCli(["register", ...commonArguments, "--name", "Name product", "--adopt-excluded", "false"]);
    assert.notEqual(invalidAdoption.status, 0);
    assert.match(invalidAdoption.stderr, /--adopt-excluded accepts only true/);

    const explicitJoin = runCli(["register", ...commonArguments, "--name", "Name product", "--adopt-excluded", "true"]);
    assert.equal(explicitJoin.status, 0, explicitJoin.stderr || explicitJoin.stdout);
    assert.equal(JSON.parse(explicitJoin.stdout).taskId, "T0001");
    assert.equal(core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }, undefined, "brand-thread").role, "WORKER");
    assert.throws(
        () => core.excludeTask({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }, "brand-thread", "late opt-out"),
        /Registered worker T0001 must use request-exclude/
    );
    assert.throws(
        () => core.excludeTask({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }, "control-room-thread", "invalid"),
        /Control Room task cannot be excluded/
    );
});

test("excludes a planning task through cancellation and restores it through explicit join", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Leave planning");

    const requested = runCli([
        "request-exclude",
        "--project-root", fixture.repositoryRoot,
        "--state-root", fixture.stateRoot,
        "--task", "T0001",
        "--event-key", "exclude-planning-1",
        "--user-request-id", "exclude-planning-message",
        "--reason", "manual directive"
    ]);
    assert.equal(requested.status, 0, requested.stderr || requested.stdout);

    const settled = core.settleProject(options);
    assert.equal(settled.processed.results[0].action, "CANCELED");
    assert.equal(settled.processed.results[0].excluded, true);
    assert.equal(settled.processed.results[0].task.state, "CANCELED");
    assert.deepEqual(settled.queue, []);
    assert.deepEqual(settled.titleUpdates, [{ taskId: "T0001", threadId: "thread-one", title: "Leave planning" }]);
    const excludedStatus = core.getStatus(options, undefined, "thread-one");
    assert.equal(excludedStatus.role, "EXCLUDED");
    assert.equal(excludedStatus.task, null);
    assert.equal(excludedStatus.exclusion.reason, "manual directive");
    assert.equal(core.getStatus(options, "T0001").task.state, "CANCELED");

    const adopted = core.registerTask(options, "thread-one", "Leave planning", true);
    assert.equal(adopted.created, false);
    assert.equal(adopted.adoptedExclusion, true);
    assert.equal(adopted.state, "PLANNING");
    assert.equal(adopted.title, "⚪️ T0001 - Leave planning");
    assert.equal(core.getStatus(options, undefined, "thread-one").role, "WORKER");
    assert.ok(core.getReviewPacket(options, "T0001").baseline);
});

test("excludes a queued task, compacts waiting titles, and rejects active exclusion", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Active task", "activate-1");
    registerTask(options, "thread-two", "Leave queue");
    registerTask(options, "thread-three", "Remain queued");
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-3", "T0003", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);

    const activeRejection = runCli([
        "request-exclude",
        "--project-root", fixture.repositoryRoot,
        "--state-root", fixture.stateRoot,
        "--task", "T0001",
        "--event-key", "exclude-active-1",
        "--user-request-id", "exclude-active-message",
        "--reason", "manual directive"
    ]);
    assert.notEqual(activeRejection.status, 0);
    assert.match(activeRejection.stderr, /Cannot request exclusion for T0001 from RUNNING/);

    const queuedRequest = runCli([
        "request-exclude",
        "--project-root", fixture.repositoryRoot,
        "--state-root", fixture.stateRoot,
        "--task", "T0002",
        "--event-key", "exclude-queued-1",
        "--user-request-id", "exclude-queued-message",
        "--reason", "manual directive"
    ]);
    assert.equal(queuedRequest.status, 0, queuedRequest.stderr || queuedRequest.stdout);

    const settled = core.settleProject(options);
    const titlesByTask = new Map(settled.titleUpdates.map((update: Record<string, unknown>) => [update.taskId, update.title]));
    assert.deepEqual(settled.queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0003"]);
    assert.equal(settled.queue[1].queuedPosition, 1);
    assert.equal(settled.queue[1].title, "⭕️ ① T0003 - Remain queued");
    assert.equal(titlesByTask.get("T0002"), "Leave queue");
    assert.equal(titlesByTask.get("T0003"), "⭕️ ① T0003 - Remain queued");
    assert.equal(core.getStatus(options, undefined, "thread-two").role, "EXCLUDED");
    assert.equal(core.getStatus(options, "T0002").task.state, "CANCELED");
});

test("persists exclusion when an earlier pending cancellation wins", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Resolve pending terminal events");
    core.submitEvent(options, "cancel-first", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-message" });
    core.submitEvent(options, "exclude-second", "T0001", "CANCEL_REQUESTED", {
        cancelSource: "exclude",
        exclusionReason: "manual directive",
        userRequestId: "exclude-message"
    });

    const settled = core.settleProject(options);
    assert.deepEqual(settled.processed.results.map((result: Record<string, unknown>) => result.action), ["CANCELED", "CANCELLATION_ALREADY_RECORDED"]);
    assert.equal(settled.processed.results[1].excluded, true);
    assert.equal(core.getStatus(options, undefined, "thread-one").role, "EXCLUDED");
});

test("returns the user command list for the created Control Room console", () => {
    const fixture = createFixture();
    const codexHome = path.join(path.dirname(fixture.stateRoot), "codex-home");
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
    const initialized = runCli(argumentsList, { CODEX_HOME: codexHome });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const result = JSON.parse(initialized.stdout);
    assert.equal(result.controlRoomTitle, "⚫️ Control Room");
    assert.equal(result.routing.installed, true);
    assert.equal(result.routing.updated, true);
    assert.deepEqual(result.userCommands, [
        "$control-room init",
        "$control-room join",
        "$control-room exclude",
        "$control-room queue",
        "$control-room help",
        "Return to planning | Return T0002 to planning",
        "Enqueue [after T0002]",
        "Run now | Run T0002 now",
        "Move first | Move to 3 | Move before T0002 | Move after T0002",
        "Depends on T0002 | Remove dependency T0002",
        "Approve | Cancel | Status | Queue status"
    ]);
    const retry = runCli(argumentsList, { CODEX_HOME: codexHome });
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(retry.stdout).created, false);
    assert.equal(JSON.parse(retry.stdout).routing.installed, true);
    assert.equal(JSON.parse(retry.stdout).routing.updated, false);
    assert.deepEqual(JSON.parse(retry.stdout).userCommands, result.userCommands);
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /End that response with the same command list returned by CLI `help`/);
    assert.match(skillText, /Put nothing after the list/);
});

test("repairs local routing for a project initialized before routing support", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const codexHome = path.join(path.dirname(fixture.stateRoot), "codex-home");
    const globalAgentsPath = path.join(codexHome, "AGENTS.md");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(globalAgentsPath, "# Global instructions\n");

    const repaired = runCli([
        "init",
        "--project-root",
        fixture.repositoryRoot,
        "--state-root",
        fixture.stateRoot,
        "--control-room-thread",
        "control-room-thread",
        "--base-branch",
        "main"
    ], { CODEX_HOME: codexHome });
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    const result = JSON.parse(repaired.stdout);
    assert.equal(result.created, false);
    assert.equal(result.routing.installed, true);
    assert.equal(result.routing.updated, true);
    assert.match(fs.readFileSync(path.join(fixture.repositoryRoot, "AGENTS.md"), "utf8"), /\$control-room/);
    assert.equal(fs.readFileSync(globalAgentsPath, "utf8"), "# Global instructions\n");
});

test("reports partial initialization when project routing cannot be installed", () => {
    const fixture = createFixture();
    const externalPath = path.join(path.dirname(fixture.stateRoot), "external-agents.md");
    fs.writeFileSync(externalPath, "# External\n");
    fs.symlinkSync(externalPath, path.join(fixture.repositoryRoot, "AGENTS.md"));

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
    const result = JSON.parse(initialized.stdout);
    assert.equal(result.created, true);
    assert.equal(result.routing.installed, false);
    assert.match(result.routing.error, /cannot be a symbolic link/);
    assert.equal(core.getStatus({ projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot }).controlRoomThreadId, "control-room-thread");
    assert.equal(fs.readFileSync(externalPath, "utf8"), "# External\n");
});

test("installs ControlRoom routing in project instructions without changing global instructions", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const codexHome = path.join(path.dirname(fixture.stateRoot), "codex-home");
    fs.mkdirSync(codexHome);
    const globalAgentsPath = path.join(codexHome, "AGENTS.md");
    const agentsPath = path.join(fixture.repositoryRoot, "AGENTS.md");
    fs.writeFileSync(globalAgentsPath, "# Global instructions\n");
    fs.writeFileSync(agentsPath, "# Existing instructions\n\n- Preserve this rule.\n");
    const argumentsList = ["install-routing", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot];

    const installed = runCli(argumentsList, { CODEX_HOME: codexHome });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const result = JSON.parse(installed.stdout);
    const agentsContent = fs.readFileSync(agentsPath, "utf8");
    assert.equal(result.updated, true);
    assert.equal(result.agentsPath, path.join(fs.realpathSync(fixture.repositoryRoot), "AGENTS.md"));
    assert.equal(agentsContent.startsWith("<!-- control-room:start -->"), true);
    assert.match(agentsContent, /# Existing instructions/);
    assert.match(agentsContent, /load and follow `\$control-room` before handling each user message/);
    assert.match(agentsContent, /invokes or triggers `\$brand-forge`/);
    assert.match(agentsContent, /exact standalone `\$control-room exclude` directive/);
    assert.match(agentsContent, /registered PLANNING or QUEUED task/);
    assert.match(agentsContent, /cancellation and settlement/);
    assert.match(agentsContent, /only an explicit `\$control-room join` adopts one/);
    assert.match(agentsContent, /Do not automatically register a purely read-only request/);
    assert.match(agentsContent, /Apply every ControlRoom task title update before replying/);
    assert.equal(fs.readFileSync(globalAgentsPath, "utf8"), "# Global instructions\n");
    assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain"]), "?? AGENTS.md");

    const retry = runCli(argumentsList, { CODEX_HOME: codexHome });
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.equal(JSON.parse(retry.stdout).updated, false);
    assert.equal(fs.readFileSync(agentsPath, "utf8"), agentsContent);
    assert.equal((agentsContent.match(/<!-- control-room:start -->/g) || []).length, 1);
});

test("activates with uncommitted local routing without creating a commit", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const routing = core.installProjectRouting(options);
    assert.equal(routing.installed, true);
    assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain"]), "?? AGENTS.md");

    registerTask(options, "thread-one", "First routed task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    const activation = core.activateNextTask(options);

    assert.equal(activation.activated, true);
    assert.equal(activation.task.branchName, "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), fixture.initialCommit);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-list", "--all", "--count"]), "1");
    assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain"]), "?? AGENTS.md");
});

test("uses the active project override and rejects project instruction symlinks", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const codexHome = path.join(path.dirname(fixture.stateRoot), "codex-home");
    fs.mkdirSync(codexHome);
    const globalAgentsPath = path.join(codexHome, "AGENTS.md");
    const agentsPath = path.join(fixture.repositoryRoot, "AGENTS.md");
    const overridePath = path.join(fixture.repositoryRoot, "AGENTS.override.md");
    fs.writeFileSync(globalAgentsPath, "# Global instructions\n");
    fs.writeFileSync(agentsPath, "# Base instructions\n");
    fs.writeFileSync(overridePath, "# Active override\n");
    const argumentsList = ["install-routing", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot];

    const installed = runCli(argumentsList, { CODEX_HOME: codexHome });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal(JSON.parse(installed.stdout).agentsPath, path.join(fs.realpathSync(fixture.repositoryRoot), "AGENTS.override.md"));
    assert.equal(fs.readFileSync(agentsPath, "utf8"), "# Base instructions\n");
    assert.match(fs.readFileSync(overridePath, "utf8"), /\$control-room/);
    assert.equal(fs.readFileSync(globalAgentsPath, "utf8"), "# Global instructions\n");

    const unsafeFixture = createFixture();
    initializeFixture(unsafeFixture);
    const externalPath = path.join(path.dirname(unsafeFixture.stateRoot), "external-agents.md");
    fs.writeFileSync(externalPath, "# External\n");
    fs.symlinkSync(externalPath, path.join(unsafeFixture.repositoryRoot, "AGENTS.md"));
    const unsafeArguments = ["install-routing", "--project-root", unsafeFixture.repositoryRoot, "--state-root", unsafeFixture.stateRoot];
    const rejected = runCli(unsafeArguments, { CODEX_HOME: codexHome });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /cannot be a symbolic link/);
    assert.equal(fs.readFileSync(externalPath, "utf8"), "# External\n");
});

test("keeps the failure icon for blocked tasks and resets canceled titles", () => {
    const baseTask = {
        task_id: "T0001",
        semantic_name: "Handle failure"
    };
    assert.equal(core.titleForTask({ ...baseTask, state: "BLOCKED" }), "❌ T0001 - Handle failure");
    assert.equal(core.titleForTask({ ...baseTask, state: "CANCELED" }), "Handle failure");
});

test("settlement returns the undecorated semantic title for a canceled task", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Discard obsolete work");
    core.submitEvent(options, "cancel-1", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-message" });

    const settled = core.settleProject(options);

    assert.equal(settled.processed.results[0].action, "CANCELED");
    assert.equal(settled.processed.results[0].task.title, "Discard obsolete work");
    assert.deepEqual(settled.queue, []);
    assert.deepEqual(settled.titleUpdates, [{ taskId: "T0001", threadId: "thread-one", title: "Discard obsolete work" }]);
    assert.equal(core.getStatus(options, undefined, "thread-one").role, "WORKER");
});

test("uses the review marker and red when review rework starts", () => {
    const baseTask = {
        task_id: "T0001",
        semantic_name: "Refine review"
    };
    assert.equal(core.titleForTask({ ...baseTask, state: "REVIEW" }), "💪 T0001 - Refine review");
    assert.equal(core.titleForTask({ ...baseTask, state: "RUNNING" }), "🔴 T0001 - Refine review");
});

test("uses the pointing hand only while a running task awaits user input", () => {
    const baseTask = {
        task_id: "T0001",
        semantic_name: "Confirm implementation",
        awaiting_user: 1
    };
    assert.equal(core.titleForTask({ ...baseTask, state: "PLANNING" }), "⚪️ T0001 - Confirm implementation");
    assert.equal(core.titleForTask({ ...baseTask, state: "RUNNING" }), "👉 T0001 - Confirm implementation");
    assert.equal(core.titleForTask({ ...baseTask, state: "REVIEW" }), "💪 T0001 - Confirm implementation");
    assert.equal(core.titleForTask({ ...baseTask, state: "BLOCKED" }), "❌ T0001 - Confirm implementation");
});

test("rejects user-attention requests while a task is planning", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Confirm implementation");

    assert.throws(
        () => core.submitEvent(options, "user-input-planning", "T0001", "USER_INPUT_REQUESTED", {}),
        /Cannot request user input for T0001 from PLANNING/
    );
    assert.equal(core.getStatus(options, "T0001").task.title, "⚪️ T0001 - Confirm implementation");
});

test("marks a running task for user attention and restores red after the response", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Confirm implementation", "enqueue-1");
    const initialTask = core.getStatus(options, "T0001").task;
    const initialHead = runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]);

    const requested = runCli(["request-user-input", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0001", "--event-key", "user-input-1"]);
    assert.equal(requested.status, 0, requested.stderr || requested.stdout);
    const waiting = core.settleProject(options);
    assert.equal(waiting.processed.results[0].action, "USER_INPUT_REQUESTED");
    assert.equal(waiting.queue[0].state, "RUNNING");
    assert.equal(waiting.queue[0].awaitingUser, true);
    assert.equal(waiting.queue[0].title, "👉 T0001 - Confirm implementation");
    assert.equal(waiting.queue[0].queuePosition, initialTask.queuePosition);
    assert.equal(waiting.queue[0].branchName, initialTask.branchName);
    assert.deepEqual(waiting.titleUpdates, [{ taskId: "T0001", threadId: "thread-one", title: "👉 T0001 - Confirm implementation" }]);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), initialHead);

    const responded = runCli(["request-user-response", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0001", "--event-key", "user-response-1"]);
    assert.equal(responded.status, 0, responded.stderr || responded.stdout);
    const resumed = core.settleProject(options);
    assert.equal(resumed.processed.results[0].action, "USER_INPUT_RECEIVED");
    assert.equal(resumed.queue[0].state, "RUNNING");
    assert.equal(resumed.queue[0].awaitingUser, false);
    assert.equal(resumed.queue[0].title, "🔴 T0001 - Confirm implementation");
    assert.equal(resumed.queue[0].queuePosition, initialTask.queuePosition);
    assert.equal(resumed.queue[0].branchName, initialTask.branchName);
    assert.deepEqual(resumed.titleUpdates, [{ taskId: "T0001", threadId: "thread-one", title: "🔴 T0001 - Confirm implementation" }]);
    assert.equal(runGit(fixture.repositoryRoot, ["rev-parse", "HEAD"]), initialHead);

    const retry = core.submitEvent(options, "user-response-1", "T0001", "USER_INPUT_RECEIVED", {});
    assert.equal(retry.created, false);
    assert.equal(retry.processed, true);
});

test("derives queued position markers without storing them in the semantic name", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const registered = registerTask(options, "thread-one", "⭕️ ① Build queue");
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
        () => registerTask(
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
    registerTask(options, "thread-one", "First legacy task");
    registerTask(options, "thread-two", "Second legacy task");
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
        DROP TABLE task_exclusions;
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
    const exclusionTable = migratedDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_exclusions'").get();
    const migratedDependency = migratedDatabase.prepare("SELECT dependency_kind FROM dependencies WHERE task_id = 'T0002' AND depends_on_id = 'T0001'").get();
    const migratedEvent = migratedDatabase.prepare("SELECT kind FROM events WHERE event_key = 'legacy-enqueue'").get();
    migratedDatabase.close();
    assert.equal(version, 10);
    assert.equal(project.git_mode, "local-approval-commit");
    assert.ok(taskColumns.includes("reviewed_commit"));
    assert.ok(taskColumns.includes("awaiting_user"));
    assert.match(dependencySql, /BLOCKING/);
    assert.match(eventSql, /MOVE_REQUESTED/);
    assert.match(eventSql, /REWORK_REQUESTED/);
    assert.match(eventSql, /RUN_NOW_REQUESTED/);
    assert.match(eventSql, /PLANNING_REQUESTED/);
    assert.match(eventSql, /USER_INPUT_REQUESTED/);
    assert.match(eventSql, /USER_INPUT_RECEIVED/);
    assert.match(eventSql, /MENTAL_MODEL_RECORDED/);
    assert.match(eventSql, /DECISION_RECORDED/);
    assert.equal(exclusionTable.name, "task_exclusions");
    assert.equal(migratedDependency.dependency_kind, "BLOCKING");
    assert.equal(migratedEvent.kind, "ENQUEUE_REQUESTED");
});

test("migrates version 6 events without losing pending requests", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Preserve pending event");
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec(`
        ALTER TABLE events RENAME TO events_current;
        CREATE TABLE events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT NOT NULL UNIQUE,
            task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('ENQUEUE_REQUESTED', 'RUN_NOW_REQUESTED', 'MOVE_REQUESTED', 'DEPENDENCY_ADD_REQUESTED', 'DEPENDENCY_REMOVE_REQUESTED', 'REVIEW_REQUESTED', 'REWORK_REQUESTED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            processed_at TEXT,
            result_json TEXT
        );
        INSERT INTO events (event_key, task_id, kind, payload_json, created_at)
        VALUES ('pending-v6-enqueue', 'T0001', 'ENQUEUE_REQUESTED', '{}', '2026-01-01T00:00:00.000Z');
        DROP TABLE events_current;
        PRAGMA user_version = 6;
    `);
    legacyDatabase.close();

    assert.equal(core.getStatus(options, "T0001").task.state, "PLANNING");
    const migratedBeforeProcessing = new DatabaseSync(databasePath);
    migratedBeforeProcessing.prepare(`
        INSERT INTO events (sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json)
        VALUES (0, 'fixture-migrated-mental', 'T0001', 'MENTAL_MODEL_RECORDED', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)
    `).run(JSON.stringify(buildMentalModel()), JSON.stringify({ action: "MENTAL_MODEL_RECORDED", baseline: true }));
    migratedBeforeProcessing.close();
    const processed = core.processPendingEvents(options);
    assert.equal(processed.results[0].eventKey, "pending-v6-enqueue");
    assert.equal(processed.results[0].action, "ENQUEUED");
    const migratedDatabase = new DatabaseSync(databasePath);
    assert.equal(migratedDatabase.prepare("PRAGMA user_version").get().user_version, 10);
    assert.equal(migratedDatabase.prepare("SELECT awaiting_user FROM tasks WHERE task_id = 'T0001'").get().awaiting_user, 0);
    const migratedEventSql = migratedDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get().sql;
    assert.match(migratedEventSql, /PLANNING_REQUESTED/);
    assert.match(migratedEventSql, /USER_INPUT_REQUESTED/);
    assert.match(migratedEventSql, /MENTAL_MODEL_RECORDED/);
    migratedDatabase.close();
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
    registerTask(options, "thread-one", "First task");
    registerTask(options, "thread-two", "Second task");
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
        registerTask(options, `thread-${index}`, `Task ${index}`);
    }
    for (let index = 1; index <= 3; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
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
    assert.deepEqual(settled.titleUpdates.map((update: Record<string, unknown>) => update.title), [
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

test("runs an eligible planning task immediately ahead of queued work", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Queued task");
    registerTask(options, "thread-two", "Immediate task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);

    const requested = runCli(["request-run-now", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "run-now-2"]);
    assert.equal(requested.status, 0, requested.stderr || requested.stdout);
    assert.equal(JSON.parse(requested.stdout).created, true);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "main");

    const settled = core.settleProject(options);
    assert.equal(settled.processed.results[0].action, "RUN_NOW_ENQUEUED");
    assert.equal(settled.activation.activated, true);
    assert.equal(settled.activation.task.taskId, "T0002");
    assert.equal(settled.activation.task.state, "RUNNING");
    assert.deepEqual(settled.queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0002 - Immediate task", "⭕️ ① T0001 - Queued task"]);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0002");

    const retry = core.submitEvent(options, "run-now-2", "T0002", "RUN_NOW_REQUESTED", {});
    assert.equal(retry.created, false);
    assert.equal(retry.processed, true);
});

test("prioritizes and runs an eligible queued task immediately", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "First queued task");
    registerTask(options, "thread-two", "Second queued task");
    core.submitEvent(options, "enqueue-1", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);

    core.submitEvent(options, "run-now-2", "T0002", "RUN_NOW_REQUESTED", {});
    const settled = core.settleProject(options);
    assert.equal(settled.processed.results[0].action, "RUN_NOW_PRIORITIZED");
    assert.equal(settled.activation.task.taskId, "T0002");
    assert.deepEqual(settled.queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0002 - Second queued task", "⭕️ ① T0001 - First queued task"]);
});

test("rejects run now without reordering when another task is active", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    activateTask(options, "thread-one", "Active task", "enqueue-1");
    registerTask(options, "thread-two", "Waiting task");
    core.submitEvent(options, "enqueue-2", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    const queueBefore = core.getQueue(options).queue.map((task: Record<string, unknown>) => `${task.taskId}:${task.state}:${task.queuePosition}`);

    core.submitEvent(options, "run-now-2", "T0002", "RUN_NOW_REQUESTED", {});
    const rejected = core.processPendingEvents(options);
    assert.equal(rejected.results[0].action, "REJECTED");
    assert.match(rejected.results[0].error, /Cannot run T0002 now while T0001 is RUNNING/);
    assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => `${task.taskId}:${task.state}:${task.queuePosition}`), queueBefore);

    core.submitEvent(options, "run-now-1", "T0001", "RUN_NOW_REQUESTED", {});
    const alreadyActive = core.processPendingEvents(options);
    assert.equal(alreadyActive.results[0].action, "RUN_NOW_ALREADY_ACTIVE");
    assert.equal(core.getStatus(options, "T0001").task.state, "RUNNING");
});

test("rejects run now without enqueueing when dependencies are pending", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "thread-one", "Prerequisite task");
    registerTask(options, "thread-two", "Dependent task");
    core.submitEvent(options, "dependency-2-1", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);

    core.submitEvent(options, "run-now-2", "T0002", "RUN_NOW_REQUESTED", {});
    const rejected = core.processPendingEvents(options);
    assert.equal(rejected.results[0].action, "REJECTED");
    assert.match(rejected.results[0].error, /until all dependencies are DONE/);
    assert.equal(core.getStatus(options, "T0002").task.state, "PLANNING");
    assert.deepEqual(core.getQueue(options).queue, []);
});

test("settlement commits an approved task and activates the next worker", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 2; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        registerTask(options, `thread-${index}`, `Task ${index}`);
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
    assert.deepEqual(settled.titleUpdates.map((update: Record<string, unknown>) => update.title), [
        "🟢 T0001 - Task 1",
        "🔴 T0002 - Task 2"
    ]);
    assert.equal(runGit(fixture.repositoryRoot, ["log", "-1", "--format=%s"]), "Add settled workflow coverage");
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0002");
});

test("moves an already queued task to the end on a new enqueue request", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 3; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        registerTask(options, `thread-${index}`, `Task ${index}`);
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

test("returns a blocked waiting task to planning and preserves its dependencies", () => {
    const fixture = createFixture();
    const databasePath = initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 3; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.processPendingEvents(options);
    core.submitEvent(options, "dependency-2-1", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    core.submitEvent(options, "block-2", "T0002", "BLOCKED_REPORTED", { reason: "Needs a revised plan" });
    core.processPendingEvents(options);

    const requested = runCli(["request-planning", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "planning-2"]);
    assert.equal(requested.status, 0, requested.stderr || requested.stdout);
    assert.equal(JSON.parse(requested.stdout).created, true);
    assert.equal(core.getStatus(options, "T0002").task.state, "BLOCKED");

    const settled = core.settleProject(options);
    assert.equal(settled.processed.results[0].action, "RETURNED_TO_PLANNING");
    assert.equal(settled.processed.results[0].task.state, "PLANNING");
    assert.equal(settled.processed.results[0].task.queuePosition, null);
    assert.equal(settled.processed.results[0].task.title, "⚪️ T0002 - Task 2");
    assert.deepEqual(settled.queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0001 - Task 1", "⭕️ ① T0003 - Task 3"]);
    assert.deepEqual(settled.titleUpdates.map((update: Record<string, unknown>) => update.title), ["⚪️ T0002 - Task 2", "🔴 T0001 - Task 1", "⭕️ ① T0003 - Task 3"]);
    const database = new DatabaseSync(databasePath);
    const dependency = database.prepare("SELECT dependency_kind FROM dependencies WHERE task_id = 'T0002' AND depends_on_id = 'T0001'").get();
    database.close();
    assert.equal(dependency.dependency_kind, "BLOCKING");

    const retry = runCli(["request-planning", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "planning-2"]);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.deepEqual(JSON.parse(retry.stdout), { created: false, processed: true, eventKey: "planning-2" });
    assert.equal(core.settleProject(options).processed.processedCount, 0);
    assert.equal(core.getStatus(options, "T0002").task.state, "PLANNING");
});

test("enqueues a blocked waiting task at an explicit position or at the end", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 4; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.processPendingEvents(options);
    core.submitEvent(options, "dependency-2-1", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.processPendingEvents(options);
    core.activateNextTask(options);
    core.submitEvent(options, "block-2-first", "T0002", "BLOCKED_REPORTED", { reason: "Waiting for placement" });
    core.processPendingEvents(options);

    const positionedRequest = runCli(["request-enqueue", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "reenqueue-2-positioned", "--after", "T0003"]);
    assert.equal(positionedRequest.status, 0, positionedRequest.stderr || positionedRequest.stdout);
    const positioned = core.settleProject(options);
    assert.equal(positioned.processed.results[0].action, "ENQUEUED");
    assert.deepEqual(positioned.queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0003", "T0002", "T0004"]);
    assert.deepEqual(positioned.queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0001 - Task 1", "⭕️ ① T0003 - Task 3", "⭕️ ② T0002 - Task 2", "⭕️ ③ T0004 - Task 4"]);
    assert.deepEqual(positioned.queue.find((task: Record<string, unknown>) => task.taskId === "T0002").dependencies, ["T0001"]);
    assert.equal(positioned.titleUpdates.find((update: Record<string, unknown>) => update.taskId === "T0002").title, "⭕️ ② T0002 - Task 2");

    const retry = runCli(["request-enqueue", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "reenqueue-2-positioned", "--after", "T0003"]);
    assert.equal(retry.status, 0, retry.stderr || retry.stdout);
    assert.deepEqual(JSON.parse(retry.stdout), { created: false, processed: true, eventKey: "reenqueue-2-positioned" });

    core.submitEvent(options, "block-2-again", "T0002", "BLOCKED_REPORTED", { reason: "Move to the end" });
    core.processPendingEvents(options);
    const endRequest = runCli(["request-enqueue", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0002", "--event-key", "reenqueue-2-end"]);
    assert.equal(endRequest.status, 0, endRequest.stderr || endRequest.stdout);
    const ended = core.settleProject(options);
    assert.deepEqual(ended.queue.map((task: Record<string, unknown>) => task.taskId), ["T0001", "T0003", "T0004", "T0002"]);
    assert.equal(ended.queue[3].title, "⭕️ ③ T0002 - Task 2");
});

test("rejects planning and enqueue for blocked running or review work without changing Git", () => {
    for (const blockedFromState of ["RUNNING", "REVIEW"]) {
        const fixture = createFixture();
        initializeFixture(fixture);
        const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
        activateTask(options, "thread-one", `${blockedFromState} task`, "enqueue-1");
        fs.writeFileSync(path.join(fixture.repositoryRoot, "change.txt"), `${blockedFromState}\n`);
        if (blockedFromState === "REVIEW") {
            core.submitEvent(options, "review-1", "T0001", "REVIEW_REQUESTED", { summary: "Waiting in review" });
            core.processPendingEvents(options);
        }
        core.submitEvent(options, "block-1", "T0001", "BLOCKED_REPORTED", { reason: "Needs user input" });
        core.processPendingEvents(options);
        const branchBeforeRequests = runGit(fixture.repositoryRoot, ["branch", "--show-current"]);
        const statusBeforeRequests = runGit(fixture.repositoryRoot, ["status", "--porcelain"]);
        const queueBeforeRequests = core.getQueue(options).queue.map((task: Record<string, unknown>) => `${task.taskId}:${task.state}:${task.queuePosition}`);

        const planning = runCli(["request-planning", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0001", "--event-key", `planning-from-${blockedFromState.toLowerCase()}`]);
        assert.notEqual(planning.status, 0);
        assert.match(planning.stderr, new RegExp(`Cannot return T0001 to PLANNING after ${blockedFromState}`));
        const enqueue = runCli(["request-enqueue", "--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0001", "--event-key", `enqueue-from-${blockedFromState.toLowerCase()}`]);
        assert.notEqual(enqueue.status, 0);
        assert.match(enqueue.stderr, new RegExp(`Cannot enqueue T0001 after ${blockedFromState}`));
        assert.equal(core.getStatus(options, "T0001").task.state, "BLOCKED");
        assert.deepEqual(core.getQueue(options).queue.map((task: Record<string, unknown>) => `${task.taskId}:${task.state}:${task.queuePosition}`), queueBeforeRequests);
        assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), branchBeforeRequests);
        assert.equal(runGit(fixture.repositoryRoot, ["status", "--porcelain"]), statusBeforeRequests);
    }
});

test("reorders waiting tasks independently from blocking dependencies", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    for (let index = 1; index <= 4; index += 1) {
        const taskId = `T${String(index).padStart(4, "0")}`;
        registerTask(options, `thread-${index}`, `Task ${index}`);
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
    registerTask(options, "thread-one", "First task");
    registerTask(options, "thread-two", "Second task");
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
    registerTask(options, "thread-one", "First task");
    registerTask(options, "thread-two", "Second task");
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
    registerTask(options, "thread-one", "Activation branch");
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
        registerTask(options, `thread-${index}`, `Task ${index}`);
        core.submitEvent(options, `enqueue-${index}`, taskId, "ENQUEUE_REQUESTED", {});
    }
    core.processPendingEvents(options);

    const activation = core.activateNextTask(options);
    assert.equal(activation.task.title, "🔴 T0001 - Task 1");
    assert.deepEqual(activation.titleUpdates.map((update: Record<string, unknown>) => update.title), ["⭕️ ① T0002 - Task 2", "⭕️ ② T0003 - Task 3"]);
    let queue = core.getQueue(options).queue;
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.title), ["🔴 T0001 - Task 1", "⭕️ ① T0002 - Task 2", "⭕️ ② T0003 - Task 3"]);
    assert.deepEqual(queue.map((task: Record<string, unknown>) => task.queuedPosition), [null, 1, 2]);

    registerTask(options, "thread-4", "Task 4");
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
    registerTask(options, "thread-one", "First task");
    registerTask(options, "thread-two", "Dependent task");
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
    registerTask(options, "thread-one", "Canceled task");
    registerTask(options, "thread-two", "Next task");
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

test("activates a queued task without a mental model and requires worker bootstrap", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "Legacy queued task");
    core.submitEvent(options, "enqueue-without-model", "T0001", "ENQUEUE_REQUESTED", {});
    const queued = core.processPendingEvents(options);
    assert.equal(queued.results[0].action, "ENQUEUED");
    assert.equal(queued.results[0].reviewPacket.baseline, null);
    const activation = core.activateNextTask(options);
    assert.equal(activation.activated, true);
    assert.equal(activation.executionBrief.mentalModelRequired, true);
    assert.equal(activation.executionBrief.reviewPacket.baseline, null);
    assert.match(activation.executionBrief.instruction, /before modifying project files/);
    assert.equal(runGit(fixture.repositoryRoot, ["branch", "--show-current"]), "control-room/T0001");

    core.submitEvent(options, "review-without-model", "T0001", "REVIEW_REQUESTED", {});
    const rejectedReview = core.processPendingEvents(options);
    assert.equal(rejectedReview.results[0].action, "REJECTED");
    assert.match(rejectedReview.results[0].error, /Review contract is missing/);

    core.submitEvent(options, "worker-mental-model", "T0001", "MENTAL_MODEL_RECORDED", buildMentalModel());
    core.processPendingEvents(options);
    assert.notEqual(core.getStatus(options, "T0001").reviewPacket.baseline, null);
    core.submitEvent(options, "review-after-model", "T0001", "REVIEW_REQUESTED", {});
    const reviewed = core.processPendingEvents(options);
    assert.equal(reviewed.results[0].action, "REVIEW_READY");
});

test("runs a planning task immediately without a preexisting mental model", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "Immediate bootstrap task");
    core.submitEvent(options, "run-without-model", "T0001", "RUN_NOW_REQUESTED", {});
    const settled = core.settleProject(options);
    assert.equal(settled.processed.results[0].action, "RUN_NOW_ENQUEUED");
    assert.equal(settled.activation.activated, true);
    assert.equal(settled.activation.executionBrief.mentalModelRequired, true);
});

test("builds mental-model deltas and orders append-only decisions by confidence", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "Build review packet");
    const baseline = buildMentalModel();
    const first = core.submitEvent(options, "mental-baseline", "T0001", "MENTAL_MODEL_RECORDED", baseline);
    const retry = core.submitEvent(options, "mental-baseline", "T0001", "MENTAL_MODEL_RECORDED", baseline);
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    core.submitEvent(options, "decision-1", "T0001", "DECISION_RECORDED", {
        decision: "Use the existing event log.", rationale: "It is already append-only.", confidence: "high", impact: "high", evidence: "The event table preserves history.", status: "active"
    });
    core.processPendingEvents(options);
    core.submitEvent(options, "decision-2", "T0001", "DECISION_RECORDED", {
        decision: "Keep one boundary unresolved.", rationale: "More evidence is useful.", confidence: "medium", impact: "medium", evidence: "The boundary has partial coverage.", status: "unresolved"
    });
    core.submitEvent(options, "decision-3", "T0001", "DECISION_RECORDED", {
        decision: "Use a smaller event projection.", rationale: "It fully replaces the first choice.", confidence: "low", impact: "high", evidence: "The packet needs only task-local events.", status: "active", supersedesDecisionId: "D001"
    });
    core.submitEvent(options, "mental-final", "T0001", "MENTAL_MODEL_RECORDED", { ...baseline, verification: "Run the full test suite." });
    core.processPendingEvents(options);

    const packet = core.getReviewPacket(options, "T0001");
    assert.deepEqual(packet.changedFields, ["verification"]);
    assert.deepEqual(packet.decisions.map((decision: Record<string, unknown>) => decision.decisionId), ["D003", "D002", "D001"]);
    assert.equal(packet.decisions[2].status, "superseded");
    assert.equal(packet.decisions[2].supersededByDecisionId, "D003");
    assert.deepEqual(packet.unresolvedDecisionIds, ["D002"]);
    assert.throws(
        () => core.submitEvent(options, "invalid-supersession", "T0001", "DECISION_RECORDED", {
            decision: "Invalid decision.", rationale: "Exercise validation.", confidence: "low", impact: "low", evidence: "D000 is invalid.", status: "active", supersedesDecisionId: "D000"
        }),
        /Invalid decision ID/
    );
});

test("processes review-contract events and review transition in order without an audit gate", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "Review without mandatory reviewer");
    core.submitEvent(options, "batch-mental", "T0001", "MENTAL_MODEL_RECORDED", buildMentalModel());
    core.submitEvent(options, "batch-decision", "T0001", "DECISION_RECORDED", {
        decision: "Keep independent review optional.", rationale: "Small tasks should not pay a fixed review cost.", confidence: "high", impact: "medium", evidence: "The user explicitly chooses whether to request it.", status: "active"
    });
    core.submitEvent(options, "batch-enqueue", "T0001", "ENQUEUE_REQUESTED", {});
    const queued = core.processPendingEvents(options);
    assert.deepEqual(queued.results.map((result: Record<string, unknown>) => result.action), ["MENTAL_MODEL_RECORDED", "DECISION_RECORDED", "ENQUEUED"]);
    const activation = core.activateNextTask(options);
    assert.equal(activation.activated, true);
    assert.equal(activation.executionBrief.mentalModelRequired, false);
    core.submitEvent(options, "batch-review", "T0001", "REVIEW_REQUESTED", { summary: "Ready for user review." });
    const reviewed = core.processPendingEvents(options);
    assert.equal(reviewed.results[0].action, "REVIEW_READY");
    assert.equal(reviewed.results[0].reviewPacket.decisionCount, 1);
    assert.equal(core.getStatus(options, "T0001").reviewPacket.decisionCount, 1);
    assert.equal(core.settleProject(options).reviewPacket.decisionCount, 1);
    assert.equal(Object.hasOwn(core.getQueue(options).queue[0], "reviewPacket"), false);
});

test("maps review-contract CLI commands without exposing an audit subsystem", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.registerTask(options, "thread-one", "CLI review packet");
    const sharedArguments = ["--project-root", fixture.repositoryRoot, "--state-root", fixture.stateRoot, "--task", "T0001"];
    const mental = runCli([
        "record-mental-model", ...sharedArguments, "--event-key", "cli-mental", "--current-state", "No packet exists.", "--desired-outcome", "A packet exists.", "--approach", "Record one snapshot.", "--affected-areas", "CLI and core.", "--invariants", "Events stay append-only.", "--non-goals", "No audit engine.", "--verification", "Read the packet."
    ]);
    assert.equal(mental.status, 0, mental.stderr || mental.stdout);
    core.processPendingEvents(options);
    const decision = runCli([
        "record-decision", ...sharedArguments, "--event-key", "cli-decision", "--decision", "Use task-local events.", "--rationale", "They preserve history.", "--confidence", "medium", "--impact", "high", "--evidence", "The event is projected.", "--status", "active"
    ]);
    assert.equal(decision.status, 0, decision.stderr || decision.stdout);
    core.processPendingEvents(options);
    const packet = runCli(["review-packet", ...sharedArguments]);
    assert.equal(packet.status, 0, packet.stderr || packet.stdout);
    assert.equal(JSON.parse(packet.stdout).decisionCount, 1);
    const help = runCli(["help"]);
    assert.match(help.stdout, /record-mental-model/);
    assert.match(help.stdout, /record-decision/);
    assert.match(help.stdout, /review-packet/);
    assert.doesNotMatch(help.stdout, /review-audit|record-review|fingerprint|comparator/u);
});

test("documents independent review as an explicit user choice", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    const protocolText = fs.readFileSync(path.join(__dirname, "..", "references", "protocol.md"), "utf8");
    assert.match(skillText, /Ask whether the user wants an independent review by a second agent/);
    assert.match(skillText, /Do not start one automatically/);
    assert.match(skillText, /fresh context and no inherited conversation/);
    assert.match(skillText, /is not persisted in SQLite, and is not an approval gate/);
    assert.match(protocolText, /The review is opt-in/);
    assert.match(protocolText, /declining it or approving directly starts no agent and adds no gate/);
});

test("documents just-in-time mental-model bootstrap for activated tasks", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    const protocolText = fs.readFileSync(path.join(__dirname, "..", "references", "protocol.md"), "utf8");
    assert.match(skillText, /A task may enter the queue and activate without one/);
    assert.match(skillText, /`mentalModelRequired: true`/);
    assert.match(skillText, /before its first project-file write/);
    assert.match(protocolText, /`REVIEW_REQUESTED` remains the hard gate/);
    assert.match(protocolText, /The deterministic core never fabricates generic mental-model content/);
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
    assert.match(cliResult.stdout, /Run now/);
    assert.match(cliResult.stdout, /Depends on T0002/);
    assert.match(cliResult.stdout, /request-user-input --project-root/);
    assert.match(cliResult.stdout, /request-user-response --project-root/);
});

test("documents init as creation of a silent manual Control Room task", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /Create one top-level task in that project with the \*\*Local\*\* environment/);
    assert.match(skillText, /initial prompt `\$control-room console`/);
    assert.match(skillText, /Leave the calling task unchanged and unregistered/);
    assert.match(skillText, /does not process routine events or receive wake notifications/);
    assert.match(skillText, /Require `routing\.installed: true` in the `init` result/);
    assert.match(skillText, /apply the title of every task in the returned final `queue`/);
});

test("documents project-scoped automatic registration and mandatory title synchronization", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    assert.match(skillText, /status --project-root <canonical-root> --thread-id <current-thread-id>/);
    assert.match(skillText, /If the complete request is purely read-only, fulfill it without running `register`, assigning a `T_ID`, or changing the title/);
    assert.match(skillText, /concrete plan, design, specification, or brief intended for a later project change as change work/);
    assert.match(skillText, /If a later message in an unregistered conversation requests change work, evaluate registration again/);
    assert.match(skillText, /Explicit `\$control-room join` always adopts the task/);
    assert.match(skillText, /If it returns `UNREGISTERED`, apply the exclusion policy/);
    assert.match(skillText, /If the task is not excluded, classify the requested outcome/);
    assert.match(skillText, /If the project is not initialized, continue without registration or commentary/);
    assert.match(skillText, /active `AGENTS\.md` or `AGENTS\.override\.md` at the project Git root/);
    assert.match(skillText, /Never modify global Codex instructions/);
    assert.match(skillText, /Apply every `titleUpdates` entry with the Codex app title tool before sending the final response/);
    assert.match(skillText, /A `DONE` task must receive its returned `🟢` title/);
});

test("documents persistent task exclusions and the brand-forge default", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    const protocolText = fs.readFileSync(path.join(__dirname, "..", "references", "protocol.md"), "utf8");
    const readmeText = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
    const help = runCli(["help"]);

    assert.match(skillText, /The automatic skill-exclusion list contains exactly/);
    assert.match(skillText, /otherwise triggers the installed `brand-forge` skill/);
    assert.match(skillText, /exact standalone directive/);
    assert.match(skillText, /Treat mentions in prose, quoted text, code, or tool output as ordinary text/);
    assert.match(skillText, /both standalone `\$control-room exclude` and `\$control-room join`/);
    assert.match(skillText, /An explicit `\$control-room join` is the only normal override/);
    assert.match(skillText, /request-exclude/);
    assert.match(skillText, /processed task becomes `CANCELED`, leaves and compacts the active queue/);
    assert.match(skillText, /restores the same `T_ID` from `CANCELED` to `PLANNING`/);
    assert.match(protocolText, /status --thread-id` returns `EXCLUDED`/);
    assert.match(protocolText, /first compact reason/);
    assert.match(protocolText, /Submission accepts only `PLANNING` or `QUEUED`/);
    assert.match(protocolText, /returns the excluded task's undecorated semantic title plus all affected queued titles/);
    assert.match(protocolText, /--adopt-excluded true/);
    assert.match(readmeText, /For a registered `PLANNING` or `QUEUED` task/);
    assert.match(readmeText, /leaves and compacts the queue, and regains its semantic title/);
    assert.equal(help.status, 0, help.stderr || help.stdout);
    assert.match(help.stdout, /^\s+\$control-room exclude$/m);
    assert.match(help.stdout, /^\s+exclude --project-root ROOT --thread-id ID --reason TEXT/m);
    assert.match(help.stdout, /^\s+request-exclude --project-root ROOT --task T0001/m);
});

test("documents the temporary user-attention marker and direct-response reset", () => {
    const skillText = fs.readFileSync(path.join(__dirname, "..", "SKILL.md"), "utf8");
    const protocolText = fs.readFileSync(path.join(__dirname, "..", "references", "protocol.md"), "utf8");
    assert.match(skillText, /`RUNNING` while awaiting direct user input: `👉 T0001 - Semantic name`/);
    assert.match(skillText, /does not change the underlying task state, queue order, branch, or Git behavior/);
    assert.match(skillText, /Never set it in `PLANNING` or `REVIEW`/);
    assert.match(skillText, /Do not use it for optional questions, routine progress updates, or the ordinary approval expected after entering `REVIEW`/);
    assert.match(skillText, /Do not clear attention for agent messages, activation briefs, tool output, automatic continuations, or background activity/);
    assert.match(protocolText, /`USER_INPUT_RECEIVED` clears the flag on the next direct user message/);
});
