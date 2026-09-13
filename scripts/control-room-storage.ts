import type { IStoreLocation, IUnavailableState, IControlRoomOptions, IStore } from "./control-room-types.ts";
const nodeCrypto: typeof import("node:crypto") = require("node:crypto");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;
const { canonicalizeProjectRoot }: import("./control-room-git.ts").IGitApi = require("./control-room-git.ts");
const CURRENT_SCHEMA_VERSION = 19;

/**
 * Create a secure directory if needed and restrict its mode.
 * @param directoryPath Directory to create or secure.
 */
function ensurePrivateDirectory(directoryPath: string): void {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    const directoryStatus = fs.lstatSync(directoryPath);
    assertCondition(!directoryStatus.isSymbolicLink(), `State directory cannot be a symbolic link: ${directoryPath}`);
    assertCondition(directoryStatus.isDirectory(), `State path is not a directory: ${directoryPath}`);
    fs.chmodSync(directoryPath, 0o700);
}

/**
 * Inspect a path without following its final symbolic link.
 * @param targetPath Path whose final component must be inspected.
 */
function pathIsSymbolicLink(targetPath: string): boolean {
    try {
        return fs.lstatSync(targetPath).isSymbolicLink();
    } catch (error) {
        const errorCode = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (errorCode === "ENOENT") {
            return false;
        }
        throw error;
    }
}

/**
 * Resolve the active Codex home directory.
 */
function resolveCodexHome(): string {
    return process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

/**
 * Determine whether a SQLite table contains a named column.
 * @param database Open SQLite database.
 * @param tableName Fixed internal table name.
 * @param columnName Fixed internal column name.
 */
function databaseHasColumn(database: import("node:sqlite").DatabaseSync, tableName: string, columnName: string): boolean {
    const columns = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    for (const column of columns) {
        if (column.name === columnName) {
            return true;
        }
    }
    return false;
}

/**
 * Create or migrate the Control Room schema transactionally.
 * @param database Open SQLite database.
 */
function initializeSchema(database: import("node:sqlite").DatabaseSync): void {
    const versionRow = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const schemaVersion = Number(versionRow.user_version);
    assertCondition(schemaVersion >= 0 && schemaVersion <= CURRENT_SCHEMA_VERSION, `Unsupported Control Room schema version: ${schemaVersion}`);
    if (schemaVersion === CURRENT_SCHEMA_VERSION) {
        return;
    }
    beginTransaction(database);
    try {
        database.exec(`
            CREATE TABLE IF NOT EXISTS projects (
                project_key TEXT PRIMARY KEY,
                project_root TEXT NOT NULL UNIQUE,
                coordinator_thread_id TEXT NOT NULL,
                base_branch TEXT NOT NULL,
                git_mode TEXT NOT NULL CHECK (git_mode = 'local-approval-commit'),
                next_task_number INTEGER NOT NULL CHECK (next_task_number BETWEEN 1 AND 10000),
                integration_task_id TEXT,
                integration_started_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                task_number INTEGER NOT NULL UNIQUE CHECK (task_number BETWEEN 1 AND 9999),
                semantic_name TEXT NOT NULL,
                thread_id TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK (state IN ('PLANNING', 'QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'PAUSED', 'DONE', 'BLOCKED', 'CANCELED')),
                blocked_from_state TEXT CHECK (blocked_from_state IN ('QUEUED', 'RUNNING', 'REVIEW')),
                awaiting_user INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_user IN (0, 1)),
                queue_position INTEGER,
                base_commit TEXT,
                branch_name TEXT,
                workspace_mode TEXT NOT NULL DEFAULT 'shared' CHECK (workspace_mode IN ('shared', 'isolated')),
                worktree_path TEXT,
                reviewed_commit TEXT,
                approved_commit TEXT,
                approval_event_key TEXT,
                approval_target TEXT NOT NULL DEFAULT 'DONE' CHECK (approval_target IN ('DONE', 'PAUSED')),
                integrated_commit TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_exclusions (
                thread_id TEXT PRIMARY KEY,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dependencies (
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                depends_on_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
                dependency_kind TEXT NOT NULL CHECK (dependency_kind = 'BLOCKING'),
                PRIMARY KEY (task_id, depends_on_id, dependency_kind),
                CHECK (task_id <> depends_on_id)
            );
            CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('PLANNING_REQUESTED', 'ENQUEUE_REQUESTED', 'RUN_NOW_REQUESTED', 'RUN_ISOLATED_NOW_REQUESTED', 'MOVE_REQUESTED', 'DEPENDENCY_ADD_REQUESTED', 'DEPENDENCY_REMOVE_REQUESTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED', 'DECISION_RECORDED', 'REVIEW_REQUESTED', 'REWORK_REQUESTED', 'REVIEW_BLIND_RECORDED', 'REVIEW_AUDIT_RECORDED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                processed_at TEXT,
                result_json TEXT
            );
        `);
        if (!databaseHasColumn(database, "projects", "integration_task_id")) {
            database.exec("ALTER TABLE projects ADD COLUMN integration_task_id TEXT");
        }
        if (!databaseHasColumn(database, "projects", "integration_started_at")) {
            database.exec("ALTER TABLE projects ADD COLUMN integration_started_at TEXT");
        }
        if (!databaseHasColumn(database, "tasks", "reviewed_commit")) {
            database.exec("ALTER TABLE tasks ADD COLUMN reviewed_commit TEXT");
        }
        if (!databaseHasColumn(database, "tasks", "awaiting_user")) {
            database.exec("ALTER TABLE tasks ADD COLUMN awaiting_user INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_user IN (0, 1))");
        }
        if (!databaseHasColumn(database, "tasks", "workspace_mode")) {
            database.exec("ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'shared' CHECK (workspace_mode IN ('shared', 'isolated'))");
        }
        if (!databaseHasColumn(database, "tasks", "worktree_path")) {
            database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
        }
        if (!databaseHasColumn(database, "tasks", "approved_commit")) {
            database.exec("ALTER TABLE tasks ADD COLUMN approved_commit TEXT");
        }
        const projectTable = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as { sql: string } | undefined;
        if (projectTable && projectTable.sql.includes("local-ff-only")) {
            database.exec(`
                ALTER TABLE projects RENAME TO projects_legacy;
                CREATE TABLE projects (
                    project_key TEXT PRIMARY KEY,
                    project_root TEXT NOT NULL UNIQUE,
                    coordinator_thread_id TEXT NOT NULL,
                    base_branch TEXT NOT NULL,
                    git_mode TEXT NOT NULL CHECK (git_mode = 'local-approval-commit'),
                    next_task_number INTEGER NOT NULL CHECK (next_task_number BETWEEN 1 AND 10000),
                    integration_task_id TEXT,
                    integration_started_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO projects (
                    project_key, project_root, coordinator_thread_id, base_branch, git_mode,
                    next_task_number, integration_task_id, integration_started_at, created_at, updated_at
                )
                SELECT
                    project_key, project_root, coordinator_thread_id, base_branch, 'local-approval-commit',
                    next_task_number, integration_task_id, integration_started_at, created_at, updated_at
                FROM projects_legacy;
                DROP TABLE projects_legacy;
            `);
        }
        const dependencyTable = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dependencies'").get() as { sql: string } | undefined;
        if (dependencyTable && dependencyTable.sql.includes("'ORDER'")) {
            database.exec(`
                ALTER TABLE dependencies RENAME TO dependencies_legacy;
                CREATE TABLE dependencies (
                    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                    depends_on_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
                    dependency_kind TEXT NOT NULL CHECK (dependency_kind = 'BLOCKING'),
                    PRIMARY KEY (task_id, depends_on_id, dependency_kind),
                    CHECK (task_id <> depends_on_id)
                );
                INSERT INTO dependencies (task_id, depends_on_id, dependency_kind)
                SELECT task_id, depends_on_id, 'BLOCKING' FROM dependencies_legacy;
                DROP TABLE dependencies_legacy;
            `);
        }
        const eventTable = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get() as { sql: string } | undefined;
        if (eventTable && (!eventTable.sql.includes("USER_INPUT_REQUESTED") || !eventTable.sql.includes("USER_INPUT_RECEIVED") || !eventTable.sql.includes("DECISION_RECORDED") || !eventTable.sql.includes("RUN_ISOLATED_NOW_REQUESTED") || eventTable.sql.includes("MENTAL_MODEL_RECORDED"))) {
            database.exec(`
                ALTER TABLE events RENAME TO events_legacy;
                CREATE TABLE events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL CHECK (kind IN ('PLANNING_REQUESTED', 'ENQUEUE_REQUESTED', 'RUN_NOW_REQUESTED', 'RUN_ISOLATED_NOW_REQUESTED', 'MOVE_REQUESTED', 'DEPENDENCY_ADD_REQUESTED', 'DEPENDENCY_REMOVE_REQUESTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED', 'DECISION_RECORDED', 'REVIEW_REQUESTED', 'REWORK_REQUESTED', 'REVIEW_BLIND_RECORDED', 'REVIEW_AUDIT_RECORDED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    processed_at TEXT,
                    result_json TEXT
                );
                INSERT INTO events (sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json)
                SELECT sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json
                FROM events_legacy
                WHERE kind <> 'MENTAL_MODEL_RECORDED';
                DROP TABLE events_legacy;
            `);
        }
        const taskTable = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as { sql: string } | undefined;
        if (taskTable && (!taskTable.sql.includes("'PAUSED'") || !databaseHasColumn(database, "tasks", "approval_event_key") || !databaseHasColumn(database, "tasks", "approval_target"))) {
            const hasLegacyReviewedTree = databaseHasColumn(database, "tasks", "reviewed_tree");
            const reviewedTreeDefinition = hasLegacyReviewedTree ? "reviewed_tree TEXT," : "";
            const reviewedTreeInsertColumn = hasLegacyReviewedTree ? "reviewed_tree," : "";
            const reviewedTreeSelectColumn = hasLegacyReviewedTree ? "reviewed_tree," : "";
            database.exec(`
                PRAGMA defer_foreign_keys = ON;
                ALTER TABLE dependencies RENAME TO dependencies_before_paused;
                ALTER TABLE events RENAME TO events_before_paused;
                ALTER TABLE tasks RENAME TO tasks_before_paused;
                CREATE TABLE tasks (
                    task_id TEXT PRIMARY KEY,
                    task_number INTEGER NOT NULL UNIQUE CHECK (task_number BETWEEN 1 AND 9999),
                    semantic_name TEXT NOT NULL,
                    thread_id TEXT NOT NULL UNIQUE,
                    state TEXT NOT NULL CHECK (state IN ('PLANNING', 'QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'PAUSED', 'DONE', 'BLOCKED', 'CANCELED')),
                    blocked_from_state TEXT CHECK (blocked_from_state IN ('QUEUED', 'RUNNING', 'REVIEW')),
                    awaiting_user INTEGER NOT NULL DEFAULT 0 CHECK (awaiting_user IN (0, 1)),
                    queue_position INTEGER,
                    base_commit TEXT,
                    branch_name TEXT,
                    workspace_mode TEXT NOT NULL DEFAULT 'shared' CHECK (workspace_mode IN ('shared', 'isolated')),
                    worktree_path TEXT,
                    reviewed_commit TEXT,
                    approved_commit TEXT,
                    ${reviewedTreeDefinition}
                    approval_event_key TEXT,
                    approval_target TEXT NOT NULL DEFAULT 'DONE' CHECK (approval_target IN ('DONE', 'PAUSED')),
                    integrated_commit TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO tasks (
                    task_id, task_number, semantic_name, thread_id, state, blocked_from_state,
                    awaiting_user, queue_position, base_commit, branch_name, workspace_mode,
                    worktree_path, reviewed_commit, approved_commit, ${reviewedTreeInsertColumn} approval_event_key,
                    approval_target, integrated_commit, created_at, updated_at
                )
                SELECT
                    task_id, task_number, semantic_name, thread_id, state, blocked_from_state,
                    awaiting_user, queue_position, base_commit, branch_name, workspace_mode,
                    worktree_path, reviewed_commit, approved_commit, ${reviewedTreeSelectColumn} NULL,
                    'DONE', integrated_commit, created_at, updated_at
                FROM tasks_before_paused;
                CREATE TABLE dependencies (
                    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                    depends_on_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
                    dependency_kind TEXT NOT NULL CHECK (dependency_kind = 'BLOCKING'),
                    PRIMARY KEY (task_id, depends_on_id, dependency_kind),
                    CHECK (task_id <> depends_on_id)
                );
                INSERT INTO dependencies (task_id, depends_on_id, dependency_kind)
                SELECT task_id, depends_on_id, dependency_kind FROM dependencies_before_paused;
                CREATE TABLE events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL CHECK (kind IN ('PLANNING_REQUESTED', 'ENQUEUE_REQUESTED', 'RUN_NOW_REQUESTED', 'RUN_ISOLATED_NOW_REQUESTED', 'MOVE_REQUESTED', 'DEPENDENCY_ADD_REQUESTED', 'DEPENDENCY_REMOVE_REQUESTED', 'USER_INPUT_REQUESTED', 'USER_INPUT_RECEIVED', 'DECISION_RECORDED', 'REVIEW_REQUESTED', 'REWORK_REQUESTED', 'REVIEW_BLIND_RECORDED', 'REVIEW_AUDIT_RECORDED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    processed_at TEXT,
                    result_json TEXT
                );
                INSERT INTO events (sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json)
                SELECT sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json
                FROM events_before_paused
                WHERE kind <> 'MENTAL_MODEL_RECORDED';
                DROP TABLE dependencies_before_paused;
                DROP TABLE events_before_paused;
                DROP TABLE tasks_before_paused;
            `);
        }
        if (!databaseHasColumn(database, "tasks", "handoff_sender_task_id")) {
            database.exec("ALTER TABLE tasks ADD COLUMN handoff_sender_task_id TEXT REFERENCES tasks(task_id) CHECK (handoff_sender_task_id IS NULL OR handoff_sender_task_id <> task_id)");
        }
        if (!databaseHasColumn(database, "tasks", "cleanup_pending")) {
            database.exec("ALTER TABLE tasks ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0, 1))");
        }
        database.exec(`
            CREATE TABLE IF NOT EXISTS activation_deliveries (
                activation_key TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(task_id),
                brief_json TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ('PENDING', 'CLAIMED', 'DELIVERED', 'CANCELED')),
                claim_token TEXT,
                retry_request_id TEXT,
                receipt TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_activation_pending ON activation_deliveries(task_id) WHERE state IN ('PENDING', 'CLAIMED');
            CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_position);
            CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processed_at, sequence);
        `);
        if (schemaVersion < 18) {
            database.exec(`
                UPDATE events
                SET result_json = json_remove(result_json, '$.reviewPacket.baseline', '$.reviewPacket.final', '$.reviewPacket.changedFields')
                WHERE result_json IS NOT NULL AND json_valid(result_json);
                UPDATE activation_deliveries
                SET brief_json = json_remove(brief_json, '$.mentalModelRequired', '$.reviewPacket.baseline', '$.reviewPacket.final', '$.reviewPacket.changedFields')
                WHERE json_valid(brief_json);
            `);
        }
        database.exec(`
            CREATE TABLE IF NOT EXISTS autopilot_requests (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                user_request_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
        `);
        commitTransaction(database);
    } catch (error) {
        rollbackTransaction(database);
        throw error;
    }
}

/**
 * Create or open the project-scoped SQLite store.
 * @param options Project and optional state-root settings.
 */
function openStore(options: IControlRoomOptions): IStore {
    const { projectRoot, projectKey, databasePath } = resolveStoreLocation(options);
    ensurePrivateDirectory(path.dirname(path.dirname(databasePath)));
    ensurePrivateDirectory(path.dirname(databasePath));
    const database = new DatabaseSync(databasePath);
    try {
        database.exec("PRAGMA busy_timeout = 5000");
        database.exec("PRAGMA foreign_keys = ON");
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = FULL");
        initializeSchema(database);
        fs.chmodSync(databasePath, 0o600);
        return { database, databasePath, projectKey, projectRoot };
    } catch (error) {
        database.close();
        throw error;
    }
}

/**
 * Resolve the project store without creating files or following state symlinks.
 * @param options Project and optional state-root settings.
 */
function resolveStoreLocation(options: IControlRoomOptions): IStoreLocation {
    const projectRoot = canonicalizeProjectRoot(options.projectRoot);
    const stateRoot = options.stateRoot ? path.resolve(options.stateRoot) : path.join(resolveCodexHome(), "control-room", "projects");
    const projectKey = nodeCrypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 24);
    const projectDirectory = path.join(stateRoot, projectKey);
    const databasePath = path.join(projectDirectory, "state.sqlite");
    for (const directory of [stateRoot, projectDirectory]) {
        assertCondition(!pathIsSymbolicLink(directory), `State directory cannot be a symbolic link: ${directory}`);
        if (fs.existsSync(directory)) {
            assertCondition(fs.lstatSync(directory).isDirectory(), `State path is not a directory: ${directory}`);
        }
    }
    for (const target of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        assertCondition(!pathIsSymbolicLink(target), `State database cannot be a symbolic link: ${target}`);
    }
    return { projectRoot, projectKey, databasePath };
}

/**
 * Read an existing current store without creating it or running migrations.
 * @param options Project and optional state-root settings.
 */
function openReadStore(options: IControlRoomOptions): IStore | IUnavailableState {
    const location = resolveStoreLocation(options);
    if (!fs.existsSync(location.databasePath)) {
        return { initialized: false, reason: "NOT_INITIALIZED", projectRoot: location.projectRoot };
    }
    const database = new DatabaseSync(location.databasePath, { readOnly: true });
    try {
        database.exec("PRAGMA busy_timeout = 5000");
        database.exec("PRAGMA query_only = ON");
        const schemaVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version);
        assertCondition(schemaVersion >= 0 && schemaVersion <= CURRENT_SCHEMA_VERSION, `Unsupported Control Room schema version: ${schemaVersion}`);
        if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
            database.close();
            return { initialized: false, reason: "MIGRATION_REQUIRED", projectRoot: location.projectRoot, schemaVersion, expectedSchemaVersion: CURRENT_SCHEMA_VERSION };
        }
        const project = database.prepare("SELECT project_root FROM projects WHERE project_key = ?").get(location.projectKey);
        if (!project) {
            database.close();
            return { initialized: false, reason: "NOT_INITIALIZED", projectRoot: location.projectRoot };
        }
        assertCondition(project.project_root === location.projectRoot, "Stored project root does not match the canonical project root.");
        return { ...location, database };
    } catch (error) {
        if (database.isOpen) {
            database.close();
        }
        throw error;
    }
}

/**
 * Start an immediate SQLite transaction.
 * @param database Open SQLite database.
 */
function beginTransaction(database: import("node:sqlite").DatabaseSync): void {
    database.exec("BEGIN IMMEDIATE");
}

/**
 * Commit the active SQLite transaction.
 * @param database Open SQLite database.
 */
function commitTransaction(database: import("node:sqlite").DatabaseSync): void {
    database.exec("COMMIT");
}

/**
 * Roll back the active SQLite transaction without hiding the original failure.
 * @param database Open SQLite database.
 */
function rollbackTransaction(database: import("node:sqlite").DatabaseSync): void {
    try {
        database.exec("ROLLBACK");
    } catch {
        // The original operation error is more useful than a secondary rollback error.
    }
}

const api = { openReadStore, resolveStoreLocation, ensurePrivateDirectory, pathIsSymbolicLink, resolveCodexHome, databaseHasColumn, initializeSchema, openStore, beginTransaction, commitTransaction, rollbackTransaction, CURRENT_SCHEMA_VERSION };
module.exports = api;
export interface IStorageApi extends Readonly<typeof api> {}
