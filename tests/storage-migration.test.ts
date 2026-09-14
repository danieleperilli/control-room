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

/** Create a registered project in the historical default location. */
function legacyFixture() {
    const fixture = helpers.createFixture();
    const projectRoot = fs.realpathSync(fixture.repositoryRoot);
    const codexHome = path.join(path.dirname(projectRoot), "codex-home");
    const options = { projectRoot, stateRoot: path.join(codexHome, "control-room", "projects") };
    const initialized = core.initializeProject(options, "original-console", "main");
    core.installProjectRouting(options);
    core.installWorktreeIgnore(options);
    core.registerTask(options, "worker-one", "Existing task");
    core.registerTask(options, "worker-two", "Queued task");
    core.submitEvent(options, "existing-enqueue", "T0002", "ENQUEUE_REQUESTED", { userRequestId: "original-request" });
    core.processPendingEvents(options);
    return { projectRoot, codexHome, options, source: String(initialized.databasePath), destination: path.join(projectRoot, ".control-room", "state.sqlite") };
}

/** Run a default-path command and require successful JSON output. @param fixture Disposable project paths. @param args CLI command and arguments. */
function runDefault(fixture: ReturnType<typeof legacyFixture>, args: string[]): Record<string, any> {
    const result = helpers.runCli([...args, "--project-root", fixture.projectRoot], { CODEX_HOME: fixture.codexHome });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

test("new default stores live inside the ignored project directory without changing root permissions", () => {
    const fixture = helpers.createFixture();
    const projectRoot = fs.realpathSync(fixture.repositoryRoot);
    const codexHome = path.join(path.dirname(projectRoot), "unused-codex-home");
    const rootMode = fs.statSync(projectRoot).mode;
    const result = helpers.runCli(["init", "--project-root", projectRoot, "--control-room-thread", "new-console", "--base-branch", "main"], { CODEX_HOME: codexHome });
    assert.equal(result.status, 0, result.stderr);
    const initialized = JSON.parse(result.stdout);
    assert.equal(initialized.databasePath, path.join(projectRoot, ".control-room", "state.sqlite"));
    assert.equal(fs.statSync(projectRoot).mode, rootMode);
    assert.equal(fs.statSync(initialized.databasePath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(codexHome), false);
    assert.equal(helpers.runGit(projectRoot, ["check-ignore", ".control-room/state.sqlite"]), ".control-room/state.sqlite");
});

test("read commands preserve legacy state and the first write moves it without replacing its console or task IDs", () => {
    const fixture = legacyFixture();
    const original = fs.readFileSync(fixture.source);
    const before = runDefault(fixture, ["status", "--thread-id", "worker-one"]);
    assert.equal(before.role, "WORKER");
    assert.equal(runDefault(fixture, ["queue"]).queue[0].taskId, "T0002");
    runDefault(fixture, ["doctor"]);
    assert.equal(fs.existsSync(path.dirname(fixture.destination)), false);
    assert.deepEqual(fs.readFileSync(fixture.source), original);
    const migrated = runDefault(fixture, ["init", "--control-room-thread", "original-console", "--base-branch", "main"]);
    assert.equal(migrated.created, false);
    assert.equal(migrated.databasePath, fixture.destination);
    assert.equal(migrated.controlRoomThreadId, "original-console");
    assert.equal(fs.existsSync(fixture.source), false);
    assert.deepEqual(runDefault(fixture, ["status", "--thread-id", "worker-one"]), before);
    assert.equal(runDefault(fixture, ["register", "--thread-id", "worker-three", "--name", "New task"]).taskId, "T0003");
    assert.equal(runDefault(fixture, ["queue"]).queue[0].taskId, "T0002");
    assert.equal(fs.existsSync(fixture.source), false);
});

test("schema upgrades follow relocation and preserve existing registration", () => {
    const fixture = legacyFixture();
    const database = new DatabaseSync(fixture.source);
    database.exec("DROP TABLE autopilot_requests; PRAGMA user_version = 18");
    database.close();
    assert.equal(runDefault(fixture, ["status"]).reason, "MIGRATION_REQUIRED");
    runDefault(fixture, ["install-routing"]);
    assert.equal(runDefault(fixture, ["status", "--thread-id", "worker-one"]).role, "WORKER");
    const migrated = new DatabaseSync(fixture.destination);
    assert.equal(migrated.prepare("PRAGMA user_version").get()?.user_version, 19);
    migrated.close();
    assert.equal(fs.existsSync(fixture.source), false);
});

test("active WAL writers keep their original database until a later migration retry", () => {
    const fixture = legacyFixture();
    const database = new DatabaseSync(fixture.source);
    database.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE");
    database.prepare("UPDATE tasks SET semantic_name = ? WHERE task_id = 'T0001'").run("Latest WAL change");
    const blocked = helpers.runCli(["install-routing", "--project-root", fixture.projectRoot], { CODEX_HOME: fixture.codexHome });
    assert.notEqual(blocked.status, 0);
    assert.equal(fs.existsSync(fixture.source), true);
    assert.equal(fs.existsSync(fixture.destination), false);
    database.exec("COMMIT");
    database.close();
    runDefault(fixture, ["install-routing"]);
    assert.equal(runDefault(fixture, ["status", "--thread-id", "worker-one"]).task.semanticName, "Latest WAL change");
});

test("concurrent migrations and registrations share one database and allocate unique IDs", async () => {
    const fixture = legacyFixture();
    const registrations = await Promise.all(Array.from({ length: 6 }, (_, index) => execFile(process.execPath, [cliPath, "register", "--project-root", fixture.projectRoot, "--thread-id", `concurrent-${index}`, "--name", `Concurrent ${index}`], { env: { ...process.env, CODEX_HOME: fixture.codexHome } })));
    assert.deepEqual(registrations.map((result) => JSON.parse(result.stdout).taskId).sort(), ["T0003", "T0004", "T0005", "T0006", "T0007", "T0008"]);
    assert.equal(fs.existsSync(fixture.source), false);
    assert.equal(runDefault(fixture, ["queue"]).queue[0].taskId, "T0002");
});

for (const checkpoint of ["before-publish", "after-publish", "before-source-removal", "cross-device"]) {
    test(`migration resumes safely at ${checkpoint}`, () => {
        const fixture = legacyFixture();
        const before = runDefault(fixture, ["status", "--thread-id", "worker-one"]);
        const interrupted = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-storage.ts"), fixture.projectRoot, fixture.codexHome, fixture.source, checkpoint], { encoding: "utf8" });
        if (checkpoint === "cross-device") {
            assert.equal(interrupted.status, 0, interrupted.stderr);
        } else {
            assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr);
            assert.deepEqual(runDefault(fixture, ["status", "--thread-id", "worker-one"]), before);
        }
        runDefault(fixture, ["install-routing"]);
        assert.deepEqual(runDefault(fixture, ["status", "--thread-id", "worker-one"]), before);
        assert.equal(fs.existsSync(fixture.source), false);
        assert.equal(fs.existsSync(path.join(path.dirname(fixture.destination), "state-migration.json")), false);
    });
}

test("conflicting databases are preserved rather than silently choosing one", () => {
    const fixture = legacyFixture();
    fs.mkdirSync(path.dirname(fixture.destination));
    fs.copyFileSync(fixture.source, fixture.destination);
    const sourceBytes = fs.readFileSync(fixture.source);
    const destinationBytes = fs.readFileSync(fixture.destination);
    for (const command of ["status", "install-routing"]) {
        const result = helpers.runCli([command, "--project-root", fixture.projectRoot], { CODEX_HOME: fixture.codexHome });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Both local and legacy/);
    }
    assert.deepEqual(fs.readFileSync(fixture.source), sourceBytes);
    assert.deepEqual(fs.readFileSync(fixture.destination), destinationBytes);
});

test("state-root overrides keep their existing paths and never migrate to the project", () => {
    const fixture = legacyFixture();
    const result = core.initializeProject(fixture.options, "original-console", "main");
    assert.equal(result.databasePath, fixture.source);
    assert.equal(fs.existsSync(path.dirname(fixture.destination)), false);
});

test("committed WAL frames left by process termination survive relocation", () => {
    const fixture = legacyFixture();
    const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-storage.ts"), fixture.projectRoot, fixture.codexHome, fixture.source, "wal-crash"], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.ok(fs.statSync(`${fixture.source}-wal`).size > 0);
    runDefault(fixture, ["install-routing"]);
    assert.equal(runDefault(fixture, ["status", "--thread-id", "worker-one"]).task.semanticName, "Committed WAL update");
    assert.equal(fs.existsSync(fixture.source), false);
    assert.equal(fs.existsSync(`${fixture.source}-wal`), false);
});

test("migration restores a missing ignore rule and preserves an active isolated workspace and autopilot", () => {
    const fixture = legacyFixture();
    helpers.runGit(fixture.projectRoot, ["add", "-A"]);
    helpers.runGit(fixture.projectRoot, ["commit", "-m", "Install fixture routing"]);
    core.submitEvent(fixture.options, "isolated-start", "T0001", "RUN_ISOLATED_NOW_REQUESTED", {});
    core.processPendingEvents(fixture.options);
    const activation = core.activateIsolatedTask(fixture.options, "T0001");
    assert.ok(activation.executionBrief);
    core.setAutopilot(fixture.options, true, "mode-on", "enable-autopilot", "worker-one");
    const before = runDefault(fixture, ["status", "--thread-id", "worker-one"]);
    fs.unlinkSync(path.join(fixture.projectRoot, ".gitignore"));
    runDefault(fixture, ["install-routing"]);
    assert.deepEqual(runDefault(fixture, ["status", "--thread-id", "worker-one"]), before);
    assert.equal(fs.existsSync(activation.executionBrief.workspacePath), true);
    assert.equal(helpers.runGit(fixture.projectRoot, ["check-ignore", ".control-room/state.sqlite"]), ".control-room/state.sqlite");
    assert.equal(core.getPendingActivations({ projectRoot: fixture.projectRoot }).length, 1);
    core.submitEvent({ projectRoot: fixture.projectRoot }, "cancel-isolated", "T0001", "CANCEL_REQUESTED", { userRequestId: "cancel-fixture" });
    core.settleProject({ projectRoot: fixture.projectRoot });
    assert.equal(fs.existsSync(activation.executionBrief.workspacePath), false);
    assert.equal(fs.existsSync(fixture.destination), true);
    assert.equal(runDefault(fixture, ["status", "--thread-id", "worker-one"]).task.state, "CANCELED");
});

test("readers and writers resolve the same state while relocation is running", async () => {
    const fixture = legacyFixture();
    const commands = Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? ["install-routing"] : ["status", "--thread-id", "worker-one"]);
    const results = await Promise.all(commands.map((args) => execFile(process.execPath, [cliPath, ...args, "--project-root", fixture.projectRoot], { env: { ...process.env, CODEX_HOME: fixture.codexHome } })));
    for (let index = 1; index < results.length; index += 2) {
        assert.equal(JSON.parse(results[index].stdout).role, "WORKER");
    }
    assert.equal(fs.existsSync(fixture.source), false);
});

test("recovery refuses a source that changed after interrupted publication", () => {
    const fixture = legacyFixture();
    const killed = childProcess.spawnSync(process.execPath, [path.join(__dirname, "fixtures", "interrupted-storage.ts"), fixture.projectRoot, fixture.codexHome, fixture.source, "before-source-removal"], { encoding: "utf8" });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const database = new DatabaseSync(fixture.source);
    database.prepare("UPDATE tasks SET semantic_name = ? WHERE task_id = 'T0001'").run("Change during interruption");
    database.close();
    const result = helpers.runCli(["install-routing", "--project-root", fixture.projectRoot], { CODEX_HOME: fixture.codexHome });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed during migration/);
    assert.equal(fs.existsSync(fixture.source), true);
    assert.equal(fs.existsSync(fixture.destination), true);
});

for (const target of ["directory", "database", "wal", "receipt", "lock"]) {
    test(`migration rejects an unsafe ${target} symbolic link`, () => {
        const fixture = legacyFixture();
        const redirected = path.join(path.dirname(fixture.projectRoot), "unrelated");
        fs.mkdirSync(redirected);
        if (target === "directory") {
            fs.symlinkSync(redirected, path.dirname(fixture.destination));
        } else {
            fs.mkdirSync(path.dirname(fixture.destination));
            const suffix = target === "database" ? "state.sqlite" : target === "wal" ? "state.sqlite-wal" : target === "receipt" ? "state-migration.json" : ".state-migration-lock";
            fs.symlinkSync(path.join(redirected, "missing"), path.join(path.dirname(fixture.destination), suffix));
        }
        const result = helpers.runCli(["install-routing", "--project-root", fixture.projectRoot], { CODEX_HOME: fixture.codexHome });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /symbolic link/);
        assert.equal(fs.existsSync(fixture.source), true);
        assert.deepEqual(fs.readdirSync(redirected), []);
    });
}

for (const issue of ["future-schema", "wrong-project", "corrupt"]) {
    test(`migration preserves an incompatible ${issue} source`, () => {
        const fixture = legacyFixture();
        if (issue === "corrupt") {
            fs.writeFileSync(fixture.source, "Not a SQLite database");
        } else {
            const database = new DatabaseSync(fixture.source);
            database.exec(issue === "future-schema" ? "PRAGMA user_version = 999" : "UPDATE projects SET project_root = '/another/project'");
            database.close();
        }
        const original = fs.readFileSync(fixture.source);
        const result = helpers.runCli(["install-routing", "--project-root", fixture.projectRoot], { CODEX_HOME: fixture.codexHome });
        assert.notEqual(result.status, 0);
        assert.deepEqual(fs.readFileSync(fixture.source), original);
        assert.equal(fs.existsSync(fixture.destination), false);
    });
}
