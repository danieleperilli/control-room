import type { IControlRoomOptions } from "../scripts/control-room-types.ts";
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const core = require("../scripts/control-room-core.ts");
const { createFixture, initializeFixture, activateTask, registerTask, runCli, runGit } = require("./helpers.ts");

/** Create an initialized disposable project with one reviewed worker. */
function reviewFixture() {
    const fixture = createFixture();
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    const databasePath = initializeFixture(fixture);
    activateTask(options, "worker", "Fixture feature", "start");
    fs.writeFileSync(path.join(options.projectRoot, "feature.txt"), "verified fixture change\n");
    core.submitEvent(options, "review", "T0001", "REVIEW_REQUESTED", { summary: "Fixture content verified." });
    core.processPendingEvents(options);
    return { options, databasePath, initialCommit: fixture.initialCommit };
}

/**
 * Submit one automatic completion with distinct review and authorization anchors.
 * @param options Disposable project settings.
 * @param eventKey Approval retry key.
 * @param authorizationKey Project on command being used.
 * @param reviewKey Completed review being approved.
 * @param taskId Reviewed worker identifier.
 */
function requestAutomaticApproval(options: IControlRoomOptions, eventKey: string, authorizationKey = "on", reviewKey = "review", taskId = "T0001") {
    return core.submitEvent(options, eventKey, taskId, "APPROVAL_REQUESTED", {
        autopilotEventKey: authorizationKey,
        reviewEventKey: reviewKey,
        verification: "Verified fixture content and checked the complete diff.",
        commitMessage: "Add verified fixture content"
    });
}

/** Verify project mode changes never adopt the caller or implicitly start planning work. */
test("autopilot works from any project chat and survives a new CLI process", () => {
    const { options } = reviewFixture();
    registerTask(options, "planner", "Future work");
    core.excludeTask(options, "excluded", "User opt out");
    assert.equal(core.getStatus(options).autopilot.enabled, false);
    assert.equal(core.getQueue(options).autopilot.enabled, false);
    const enabled = runCli(["autopilot", "--project-root", options.projectRoot, "--state-root", options.stateRoot, "--mode", "on", "--event-key", "on", "--user-request-id", "user-on", "--thread-id", "excluded"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    for (const thread of ["control-room-thread", "worker", "excluded", "side-chat"]) {
        assert.equal(core.getStatus(options, undefined, thread).autopilot.enabled, true);
    }
    assert.equal(core.getStatus(options, undefined, "excluded").role, "EXCLUDED");
    assert.equal(core.getStatus(options, undefined, "side-chat").role, "UNREGISTERED");
    assert.equal(core.getStatus(options, "T0002").task.state, "PLANNING");
    const status = runCli(["status", "--project-root", options.projectRoot, "--state-root", options.stateRoot]);
    assert.equal(JSON.parse(status.stdout).autopilot.eventKey, "on");
    core.setAutopilot(options, false, "off", "user-off", "side-chat");
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.equal(core.getStatus(options).autopilot.enabled, false);
    assert.equal(core.getStatus(options).nextTaskId, "T0003");
});

/** Verify automatic completion commits once and activates the next eligible worker. */
test("verified automatic approval records provenance and advances the dependent queue", () => {
    const { options, databasePath } = reviewFixture();
    core.setAutopilot(options, true, "on", "original-user-on", "console");
    registerTask(options, "successor", "Dependent feature");
    core.submitEvent(options, "dependency", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(options, "enqueue-successor", "T0002", "ENQUEUE_REQUESTED", { userRequestId: "user-enqueue" });
    core.processPendingEvents(options);
    const approval = runCli(["request-autopilot-approve", "--project-root", options.projectRoot, "--state-root", options.stateRoot, "--task", "T0001", "--event-key", "auto", "--autopilot-event-key", "on", "--review-event-key", "review", "--verification", "Verified fixture diff and file contents.", "--commit-message", "Add verified fixture content"]);
    assert.equal(approval.status, 0, approval.stderr);
    const settled = core.settleProject(options);
    assert.equal(settled.completion.task.state, "DONE");
    assert.equal(settled.activation.task.taskId, "T0002");
    assert.equal(settled.activation.executionBrief.activationRequest.userRequestId, "user-enqueue");
    assert.equal(settled.autopilot.enabled, true);
    const queue = core.getQueue(options);
    assert.deepEqual(queue.progress, { completed: 1, total: 2 });
    assert.equal(queue.completedTasks[0].taskId, "T0001");
    assert.equal(queue.queue[0].state, "RUNNING");
    const database = new DatabaseSync(databasePath);
    const event = database.prepare("SELECT payload_json, result_json FROM events WHERE event_key = 'auto'").get();
    database.close();
    assert.equal(JSON.parse(event.payload_json).userRequestId, "original-user-on");
    assert.equal(JSON.parse(event.payload_json).reviewEventKey, "review");
    assert.equal(JSON.parse(event.result_json).approvalMode, "autopilot");
    assert.equal(runGit(options.projectRoot, ["show", "main:feature.txt"]), "verified fixture change");
    const completedHead = runGit(options.projectRoot, ["rev-parse", "main"]);
    core.settleProject(options);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), completedHead);
    core.setAutopilot(options, false, "off", "user-off", "other-chat");
    assert.equal(core.getStatus(options, "T0002").task.state, "RUNNING");
});

/** Verify old commands and approvals cannot undo an intervening off command. */
test("off rejects pending automatic approvals and stale command retries cannot reenable it", () => {
    const { options, initialCommit } = reviewFixture();
    core.setAutopilot(options, true, "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    core.setAutopilot(options, false, "off", "user-off", "worker");
    assert.equal(core.setAutopilot(options, true, "on", "user-on", "console").autopilot.enabled, false);
    assert.throws(() => core.setAutopilot(options, false, "on", "user-on", "console"), /different content/);
    const processed = core.processPendingEvents(options);
    assert.equal(processed.results[0].action, "REJECTED");
    assert.match(processed.results[0].error, /disabled or superseded/);
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    core.setAutopilot(options, true, "on-again", "user-on-again", "console");
    assert.throws(() => requestAutomaticApproval(options, "stale"), /disabled or superseded/);
    assert.equal(requestAutomaticApproval(options, "auto").created, false);
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    requestAutomaticApproval(options, "fresh", "on-again");
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
});

/** Verify revocation preserves the workspace and manual approval remains usable. */
test("off revokes an accepted unleased automatic approval but preserves manual approvals", () => {
    const { options, initialCommit } = reviewFixture();
    core.setAutopilot(options, true, "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    const disabled = core.setAutopilot(options, false, "off", "user-off", "side-chat");
    assert.equal(disabled.titleUpdates[0].title, "💪 T0001 - Fixture feature");
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.throws(() => core.commitApprovedTask(options, "T0001"), /from REVIEW/);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    assert.equal(fs.readFileSync(path.join(options.projectRoot, "feature.txt"), "utf8"), "verified fixture change\n");
    core.submitEvent(options, "manual", "T0001", "APPROVAL_REQUESTED", { userRequestId: "manual-user", commitMessage: "Approve fixture content manually" });
    core.processPendingEvents(options);
    core.setAutopilot(options, false, "off-again", "user-off-again", "console");
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
});

/** Verify review revisions invalidate approval evidence both before and after submission. */
test("automatic approval rejects stale review after rework", () => {
    const { options } = reviewFixture();
    core.setAutopilot(options, true, "on", "user-on", "console");
    requestAutomaticApproval(options, "pending-auto");
    core.submitEvent(options, "rework", "T0001", "REWORK_REQUESTED", {});
    const results = core.processPendingEvents(options).results;
    assert.equal(results[0].action, "REJECTED");
    assert.equal(results[1].action, "REWORK_STARTED");
    assert.throws(() => requestAutomaticApproval(options, "running-auto"), /in REVIEW/);
    core.submitEvent(options, "new-review", "T0001", "REVIEW_REQUESTED", { summary: "Reworked content checked." });
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").reviewPacket.reviewEventKey, "new-review");
    assert.throws(() => requestAutomaticApproval(options, "stale-review"), /latest successful review/);
    requestAutomaticApproval(options, "fresh-review", "on", "new-review");
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
});

for (const kind of ["REWORK_REQUESTED", "REVIEW_REQUESTED", "BLOCKED_REPORTED", "CANCEL_REQUESTED", "APPROVAL_REQUESTED"]) {
    /** Verify newer instructions take priority even after automatic approval was processed. */
    test(`new ${kind} supersedes an unleased automatic approval`, () => {
        const { options, initialCommit } = reviewFixture();
        core.setAutopilot(options, true, "on", "user-on", "console");
        requestAutomaticApproval(options, "auto");
        core.processPendingEvents(options);
        const payload =
            kind === "BLOCKED_REPORTED" ? { reason: "Verification found a regression" } :
            kind === "CANCEL_REQUESTED" ? { userRequestId: "user-cancel" } :
            kind === "APPROVAL_REQUESTED" ? { userRequestId: "user-pause", approvalTarget: "PAUSED", commitMessage: "Preserve verified fixture checkpoint" } :
            {};
        core.submitEvent(options, "intervention", "T0001", kind, payload);
        assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
        const settlement = core.settleProject(options);
        const result = settlement.processed.results[0];
        assert.notEqual(result.action, "REJECTED", result.error);
        if (kind === "APPROVAL_REQUESTED") {
            assert.equal(settlement.completion.task.state, "PAUSED");
        } else {
            assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
        }
        if (kind === "REVIEW_REQUESTED") {
            assert.ok(settlement.titleUpdates.some((update: { title: string }) => update.title === "💪 T0001 - Fixture feature"));
        }
    });
}

/** Verify requests arriving after submission cannot disappear behind the automatic event. */
test("pending blocker or newer review prevents automatic approval from being processed", () => {
    for (const kind of ["BLOCKED_REPORTED", "REVIEW_REQUESTED"]) {
        const { options, initialCommit } = reviewFixture();
        core.setAutopilot(options, true, "on", "user-on", "console");
        requestAutomaticApproval(options, "auto");
        core.submitEvent(options, "later", "T0001", kind, kind === "BLOCKED_REPORTED" ? { reason: "New failure" } : {});
        const processed = core.processPendingEvents(options).results;
        assert.equal(processed[0].action, "REJECTED");
        assert.notEqual(processed[1].action, "REJECTED");
        assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    }
});

/** Verify review cannot clear a user question while autopilot is active. */
test("autopilot review preserves unanswered user input", () => {
    const { options } = reviewFixture();
    core.setAutopilot(options, true, "on", "user-on", "console");
    core.submitEvent(options, "rework", "T0001", "REWORK_REQUESTED", {});
    core.processPendingEvents(options);
    core.submitEvent(options, "question", "T0001", "USER_INPUT_REQUESTED", {});
    core.submitEvent(options, "premature-review", "T0001", "REVIEW_REQUESTED", {});
    const processed = core.processPendingEvents(options).results;
    assert.equal(processed[1].action, "REJECTED");
    assert.equal(core.getStatus(options, "T0001").task.awaitingUser, true);
    assert.throws(() => core.submitEvent(options, "another-review", "T0001", "REVIEW_REQUESTED", {}), /awaited user input/);
    core.submitEvent(options, "user-answer", "T0001", "USER_INPUT_RECEIVED", {});
    core.processPendingEvents(options);
    core.submitEvent(options, "answered-review", "T0001", "REVIEW_REQUESTED", {});
    core.processPendingEvents(options);
    requestAutomaticApproval(options, "auto", "on", "answered-review");
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
});

/** Verify the progress snapshot distinguishes delivery uncertainty without exposing claim tokens. */
test("queue progress exposes pending and claimed deliveries with the integration lease", () => {
    const { options } = reviewFixture();
    registerTask(options, "successor", "Successor work");
    core.submitEvent(options, "enqueue-next", "T0002", "ENQUEUE_REQUESTED", {});
    core.processPendingEvents(options);
    core.setAutopilot(options, true, "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    const activation = core.settleProject(options).activation;
    const pending = core.getQueue(options);
    assert.equal(pending.pendingActivations[0].state, "PENDING");
    assert.equal(pending.integrationTaskId, null);
    core.claimActivation(options, activation.executionBrief.activationKey);
    const claimed = core.getQueue(options);
    assert.equal(claimed.pendingActivations[0].state, "CLAIMED");
    assert.equal(claimed.pendingActivations[0].claimToken, undefined);
});

/** Verify incomplete verification and unresolved decisions cannot become automatic approval. */
test("automatic approval requires verification and resolved confident decisions", () => {
    const { options } = reviewFixture();
    core.setAutopilot(options, true, "on", "user-on", "console");
    assert.throws(() => core.submitEvent(options, "no-evidence", "T0001", "APPROVAL_REQUESTED", { autopilotEventKey: "on", reviewEventKey: "review", commitMessage: "Apply fixture verification" }), /verification summary.*required/);
    assert.throws(() => core.submitEvent(options, "spoofed", "T0001", "APPROVAL_REQUESTED", { autopilotEventKey: "on", userRequestId: "invented", reviewEventKey: "review", verification: "Checked", commitMessage: "Apply fixture verification" }), /derives its user request/);
    assert.throws(() => core.submitEvent(options, "pause", "T0001", "APPROVAL_REQUESTED", { autopilotEventKey: "on", approvalTarget: "PAUSED", commitMessage: "Apply fixture checkpoint" }), /completed work/);
    core.submitEvent(options, "rework", "T0001", "REWORK_REQUESTED", {});
    core.processPendingEvents(options);
    core.submitEvent(options, "decision", "T0001", "DECISION_RECORDED", { decision: "Select fixture behavior", rationale: "Awaiting product choice", confidence: "low", impact: "high", evidence: "Two incompatible requirements", status: "unresolved" });
    core.submitEvent(options, "next-review", "T0001", "REVIEW_REQUESTED", {});
    core.processPendingEvents(options);
    assert.throws(() => requestAutomaticApproval(options, "unresolved", "on", "next-review"), /Resolve pending or low-confidence/);
    core.submitEvent(options, "manual", "T0001", "APPROVAL_REQUESTED", { userRequestId: "explicit-user-choice", commitMessage: "Accept fixture behavior explicitly" });
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
});

/** Verify a later failure in concurrent work is checked again before Git side effects. */
test("active blockers stop automatic integration and advancement", () => {
    const { options, initialCommit } = reviewFixture();
    core.setAutopilot(options, true, "on", "user-on", "console");
    registerTask(options, "isolated", "Parallel work");
    core.installWorktreeIgnore(options);
    core.submitEvent(options, "isolated-start", "T0002", "RUN_ISOLATED_NOW_REQUESTED", {});
    core.processPendingEvents(options);
    core.activateIsolatedTask(options, "T0002");
    requestAutomaticApproval(options, "auto");
    core.submitEvent(options, "attention", "T0002", "USER_INPUT_REQUESTED", {});
    core.processPendingEvents(options);
    assert.throws(() => core.commitApprovedTask(options, "T0001"), /attention or recovery on T0002/);
    assert.equal(core.getStatus(options).commitTaskId, null);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    assert.equal(core.activateNextTask(options).reason, "AUTOPILOT_WAITING");
});

/** Verify migration adds disabled mode without changing existing task or event data. */
test("schema 18 migrates to manual mode and read-only commands never migrate it", () => {
    const { options, databasePath } = reviewFixture();
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE autopilot_requests; PRAGMA user_version = 18;");
    const before = database.prepare("SELECT * FROM events ORDER BY sequence").all();
    database.close();
    assert.equal(core.getStatus(options).reason, "MIGRATION_REQUIRED");
    assert.equal(core.getQueue(options).reason, "MIGRATION_REQUIRED");
    core.installProjectRouting(options);
    assert.equal(core.getStatus(options).autopilot.enabled, false);
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    const migrated = new DatabaseSync(databasePath);
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 19);
    assert.deepEqual(migrated.prepare("SELECT * FROM events ORDER BY sequence").all(), before);
    migrated.close();
});

for (const isolated of [false, true]) {
    for (const committed of [false, true]) {
        /** Verify off preserves committed work but revokes a retry that has not created a commit. */
        test(`off during ${isolated ? "isolated" : "shared"} recovery ${committed ? "after" : "before"} commit`, () => {
            const fixture = createFixture();
            const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
            initializeFixture(fixture);
            core.installWorktreeIgnore(options);
            runGit(options.projectRoot, ["add", ".gitignore"]);
            runGit(options.projectRoot, ["commit", "-m", "Ignore fixture worktrees"]);
            registerTask(options, "worker", "Recoverable work");
            core.submitEvent(options, "start", "T0001", isolated ? "RUN_ISOLATED_NOW_REQUESTED" : "RUN_NOW_REQUESTED", {});
            const settled = core.settleProject(options);
            const activation = isolated ? settled.isolatedActivations[0] : settled.activation;
            fs.writeFileSync(path.join(activation.executionBrief.workspacePath, "feature.txt"), "verified recovery fixture\n");
            core.submitEvent(options, "review", "T0001", "REVIEW_REQUESTED", {});
            core.processPendingEvents(options);
            core.setAutopilot(options, true, "on", "user-on", "console");
            requestAutomaticApproval(options, "auto");
            core.processPendingEvents(options);
            const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-operation.ts"), options.projectRoot, options.stateRoot, "T0001", "commit", JSON.stringify(committed ? ["commit"] : ["add", "-A"])], { encoding: "utf8" });
            assert.equal(killed.signal, "SIGKILL", killed.stderr || killed.stdout);
            assert.equal(core.getQueue(options).integrationTaskId, "T0001");
            assert.equal(core.setAutopilot(options, false, "off", "user-off", "other-chat").integrationTaskId, "T0001");
            assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
            const recovered = core.recoverCommit(options, "T0001");
            assert.equal(recovered.finalized, committed);
            assert.equal(core.getStatus(options).autopilot.enabled, false);
            assert.equal(core.getStatus(options, "T0001").task.state, committed ? "DONE" : "REVIEW");
            if (!committed) {
                assert.equal(recovered.retryCommit, false);
                assert.equal(recovered.titleUpdates[0].taskId, "T0001");
                assert.equal(fs.readFileSync(path.join(activation.executionBrief.workspacePath, "feature.txt"), "utf8"), "verified recovery fixture\n");
            }
        });
    }
}

/** Verify recovery never extends an existing automatic commit with newly modified content. */
test("isolated recovery after off preserves new unverified dirty work", () => {
    const fixture = createFixture();
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    initializeFixture(fixture);
    core.installWorktreeIgnore(options);
    runGit(options.projectRoot, ["add", ".gitignore"]);
    runGit(options.projectRoot, ["commit", "-m", "Ignore fixture worktrees"]);
    registerTask(options, "worker", "Recoverable feature");
    core.submitEvent(options, "start", "T0001", "RUN_ISOLATED_NOW_REQUESTED", {});
    const activation = core.settleProject(options).isolatedActivations[0];
    const workspacePath = activation.executionBrief.workspacePath;
    fs.writeFileSync(path.join(workspacePath, "feature.txt"), "reviewed content\n");
    core.submitEvent(options, "review", "T0001", "REVIEW_REQUESTED", {});
    core.processPendingEvents(options);
    core.setAutopilot(options, true, "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    core.processPendingEvents(options);
    const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-operation.ts"), options.projectRoot, options.stateRoot, "T0001", "commit", JSON.stringify(["commit"])], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr || killed.stdout);
    core.setAutopilot(options, false, "off", "user-off", "console");
    const approvedHead = runGit(workspacePath, ["rev-parse", "HEAD"]);
    const baseHead = runGit(options.projectRoot, ["rev-parse", "main"]);
    fs.writeFileSync(path.join(workspacePath, "feature.txt"), "new unverified content\n");
    assert.throws(() => core.recoverCommit(options, "T0001"), /unchanged committed work/);
    assert.equal(runGit(workspacePath, ["rev-parse", "HEAD"]), approvedHead);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), baseHead);
    assert.equal(fs.readFileSync(path.join(workspacePath, "feature.txt"), "utf8"), "new unverified content\n");
    assert.equal(core.getStatus(options).autopilot.enabled, false);
});
