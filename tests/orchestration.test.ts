import type { IControlRoomOptions, OrchestrationMode } from "../scripts/control-room-types.ts";
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
        orchestrationEventKey: authorizationKey,
        reviewEventKey: reviewKey,
        verification: "Verified fixture content and checked the complete diff.",
        commitMessage: "Add verified fixture content"
    });
}

for (const mode of ["approve-next", "manual-next"] as OrchestrationMode[]) {
    /** Verify manual approval saves work and respects the selected progression policy. */
    test(`${mode} requires approval and controls successor activation`, () => {
        const { options, initialCommit } = reviewFixture();
        core.setOrchestration(options, mode, "selection", "select-mode", "worker");
        registerTask(options, "successor", "Dependent work");
        registerTask(options, "independent", "Independent work");
        core.submitEvent(options, "dependency", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
        for (const taskId of ["T0002", "T0003"]) {
            core.submitEvent(options, `enqueue-${taskId}`, taskId, "ENQUEUE_REQUESTED", { userRequestId: `queue-${taskId}` });
        }
        core.settleProject(options);
        assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
        assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
        assert.throws(() => requestAutomaticApproval(options, "unapproved", "selection"));
        core.submitEvent(options, "approve", "T0001", "APPROVAL_REQUESTED", { userRequestId: "user-approve", commitMessage: "Save verified fixture feature" });
        const settled = core.settleProject(options);
        assert.equal(settled.completion.task.state, "DONE");
        assert.equal(runGit(options.projectRoot, ["show", "main:feature.txt"]), "verified fixture change");
        assert.equal(core.getStatus(options, "T0002").task.state, mode === "manual-next" ? "QUEUED" : "RUNNING");
        assert.equal(core.getStatus(options, "T0003").task.state, "QUEUED");
        if (mode === "manual-next") {
            assert.equal(settled.activation.reason, "MANUAL_RUN_REQUIRED");
            assert.deepEqual(settled.pendingActivations, []);
            assert.deepEqual(core.getQueue(options).queue.map((task: { taskId: string }) => task.taskId), ["T0002", "T0003"]);
            assert.equal(core.settleProject(options).activation.activated, false);
            assert.equal(core.activateNextTask(options).activated, false);
            assert.equal(runGit(options.projectRoot, ["branch", "--show-current"]), "main");
            // A direct Run selects its own task even when another task is first in the queue.
            core.submitEvent(options, "run-independent", "T0003", "RUN_NOW_REQUESTED", { userRequestId: "direct-run" });
            const started = core.settleProject(options).activation;
            assert.equal(started.task.taskId, "T0003");
            assert.equal(started.executionBrief.activationRequest.userRequestId, "direct-run");
            core.submitEvent(options, "approve-independent", "T0003", "APPROVAL_REQUESTED", { userRequestId: "approve-independent", commitMessage: "Complete independent fixture work" });
            assert.equal(core.settleProject(options).completion.task.state, "DONE");
            assert.equal(core.getStatus(options, "T0002").task.state, "QUEUED");
            core.submitEvent(options, "run-dependent", "T0002", "RUN_NOW_REQUESTED", { userRequestId: "run-dependent" });
            assert.equal(core.settleProject(options).activation.task.taskId, "T0002");
        }
    });
}

/** Verify persistence, read-only status, idle enqueue, and idempotent mode retries. */
test("manual-next enqueue stays idle and mode status does not register or activate the caller", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    registerTask(options, "worker", "Waiting work");
    const args = ["--project-root", options.projectRoot, "--state-root", options.stateRoot];
    const selected = runCli(["orchestration", ...args, "--mode", "manual-next", "--event-key", "manual", "--user-request-id", "user-manual", "--thread-id", "side-chat"]);
    assert.equal(selected.status, 0, selected.stderr);
    core.submitEvent(options, "enqueue", "T0001", "ENQUEUE_REQUESTED", {});
    assert.equal(core.settleProject(options).activation.reason, "MANUAL_RUN_REQUIRED");
    assert.equal(runGit(options.projectRoot, ["branch", "--show-current"]), "main");
    const snapshot = runCli(["orchestration", ...args, "--mode", "status"]);
    assert.equal(snapshot.status, 0, snapshot.stderr);
    assert.equal(JSON.parse(snapshot.stdout).orchestration.mode, "manual-next");
    assert.equal(core.getStatus(options, undefined, "side-chat").role, "UNREGISTERED");
    assert.equal(core.getStatus(options, "T0001").task.state, "QUEUED");
    core.setOrchestration(options, "approve-next", "resume", "user-resume", "side-chat");
    assert.equal(core.getStatus(options, "T0001").task.state, "QUEUED");
    assert.equal(core.settleProject(options).activation.task.taskId, "T0001");
    assert.equal(core.setOrchestration(options, "manual-next", "manual", "user-manual", "side-chat").orchestration.mode, "approve-next");
});

/** Verify explicit isolation does not grant automatic activation to waiting shared work. */
test("manual-next permits explicit isolated starts without starting the shared queue", () => {
    const fixture = createFixture();
    initializeFixture(fixture);
    const options = { projectRoot: fixture.repositoryRoot, stateRoot: fixture.stateRoot };
    core.installWorktreeIgnore(options);
    runGit(options.projectRoot, ["add", ".gitignore"]);
    runGit(options.projectRoot, ["commit", "-m", "Ignore fixture worktrees"]);
    core.setOrchestration(options, "manual-next", "manual", "user-manual", "worker");
    registerTask(options, "waiting", "Shared work");
    registerTask(options, "isolated", "Isolated work");
    core.submitEvent(options, "enqueue", "T0001", "ENQUEUE_REQUESTED", {});
    core.submitEvent(options, "run-isolated", "T0002", "RUN_ISOLATED_NOW_REQUESTED", { userRequestId: "explicit-isolated" });
    const settled = core.settleProject(options);
    assert.equal(settled.isolatedActivations[0].task.taskId, "T0002");
    assert.equal(settled.activation.activated, false);
    core.submitEvent(options, "approve-isolated", "T0002", "APPROVAL_REQUESTED", { userRequestId: "approve-isolated", commitMessage: "Complete isolated fixture work" });
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
    assert.equal(core.getStatus(options, "T0001").task.state, "QUEUED");
});

/** Verify mode changes revoke automatic authorization and reject invalid settings. */
test("manual-next revokes automatic approvals and rejects unsupported mode values", () => {
    const { options, initialCommit } = reviewFixture();
    core.setOrchestration(options, "auto-next", "on", "user-on", "worker");
    requestAutomaticApproval(options, "auto");
    core.processPendingEvents(options);
    core.setOrchestration(options, "manual-next", "manual", "user-manual", "side-chat");
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.throws(() => requestAutomaticApproval(options, "stale"), /disabled or superseded/);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    assert.throws(() => core.setOrchestration(options, "unsupported", "invalid", "user-invalid", "worker"));
    const args = ["--project-root", options.projectRoot, "--state-root", options.stateRoot];
    for (const mode of ["on", "off", "unsupported"]) {
        assert.notEqual(runCli(["orchestration", ...args, "--mode", mode]).status, 0);
    }
    assert.notEqual(runCli(["autopilot", ...args, "--mode", "on"]).status, 0);
    assert.equal(core.getStatus(options).orchestration.mode, "manual-next");
});

/** Verify deferring a successor does not reuse the Run that authorized its canceled activation. */
test("manual-next requires a new Run after an earlier activation was deferred", () => {
    const { options } = reviewFixture();
    core.setOrchestration(options, "manual-next", "manual", "user-manual", "worker");
    core.submitEvent(options, "approve-first", "T0001", "APPROVAL_REQUESTED", { userRequestId: "approve-first", commitMessage: "Save first verified fixture feature" });
    core.settleProject(options);
    registerTask(options, "successor", "Successor work");
    core.submitEvent(options, "run-successor", "T0002", "RUN_NOW_REQUESTED", { userRequestId: "run-successor" });
    const first = core.settleProject(options).activation;
    assert.equal(first.task.taskId, "T0002");
    core.submitEvent(options, "handoff-blocked", "T0001", "USER_INPUT_REQUESTED", { handoffTaskId: "T0002" });
    core.settleProject(options);
    core.resumeTask(options, "T0001", true);
    assert.equal(core.settleProject(options).activation.reason, "MANUAL_RUN_REQUIRED");
    assert.equal(core.getStatus(options, "T0002").task.state, "QUEUED");
    assert.deepEqual(core.getPendingActivations(options), []);
    core.submitEvent(options, "run-predecessor", "T0001", "RUN_NOW_REQUESTED", { userRequestId: "run-predecessor" });
    assert.equal(core.settleProject(options).activation.task.taskId, "T0001");
    core.submitEvent(options, "approve-followup", "T0001", "APPROVAL_REQUESTED", { userRequestId: "approve-followup", commitMessage: "Complete predecessor follow-up work" });
    assert.equal(core.settleProject(options).activation.activated, false);
    core.submitEvent(options, "run-successor-again", "T0002", "RUN_NOW_REQUESTED", { userRequestId: "new-run-successor" });
    const second = core.settleProject(options).activation;
    assert.equal(second.task.taskId, "T0002");
    assert.notEqual(second.executionBrief.activationKey, first.executionBrief.activationKey);
    assert.equal(second.executionBrief.activationRequest.userRequestId, "new-run-successor");
});

for (const approvalState of ["pending", "approved", "revoked"]) {
    /** Verify migration retains historical authorization, task identity, and approval retries. */
    test(`legacy autopilot migrates with ${approvalState} approval and original provenance`, () => {
        const { options, databasePath } = reviewFixture();
        core.setOrchestration(options, "auto-next", "on", "original-enable-request", "original-chat");
        requestAutomaticApproval(options, "auto");
        if (approvalState !== "pending") {
            core.processPendingEvents(options);
        }
        if (approvalState === "revoked") {
            core.setOrchestration(options, "approve-next", "off", "original-disable-request", "original-chat");
        }
        const database = new DatabaseSync(databasePath);
        database.exec(`
            CREATE TABLE autopilot_requests (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                user_request_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO autopilot_requests SELECT sequence, event_key, CASE mode WHEN 'auto-next' THEN 1 ELSE 0 END, user_request_id, thread_id, created_at FROM orchestration_requests;
            DROP TABLE orchestration_requests;
            UPDATE events SET payload_json = replace(payload_json, '"orchestrationEventKey":', '"autopilotEventKey":');
            PRAGMA user_version = 22;
        `);
        const tasksBefore = database.prepare("SELECT * FROM tasks ORDER BY task_id").all();
        const requestsBefore = database.prepare("SELECT event_key, user_request_id, thread_id, created_at FROM autopilot_requests ORDER BY sequence").all();
        database.close();
        assert.equal(core.getStatus(options).reason, "MIGRATION_REQUIRED");
        assert.equal(core.getQueue(options).reason, "MIGRATION_REQUIRED");
        core.installProjectRouting(options);
        assert.equal(core.getStatus(options).orchestration.mode, approvalState === "revoked" ? "approve-next" : "auto-next");
        const migrated = new DatabaseSync(databasePath);
        assert.deepEqual(migrated.prepare("SELECT * FROM tasks ORDER BY task_id").all(), tasksBefore);
        assert.deepEqual(migrated.prepare("SELECT event_key, user_request_id, thread_id, created_at FROM orchestration_requests ORDER BY sequence").all(), requestsBefore);
        assert.equal(migrated.prepare("SELECT 1 FROM sqlite_master WHERE name = 'autopilot_requests'").get(), undefined);
        assert.equal(JSON.parse(migrated.prepare("SELECT payload_json FROM events WHERE event_key = 'auto'").get().payload_json).orchestrationEventKey, "on");
        migrated.close();
        assert.equal(requestAutomaticApproval(options, "auto").created, false);
        assert.equal(core.setOrchestration(options, "auto-next", "on", "original-enable-request", "original-chat").orchestration.mode, approvalState === "revoked" ? "approve-next" : "auto-next");
        if (approvalState === "revoked") {
            assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
            assert.throws(() => requestAutomaticApproval(options, "stale"), /disabled or superseded/);
        } else {
            assert.equal(core.settleProject(options).completion.task.state, "DONE");
        }
    });
}

/** Verify project mode changes never adopt the caller or implicitly start planning work. */
test("orchestration works from any project chat and survives a new CLI process", () => {
    const { options } = reviewFixture();
    registerTask(options, "planner", "Future work");
    core.excludeTask(options, "excluded", "User opt out");
    assert.equal(core.getStatus(options).orchestration.mode, "approve-next");
    assert.equal(core.getQueue(options).orchestration.mode, "approve-next");
    const enabled = runCli(["orchestration", "--project-root", options.projectRoot, "--state-root", options.stateRoot, "--mode", "auto-next", "--event-key", "on", "--user-request-id", "user-on", "--thread-id", "excluded"]);
    assert.equal(enabled.status, 0, enabled.stderr);
    for (const thread of ["control-room-thread", "worker", "excluded", "side-chat"]) {
        assert.equal(core.getStatus(options, undefined, thread).orchestration.mode, "auto-next");
    }
    assert.equal(core.getStatus(options, undefined, "excluded").role, "EXCLUDED");
    assert.equal(core.getStatus(options, undefined, "side-chat").role, "UNREGISTERED");
    assert.equal(core.getStatus(options, "T0002").task.state, "PLANNING");
    const status = runCli(["status", "--project-root", options.projectRoot, "--state-root", options.stateRoot]);
    assert.equal(JSON.parse(status.stdout).orchestration.eventKey, "on");
    core.setOrchestration(options, "approve-next", "off", "user-off", "side-chat");
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.equal(core.getStatus(options).orchestration.mode, "approve-next");
    assert.equal(core.getStatus(options).nextTaskId, "T0003");
});

/** Verify automatic completion commits once and activates the next eligible worker. */
test("verified automatic approval records provenance and advances the dependent queue", () => {
    const { options, databasePath } = reviewFixture();
    core.setOrchestration(options, "auto-next", "on", "original-user-on", "console");
    registerTask(options, "successor", "Dependent feature");
    core.submitEvent(options, "dependency", "T0002", "DEPENDENCY_ADD_REQUESTED", { dependencyTaskId: "T0001" });
    core.submitEvent(options, "enqueue-successor", "T0002", "ENQUEUE_REQUESTED", { userRequestId: "user-enqueue" });
    core.processPendingEvents(options);
    const approval = runCli(["request-auto-approve", "--project-root", options.projectRoot, "--state-root", options.stateRoot, "--task", "T0001", "--event-key", "auto", "--orchestration-event-key", "on", "--review-event-key", "review", "--verification", "Verified fixture diff and file contents.", "--commit-message", "Add verified fixture content"]);
    assert.equal(approval.status, 0, approval.stderr);
    const settled = core.settleProject(options);
    assert.equal(settled.completion.task.state, "DONE");
    assert.equal(settled.activation.task.taskId, "T0002");
    assert.equal(settled.activation.executionBrief.activationRequest.userRequestId, "user-enqueue");
    assert.equal(settled.orchestration.mode, "auto-next");
    const queue = core.getQueue(options);
    assert.deepEqual(queue.progress, { completed: 1, total: 2 });
    assert.equal(queue.completedTasks[0].taskId, "T0001");
    assert.equal(queue.queue[0].state, "RUNNING");
    const database = new DatabaseSync(databasePath);
    const event = database.prepare("SELECT payload_json, result_json FROM events WHERE event_key = 'auto'").get();
    database.close();
    assert.equal(JSON.parse(event.payload_json).userRequestId, "original-user-on");
    assert.equal(JSON.parse(event.payload_json).reviewEventKey, "review");
    assert.equal(JSON.parse(event.result_json).approvalMode, "auto-next");
    assert.equal(runGit(options.projectRoot, ["show", "main:feature.txt"]), "verified fixture change");
    const completedHead = runGit(options.projectRoot, ["rev-parse", "main"]);
    core.settleProject(options);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), completedHead);
    core.setOrchestration(options, "approve-next", "off", "user-off", "other-chat");
    assert.equal(core.getStatus(options, "T0002").task.state, "RUNNING");
});

/** Verify old commands and approvals cannot undo an intervening off command. */
test("off rejects pending automatic approvals and stale command retries cannot reenable it", () => {
    const { options, initialCommit } = reviewFixture();
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    core.setOrchestration(options, "approve-next", "off", "user-off", "worker");
    assert.equal(core.setOrchestration(options, "auto-next", "on", "user-on", "console").orchestration.mode, "approve-next");
    assert.throws(() => core.setOrchestration(options, "approve-next", "on", "user-on", "console"), /different content/);
    const processed = core.processPendingEvents(options);
    assert.equal(processed.results[0].action, "REJECTED");
    assert.match(processed.results[0].error, /disabled or superseded/);
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    core.setOrchestration(options, "auto-next", "on-again", "user-on-again", "console");
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
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    core.processPendingEvents(options);
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    const disabled = core.setOrchestration(options, "approve-next", "off", "user-off", "side-chat");
    assert.equal(disabled.orchestration.mode, "approve-next");
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    assert.throws(() => core.commitApprovedTask(options, "T0001"), /from REVIEW/);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    assert.equal(fs.readFileSync(path.join(options.projectRoot, "feature.txt"), "utf8"), "verified fixture change\n");
    core.submitEvent(options, "manual", "T0001", "APPROVAL_REQUESTED", { userRequestId: "manual-user", commitMessage: "Approve fixture content manually" });
    core.processPendingEvents(options);
    core.setOrchestration(options, "approve-next", "off-again", "user-off-again", "console");
    assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
    assert.equal(core.settleProject(options).completion.task.state, "DONE");
});

/** Verify review revisions invalidate approval evidence both before and after submission. */
test("automatic approval rejects stale review after rework", () => {
    const { options } = reviewFixture();
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
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
        core.setOrchestration(options, "auto-next", "on", "user-on", "console");
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
            assert.ok(settlement.titleUpdates.some((update: { taskId: string }) => update.taskId === "T0001"));
        }
    });
}

/** Verify requests arriving after submission cannot disappear behind the automatic event. */
test("pending blocker or newer review prevents automatic approval from being processed", () => {
    for (const kind of ["BLOCKED_REPORTED", "REVIEW_REQUESTED"]) {
        const { options, initialCommit } = reviewFixture();
        core.setOrchestration(options, "auto-next", "on", "user-on", "console");
        requestAutomaticApproval(options, "auto");
        core.submitEvent(options, "later", "T0001", kind, kind === "BLOCKED_REPORTED" ? { reason: "New failure" } : {});
        const processed = core.processPendingEvents(options).results;
        assert.equal(processed[0].action, "REJECTED");
        assert.notEqual(processed[1].action, "REJECTED");
        assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), initialCommit);
    }
});

/** Verify review cannot clear a user question while orchestration is active. */
test("orchestration review preserves unanswered user input", () => {
    const { options } = reviewFixture();
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
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
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
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
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
    assert.throws(() => core.submitEvent(options, "no-evidence", "T0001", "APPROVAL_REQUESTED", { orchestrationEventKey: "on", reviewEventKey: "review", commitMessage: "Apply fixture verification" }), /verification summary.*required/);
    assert.throws(() => core.submitEvent(options, "spoofed", "T0001", "APPROVAL_REQUESTED", { orchestrationEventKey: "on", userRequestId: "invented", reviewEventKey: "review", verification: "Checked", commitMessage: "Apply fixture verification" }), /derives its user request/);
    assert.throws(() => core.submitEvent(options, "pause", "T0001", "APPROVAL_REQUESTED", { orchestrationEventKey: "on", approvalTarget: "PAUSED", commitMessage: "Apply fixture checkpoint" }), /completed work/);
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
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
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
    assert.equal(core.activateNextTask(options).reason, "AUTO_NEXT_WAITING");
});

/** Verify migration adds disabled mode without changing existing task or event data. */
test("schema 18 migrates to approve-next and read-only commands never migrate it", () => {
    const { options, databasePath } = reviewFixture();
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE orchestration_requests; PRAGMA user_version = 18;");
    const before = database.prepare("SELECT * FROM events ORDER BY sequence").all();
    database.close();
    assert.equal(core.getStatus(options).reason, "MIGRATION_REQUIRED");
    assert.equal(core.getQueue(options).reason, "MIGRATION_REQUIRED");
    core.installProjectRouting(options);
    assert.equal(core.getStatus(options).orchestration.mode, "approve-next");
    assert.equal(core.getStatus(options, "T0001").task.state, "REVIEW");
    const migrated = new DatabaseSync(databasePath);
    assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 23);
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
            core.setOrchestration(options, "auto-next", "on", "user-on", "console");
            requestAutomaticApproval(options, "auto");
            core.processPendingEvents(options);
            const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-operation.ts"), options.projectRoot, options.stateRoot, "T0001", "commit", JSON.stringify(committed ? ["commit"] : ["add", "-A"])], { encoding: "utf8" });
            assert.equal(killed.signal, "SIGKILL", killed.stderr || killed.stdout);
            assert.equal(core.getQueue(options).integrationTaskId, "T0001");
            assert.equal(core.setOrchestration(options, "approve-next", "off", "user-off", "other-chat").integrationTaskId, "T0001");
            assert.equal(core.getStatus(options, "T0001").task.state, "APPROVED");
            const recovered = core.recoverCommit(options, "T0001");
            assert.equal(recovered.finalized, committed);
            assert.equal(core.getStatus(options).orchestration.mode, "approve-next");
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
    core.setOrchestration(options, "auto-next", "on", "user-on", "console");
    requestAutomaticApproval(options, "auto");
    core.processPendingEvents(options);
    const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-operation.ts"), options.projectRoot, options.stateRoot, "T0001", "commit", JSON.stringify(["commit"])], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr || killed.stdout);
    core.setOrchestration(options, "approve-next", "off", "user-off", "console");
    const approvedHead = runGit(workspacePath, ["rev-parse", "HEAD"]);
    const baseHead = runGit(options.projectRoot, ["rev-parse", "main"]);
    fs.writeFileSync(path.join(workspacePath, "feature.txt"), "new unverified content\n");
    assert.throws(() => core.recoverCommit(options, "T0001"), /unchanged committed work/);
    assert.equal(runGit(workspacePath, ["rev-parse", "HEAD"]), approvedHead);
    assert.equal(runGit(options.projectRoot, ["rev-parse", "main"]), baseHead);
    assert.equal(fs.readFileSync(path.join(workspacePath, "feature.txt"), "utf8"), "new unverified content\n");
    assert.equal(core.getStatus(options).orchestration.mode, "approve-next");
});
