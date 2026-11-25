const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const test: typeof import("node:test") = require("node:test");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
const core: import("../scripts/control-room-core.ts").IControlRoomApi = require("../scripts/control-room-core.ts");
const helpers: import("./helpers.ts").ITestHelpers = require("./helpers.ts");

/** Create a moved repository retaining its queue, event history and dirty files. */
function movedFixture() {
    const fixture = helpers.createFixture();
    const previousRoot = fs.realpathSync(fixture.repositoryRoot);
    const options = { projectRoot: previousRoot };
    core.initializeProject(options, "original-console", "main");
    core.registerTask(options, "worker-one", "Planning work");
    core.registerTask(options, "worker-two", "Queued work");
    core.submitEvent(options, "enqueue-two", "T0002", "ENQUEUE_REQUESTED", { userRequestId: "original-request" });
    core.processPendingEvents(options);
    core.excludeTask(options, "excluded-thread", "gu-research");
    fs.writeFileSync(path.join(previousRoot, "base.txt"), "uncommitted work\n");
    const before = core.getStatus(options, undefined, "worker-two");
    const projectRoot = path.join(path.dirname(previousRoot), "moved");
    fs.renameSync(previousRoot, projectRoot);
    return { previousRoot, projectRoot, before };
}

test("repository relocation preserves queue, history, exclusions, files and the next task identity", () => {
    const fixture = movedFixture();
    const options = { projectRoot: fixture.projectRoot };
    assert.equal(core.getStatus(options).reason, "NOT_INITIALIZED");
    const filename = path.join(fixture.projectRoot, ".control-room", "state.sqlite");
    const database = new DatabaseSync(filename, { readOnly: true });
    const eventsBefore = database.prepare("SELECT * FROM events").all();
    database.close();
    assert.equal(core.relocateProject(options, fixture.previousRoot, "original-console").relocated, true);
    const after = core.getStatus(options, undefined, "worker-two");
    assert.deepEqual(after, { ...fixture.before, projectRoot: fixture.projectRoot });
    assert.equal(core.getStatus(options, undefined, "excluded-thread").role, "EXCLUDED");
    assert.equal(core.registerTask(options, "worker-three", "New work").taskId, "T0003");
    assert.equal(fs.readFileSync(path.join(fixture.projectRoot, "base.txt"), "utf8"), "uncommitted work\n");
    const afterDatabase = new DatabaseSync(filename, { readOnly: true });
    assert.deepEqual(afterDatabase.prepare("SELECT * FROM events").all(), eventsBefore);
    afterDatabase.close();
    assert.equal(core.relocateProject(options, fixture.previousRoot, "original-console").alreadyApplied, true);
});

test("relocation rejects an incorrect console and a remaining source checkout", () => {
    const fixture = movedFixture();
    const options = { projectRoot: fixture.projectRoot };
    assert.throws(() => core.relocateProject(options, fixture.previousRoot, "other-console"), /console does not match/);
    fs.mkdirSync(path.join(fixture.previousRoot, ".git"), { recursive: true });
    assert.throws(() => core.relocateProject(options, fixture.previousRoot, "original-console"), /still exists/);
    assert.equal(core.getStatus(options).reason, "NOT_INITIALIZED");
});

test("relocation refuses active workers without rewriting their execution history", () => {
    const fixture = helpers.createFixture();
    const previousRoot = fs.realpathSync(fixture.repositoryRoot);
    const options = { projectRoot: previousRoot };
    core.initializeProject(options, "original-console", "main");
    core.installWorktreeIgnore(options);
    helpers.runGit(previousRoot, ["add", ".gitignore"]);
    helpers.runGit(previousRoot, ["commit", "-m", "Ignore runtime state"]);
    core.registerTask(options, "worker-one", "Active work");
    core.submitEvent(options, "run-one", "T0001", "RUN_NOW_REQUESTED", {});
    core.settleProject(options);
    const projectRoot = path.join(path.dirname(previousRoot), "moved");
    fs.renameSync(previousRoot, projectRoot);
    assert.throws(() => core.relocateProject({ projectRoot }, previousRoot, "original-console"), /active workers/);
    assert.equal(core.getStatus({ projectRoot }).reason, "NOT_INITIALIZED");
});
