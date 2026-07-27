const childProcess = require("node:child_process");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

type TaskState = "PLANNING" | "QUEUED" | "RUNNING" | "REVIEW" | "APPROVED" | "DONE" | "BLOCKED" | "CANCELED";
type EventKind = "ENQUEUE_REQUESTED" | "REVIEW_REQUESTED" | "APPROVAL_REQUESTED" | "CANCEL_REQUESTED" | "BLOCKED_REPORTED";

interface IControlRoomOptions {
    projectRoot: string;
    stateRoot?: string;
}

interface IEventPayload {
    afterTaskId?: string;
    reason?: string;
    summary?: string;
    userRequestId?: string;
}

interface IStore {
    database: any;
    databasePath: string;
    projectKey: string;
    projectRoot: string;
}

interface IProjectRow {
    project_key: string;
    project_root: string;
    coordinator_thread_id: string;
    base_branch: string;
    git_mode: string;
    next_task_number: number;
    integration_task_id: string | null;
    integration_started_at: string | null;
}

interface ITaskRow {
    task_id: string;
    task_number: number;
    semantic_name: string;
    thread_id: string;
    state: TaskState;
    blocked_from_state: TaskState | null;
    queue_position: number | null;
    base_commit: string | null;
    branch_name: string | null;
    reviewed_commit: string | null;
    integrated_commit: string | null;
    created_at: string;
    updated_at: string;
}

interface IEventRow {
    sequence: number;
    event_key: string;
    task_id: string;
    kind: EventKind;
    payload_json: string;
}

interface IGitResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

const TASK_ID_PATTERN = /^T\d{4}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const ACTIVE_STATES: TaskState[] = ["QUEUED", "RUNNING", "REVIEW", "APPROVED", "BLOCKED"];
const COORDINATOR_WAKE_NOTIFICATION = "CONTROL_ROOM_WAKE";
const GIT_MODE = "local-approval-commit";

/**
 * Reject an invalid condition with a stable error message.
 * @param condition Condition that must be truthy.
 * @param message Error message used when the condition fails.
 */
function assertCondition(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

/**
 * Return the current timestamp in a SQLite-friendly format.
 */
function currentTimestamp(): string {
    return new Date().toISOString();
}

/**
 * Resolve and validate the canonical project directory.
 * @param projectRoot Repository root supplied by the caller.
 */
function canonicalizeProjectRoot(projectRoot: string): string {
    assertCondition(typeof projectRoot === "string" && projectRoot.trim().length > 0, "A project root is required.");
    const resolvedRoot = path.resolve(projectRoot);
    assertCondition(fs.existsSync(resolvedRoot), `Project root does not exist: ${resolvedRoot}`);
    assertCondition(fs.statSync(resolvedRoot).isDirectory(), `Project root is not a directory: ${resolvedRoot}`);
    const requestedRoot = fs.realpathSync(resolvedRoot);
    const gitRootResult = runGit(requestedRoot, ["rev-parse", "--show-toplevel"]);
    assertCondition(gitRootResult.status === 0, `Project root is not a Git repository: ${requestedRoot}`);
    assertCondition(fs.realpathSync(gitRootResult.stdout) === requestedRoot, `Project root must be the Git working tree root: ${gitRootResult.stdout}`);
    const commonDirectoryResult = runGit(requestedRoot, ["rev-parse", "--git-common-dir"]);
    assertCondition(commonDirectoryResult.status === 0, `Cannot resolve the common Git directory: ${requestedRoot}`);
    const commonDirectory = fs.realpathSync(path.resolve(requestedRoot, commonDirectoryResult.stdout));
    assertCondition(path.basename(commonDirectory) === ".git", `Unsupported common Git directory: ${commonDirectory}`);
    const canonicalRoot = fs.realpathSync(path.dirname(commonDirectory));
    const canonicalGitRoot = runGit(canonicalRoot, ["rev-parse", "--show-toplevel"]);
    assertCondition(canonicalGitRoot.status === 0 && fs.realpathSync(canonicalGitRoot.stdout) === canonicalRoot, `Cannot resolve the primary Local checkout: ${canonicalRoot}`);
    assertCondition(requestedRoot === canonicalRoot, "ControlRoom requires the primary Local checkout. Use Hand off > Local before continuing.");
    return canonicalRoot;
}

/**
 * Validate an opaque Codex thread identifier before persistence.
 * @param threadId Thread identifier supplied by Codex.
 */
function validateThreadId(threadId: string): string {
    assertCondition(typeof threadId === "string", "A thread ID is required.");
    const normalizedThreadId = threadId.trim();
    assertCondition(normalizedThreadId.length > 0 && normalizedThreadId.length <= 200, "Thread ID must contain 1 to 200 characters.");
    assertCondition(!/[\u0000-\u001f\u007f]/u.test(normalizedThreadId), "Thread ID contains control characters.");
    return normalizedThreadId;
}

/**
 * Validate and normalize a short semantic task name.
 * @param semanticName User-facing semantic task name.
 */
function validateSemanticName(semanticName: string): string {
    assertCondition(typeof semanticName === "string", "A semantic task name is required.");
    const normalizedName = semanticName.trim().replace(/^(?:⚪️|⭕️|🔴|🟡|🟢|✅|❌|👉)\s*/u, "");
    assertCondition(normalizedName.length > 0 && normalizedName.length <= 80, "Semantic task name must contain 1 to 80 characters.");
    assertCondition(!/[\u0000-\u001f\u007f]/u.test(normalizedName), "Semantic task name contains control characters.");
    return normalizedName;
}

/**
 * Validate a Control Room task identifier.
 * @param taskId Task identifier to validate.
 */
function validateTaskId(taskId: string): string {
    assertCondition(typeof taskId === "string" && TASK_ID_PATTERN.test(taskId), `Invalid task ID: ${String(taskId)}`);
    return taskId;
}

/**
 * Validate a full Git commit identifier.
 * @param commitId Git object identifier to validate.
 */
function validateCommitId(commitId: string): string {
    assertCondition(typeof commitId === "string" && COMMIT_PATTERN.test(commitId), "A full 40- or 64-character Git commit ID is required.");
    return commitId.toLowerCase();
}

/**
 * Validate a Git branch name without invoking a shell.
 * @param branchName Git branch name to validate.
 */
function validateBranchName(branchName: string): string {
    assertCondition(typeof branchName === "string", "A Git branch name is required.");
    const normalizedBranch = branchName.trim();
    assertCondition(normalizedBranch.length > 0 && normalizedBranch.length <= 240, "Git branch name must contain 1 to 240 characters.");
    assertCondition(!normalizedBranch.startsWith("-"), "Git branch names cannot start with a hyphen.");
    assertCondition(!normalizedBranch.startsWith("refs/") && normalizedBranch !== "HEAD", "Use a local branch name without a refs/ prefix.");
    assertCondition(!/[\u0000-\u0020\u007f~^:?*[\\]/u.test(normalizedBranch), "Git branch name contains forbidden characters.");
    assertCondition(!normalizedBranch.includes("..") && !normalizedBranch.includes("@{") && !normalizedBranch.includes("//"), "Git branch name contains a forbidden sequence.");
    assertCondition(!normalizedBranch.endsWith(".") && !normalizedBranch.endsWith("/") && !normalizedBranch.endsWith(".lock"), "Git branch name has a forbidden suffix.");
    return normalizedBranch;
}

/**
 * Build the deterministic worker branch name created when a task starts.
 * @param taskId Control Room task identifier.
 */
function workerBranchForTask(taskId: string): string {
    return validateBranchName(`control-room/${validateTaskId(taskId)}`);
}

/**
 * Validate an idempotency key.
 * @param eventKey Caller-stable event identifier.
 */
function validateEventKey(eventKey: string): string {
    assertCondition(typeof eventKey === "string", "An event key is required.");
    const normalizedKey = eventKey.trim();
    assertCondition(normalizedKey.length > 0 && normalizedKey.length <= 200, "Event key must contain 1 to 200 characters.");
    assertCondition(!/[\u0000-\u001f\u007f]/u.test(normalizedKey), "Event key contains control characters.");
    return normalizedKey;
}

/**
 * Validate compact persisted event text.
 * @param value Text supplied in an event payload.
 * @param fieldName Human-readable field name used in failures.
 * @param maximumLength Maximum accepted character count.
 * @param required Whether empty text is invalid.
 */
function validateCompactText(value: string | undefined, fieldName: string, maximumLength: number, required: boolean): string | undefined {
    if (value === undefined) {
        assertCondition(!required, `${fieldName} is required.`);
        return undefined;
    }
    assertCondition(typeof value === "string", `${fieldName} must be text.`);
    const normalizedValue = value.trim();
    assertCondition(!required || normalizedValue.length > 0, `${fieldName} is required.`);
    assertCondition(normalizedValue.length <= maximumLength, `${fieldName} must not exceed ${maximumLength} characters.`);
    assertCondition(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalizedValue), `${fieldName} contains control characters.`);
    return normalizedValue;
}

/**
 * Validate and canonicalize an event payload before persistence.
 * @param kind Requested event kind.
 * @param payload Caller-supplied event payload.
 */
function validateEventPayload(kind: EventKind, payload: IEventPayload): IEventPayload {
    if (kind === "ENQUEUE_REQUESTED") {
        return {
            afterTaskId: payload.afterTaskId ? validateTaskId(payload.afterTaskId) : undefined
        };
    }
    if (kind === "REVIEW_REQUESTED") {
        return {
            summary: validateCompactText(payload.summary, "Review summary", 2000, false)
        };
    }
    if (kind === "APPROVAL_REQUESTED" || kind === "CANCEL_REQUESTED") {
        return {
            userRequestId: validateCompactText(payload.userRequestId, "Direct user request ID", 200, true)
        };
    }
    assertCondition(kind === "BLOCKED_REPORTED", `Unsupported event kind: ${kind}`);
    return {
        reason: validateCompactText(payload.reason, "Blocked reason", 1000, true)
    };
}

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
 * Determine whether a SQLite table contains a named column.
 * @param database Open SQLite database.
 * @param tableName Fixed internal table name.
 * @param columnName Fixed internal column name.
 */
function databaseHasColumn(database: any, tableName: string, columnName: string): boolean {
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
function initializeSchema(database: any): void {
    const versionRow = database.prepare("PRAGMA user_version").get() as { user_version: number };
    const schemaVersion = Number(versionRow.user_version);
    assertCondition(schemaVersion >= 0 && schemaVersion <= 3, `Unsupported Control Room schema version: ${schemaVersion}`);
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
                state TEXT NOT NULL CHECK (state IN ('PLANNING', 'QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'DONE', 'BLOCKED', 'CANCELED')),
                blocked_from_state TEXT CHECK (blocked_from_state IN ('QUEUED', 'RUNNING', 'REVIEW')),
                queue_position INTEGER,
                base_commit TEXT,
                branch_name TEXT,
                reviewed_commit TEXT,
                integrated_commit TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS dependencies (
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                depends_on_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
                dependency_kind TEXT NOT NULL CHECK (dependency_kind = 'ORDER'),
                PRIMARY KEY (task_id, depends_on_id, dependency_kind),
                CHECK (task_id <> depends_on_id)
            );
            CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('ENQUEUE_REQUESTED', 'REVIEW_REQUESTED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
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
        database.exec(`
            CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_position);
            CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processed_at, sequence);
            PRAGMA user_version = 3;
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
    const projectRoot = canonicalizeProjectRoot(options.projectRoot);
    const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
    const stateRoot = options.stateRoot ? path.resolve(options.stateRoot) : path.join(codexHome, "control-room", "projects");
    const projectKey = nodeCrypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 24);
    const projectDirectory = path.join(stateRoot, projectKey);
    ensurePrivateDirectory(stateRoot);
    ensurePrivateDirectory(projectDirectory);
    const databasePath = path.join(projectDirectory, "state.sqlite");
    assertCondition(!pathIsSymbolicLink(databasePath), `State database cannot be a symbolic link: ${databasePath}`);
    const database = new DatabaseSync(databasePath);
    try {
        database.exec("PRAGMA foreign_keys = ON");
        database.exec("PRAGMA journal_mode = WAL");
        database.exec("PRAGMA synchronous = FULL");
        database.exec("PRAGMA busy_timeout = 5000");
        initializeSchema(database);
        fs.chmodSync(databasePath, 0o600);
        return { database, databasePath, projectKey, projectRoot };
    } catch (error) {
        database.close();
        throw error;
    }
}

/**
 * Start an immediate SQLite transaction.
 * @param database Open SQLite database.
 */
function beginTransaction(database: any): void {
    database.exec("BEGIN IMMEDIATE");
}

/**
 * Commit the active SQLite transaction.
 * @param database Open SQLite database.
 */
function commitTransaction(database: any): void {
    database.exec("COMMIT");
}

/**
 * Roll back the active SQLite transaction without hiding the original failure.
 * @param database Open SQLite database.
 */
function rollbackTransaction(database: any): void {
    try {
        database.exec("ROLLBACK");
    } catch {
        // The original operation error is more useful than a secondary rollback error.
    }
}

/**
 * Load the initialized project record.
 * @param store Open project store.
 */
function requireProject(store: IStore): IProjectRow {
    const row = store.database.prepare("SELECT * FROM projects WHERE project_key = ?").get(store.projectKey) as IProjectRow | undefined;
    assertCondition(row, "Control Room is not initialized for this project.");
    assertCondition(row.project_root === store.projectRoot, "Stored project root does not match the canonical project root.");
    return row;
}

/**
 * Load a task or fail with a stable message.
 * @param store Open project store.
 * @param taskId Task identifier to load.
 */
function requireTask(store: IStore, taskId: string): ITaskRow {
    const validTaskId = validateTaskId(taskId);
    const row = store.database.prepare("SELECT * FROM tasks WHERE task_id = ?").get(validTaskId) as ITaskRow | undefined;
    assertCondition(row, `Unknown task: ${validTaskId}`);
    return row;
}

/**
 * Convert a task state into its exact user-facing title.
 * @param task Task record to title.
 */
function titleForTask(task: ITaskRow): string {
    let prefix = "";
    if (task.state === "PLANNING") {
        prefix = "⚪️ ";
    } else if (task.state === "QUEUED") {
        prefix = "⭕️ ";
    } else if (task.state === "RUNNING") {
        prefix = "🔴 ";
    } else if (task.state === "REVIEW") {
        prefix = "🟡 ";
    } else if (task.state === "APPROVED") {
        prefix = "🟢 ";
    } else if (task.state === "DONE") {
        prefix = "🟢 ";
    } else if (task.state === "BLOCKED" || task.state === "CANCELED") {
        prefix = "❌ ";
    }
    return `${prefix}${task.task_id} - ${task.semantic_name}`;
}

/**
 * Return the coordinator title for the current active queue state.
 */
function titleForCoordinator(): string {
    return "⚫️ Control Room";
}

/**
 * Convert a database task row into stable public JSON.
 * @param task Task database row.
 */
function serializeTask(task: ITaskRow): Record<string, unknown> {
    return {
        taskId: task.task_id,
        number: task.task_number,
        semanticName: task.semantic_name,
        threadId: task.thread_id,
        state: task.state,
        title: titleForTask(task),
        queuePosition: task.queue_position,
        baseCommit: task.base_commit,
        branchName: task.branch_name,
        committedCommit: task.integrated_commit
    };
}

/**
 * Initialize project coordination idempotently.
 * @param options Project and optional state-root settings.
 * @param coordinatorThreadId Coordinator Codex thread identifier.
 * @param baseBranch Local Git base branch.
 */
function initializeProject(options: IControlRoomOptions, coordinatorThreadId: string, baseBranch: string): Record<string, unknown> {
    const validCoordinatorThreadId = validateThreadId(coordinatorThreadId);
    const validBaseBranch = validateBranchName(baseBranch);
    const store = openStore(options);
    try {
        resolveLocalBranchHead(store.projectRoot, validBaseBranch);
        beginTransaction(store.database);
        const existingProject = store.database.prepare("SELECT * FROM projects WHERE project_key = ?").get(store.projectKey) as IProjectRow | undefined;
        if (existingProject) {
            assertCondition(existingProject.project_root === store.projectRoot, "Project hash collision detected.");
            assertCondition(existingProject.coordinator_thread_id === validCoordinatorThreadId, "A different coordinator is already registered for this project.");
            assertCondition(existingProject.base_branch === validBaseBranch, "The configured base branch does not match.");
            const coordinatorTitle = titleForCoordinator();
            commitTransaction(store.database);
            return {
                created: false,
                title: coordinatorTitle,
                coordinatorTitle,
                projectRoot: store.projectRoot,
                coordinatorThreadId: existingProject.coordinator_thread_id,
                baseBranch: existingProject.base_branch,
                gitMode: existingProject.git_mode,
                databasePath: store.databasePath
            };
        }
        const timestamp = currentTimestamp();
        store.database.prepare(`
            INSERT INTO projects (project_key, project_root, coordinator_thread_id, base_branch, git_mode, next_task_number, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'local-approval-commit', 1, ?, ?)
        `).run(store.projectKey, store.projectRoot, validCoordinatorThreadId, validBaseBranch, timestamp, timestamp);
        const coordinatorTitle = titleForCoordinator();
        commitTransaction(store.database);
        return {
            created: true,
            title: coordinatorTitle,
            coordinatorTitle,
            projectRoot: store.projectRoot,
            coordinatorThreadId: validCoordinatorThreadId,
            baseBranch: validBaseBranch,
            gitMode: GIT_MODE,
            databasePath: store.databasePath
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Allocate or retrieve a stable top-level task ID.
 * @param options Project and optional state-root settings.
 * @param threadId Worker Codex thread identifier.
 * @param semanticName Short user-facing task name.
 */
function registerTask(options: IControlRoomOptions, threadId: string, semanticName: string): Record<string, unknown> {
    const validThreadId = validateThreadId(threadId);
    const validSemanticName = validateSemanticName(semanticName);
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        assertCondition(project.coordinator_thread_id !== validThreadId, "The coordinator thread cannot be registered as a worker task.");
        const existingTask = store.database.prepare("SELECT * FROM tasks WHERE thread_id = ?").get(validThreadId) as ITaskRow | undefined;
        if (existingTask) {
            if (existingTask.semantic_name !== validSemanticName) {
                assertCondition(existingTask.state === "PLANNING", "A semantic task name can change only during PLANNING.");
                store.database.prepare("UPDATE tasks SET semantic_name = ?, updated_at = ? WHERE task_id = ?").run(validSemanticName, currentTimestamp(), existingTask.task_id);
            }
            const refreshedTask = requireTask(store, existingTask.task_id);
            commitTransaction(store.database);
            return { created: false, coordinatorThreadId: project.coordinator_thread_id, ...serializeTask(refreshedTask) };
        }
        assertCondition(project.next_task_number <= 9999, "The project task ID space T0001-T9999 is exhausted.");
        const taskNumber = project.next_task_number;
        const taskId = `T${String(taskNumber).padStart(4, "0")}`;
        const timestamp = currentTimestamp();
        store.database.prepare(`
            INSERT INTO tasks (task_id, task_number, semantic_name, thread_id, state, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'PLANNING', ?, ?)
        `).run(taskId, taskNumber, validSemanticName, validThreadId, timestamp, timestamp);
        store.database.prepare("UPDATE projects SET next_task_number = ?, updated_at = ? WHERE project_key = ?").run(taskNumber + 1, timestamp, store.projectKey);
        const createdTask = requireTask(store, taskId);
        commitTransaction(store.database);
        return { created: true, coordinatorThreadId: project.coordinator_thread_id, ...serializeTask(createdTask) };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Submit an idempotent worker event without mutating queue or task state.
 * @param options Project and optional state-root settings.
 * @param eventKey Caller-stable event key.
 * @param taskId Target Control Room task.
 * @param kind Event kind requested by the worker.
 * @param payload Compact event payload.
 */
function submitEvent(options: IControlRoomOptions, eventKey: string, taskId: string, kind: EventKind, payload: IEventPayload): Record<string, unknown> {
    const validEventKey = validateEventKey(eventKey);
    const validTaskId = validateTaskId(taskId);
    const validPayload = validateEventPayload(kind, payload);
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const task = requireTask(store, validTaskId);
        if (kind === "ENQUEUE_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot request enqueue for ${task.task_id} from ${task.state}.`);
            if (validPayload.afterTaskId) {
                assertCondition(validPayload.afterTaskId !== task.task_id, "A task cannot be queued after itself.");
                requireTask(store, validPayload.afterTaskId);
            }
        } else if (kind === "REVIEW_REQUESTED") {
            assertCondition(task.state === "RUNNING" || task.state === "REVIEW", `Cannot request review for ${task.task_id} from ${task.state}.`);
        } else if (kind === "APPROVAL_REQUESTED") {
            assertCondition(task.state === "REVIEW" || task.state === "APPROVED" || task.state === "DONE", `Cannot request approval for ${task.task_id} from ${task.state}.`);
        } else if (kind === "CANCEL_REQUESTED") {
            assertCondition(["PLANNING", "QUEUED", "RUNNING", "REVIEW", "BLOCKED", "CANCELED"].includes(task.state), `Cannot request cancellation for ${task.task_id} from ${task.state}.`);
        } else {
            assertCondition(["QUEUED", "RUNNING", "REVIEW", "BLOCKED"].includes(task.state), `Cannot report ${task.task_id} blocked from ${task.state}.`);
        }
        const payloadJson = JSON.stringify(validPayload);
        const existingEvent = store.database.prepare("SELECT event_key, task_id, kind, payload_json, processed_at FROM events WHERE event_key = ?").get(validEventKey) as Record<string, unknown> | undefined;
        if (existingEvent) {
            assertCondition(existingEvent.task_id === validTaskId && existingEvent.kind === kind && existingEvent.payload_json === payloadJson, "Event key already exists with different content.");
            commitTransaction(store.database);
            return {
                created: false,
                processed: Boolean(existingEvent.processed_at),
                eventKey: validEventKey,
                coordinatorThreadId: project.coordinator_thread_id,
                notification: COORDINATOR_WAKE_NOTIFICATION
            };
        }
        store.database.prepare(`
            INSERT INTO events (event_key, task_id, kind, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(validEventKey, validTaskId, kind, payloadJson, currentTimestamp());
        commitTransaction(store.database);
        return {
            created: true,
            processed: false,
            eventKey: validEventKey,
            coordinatorThreadId: project.coordinator_thread_id,
            notification: COORDINATOR_WAKE_NOTIFICATION
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Normalize active queue positions after a queue mutation.
 * @param store Open project store.
 * @param orderedTaskIds Active task IDs in desired order.
 */
function writeQueueOrder(store: IStore, orderedTaskIds: string[]): void {
    const updatePosition = store.database.prepare("UPDATE tasks SET queue_position = ?, updated_at = ? WHERE task_id = ?");
    const timestamp = currentTimestamp();
    for (let index = 0; index < orderedTaskIds.length; index += 1) {
        updatePosition.run(index + 1, timestamp, orderedTaskIds[index]);
    }
}

/**
 * Reject an ordering dependency that would create a queue cycle.
 * @param store Open project store.
 * @param taskId Task receiving the new dependency.
 * @param dependsOnId Proposed prerequisite task.
 */
function assertDependencyIsAcyclic(store: IStore, taskId: string, dependsOnId: string): void {
    const cycle = store.database.prepare(`
        WITH RECURSIVE prerequisite_chain(task_id) AS (
            SELECT ?
            UNION
            SELECT dependency.depends_on_id
            FROM dependencies AS dependency
            JOIN prerequisite_chain AS current ON dependency.task_id = current.task_id
        )
        SELECT task_id FROM prerequisite_chain WHERE task_id = ? LIMIT 1
    `).get(dependsOnId, taskId) as { task_id: string } | undefined;
    assertCondition(!cycle, `Ordering ${taskId} after ${dependsOnId} would create a dependency cycle.`);
}

/**
 * Place a task at the requested queue location and maintain its order dependency.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Enqueue request payload.
 */
function applyEnqueueEvent(store: IStore, task: ITaskRow, payload: IEventPayload): Record<string, unknown> {
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot enqueue ${task.task_id} from ${task.state}.`);
    let afterTaskId: string | undefined;
    if (payload.afterTaskId) {
        afterTaskId = validateTaskId(payload.afterTaskId);
        assertCondition(afterTaskId !== task.task_id, "A task cannot be queued after itself.");
        requireTask(store, afterTaskId);
    }
    const activeRows = store.database.prepare(`
        SELECT task_id FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED') AND task_id <> ?
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all(task.task_id) as Array<{ task_id: string }>;
    const orderedTaskIds: string[] = [];
    for (const row of activeRows) {
        orderedTaskIds.push(row.task_id);
    }
    if (afterTaskId) {
        const afterIndex = orderedTaskIds.indexOf(afterTaskId);
        if (afterIndex >= 0) {
            orderedTaskIds.splice(afterIndex + 1, 0, task.task_id);
        } else {
            orderedTaskIds.push(task.task_id);
        }
    } else {
        orderedTaskIds.push(task.task_id);
    }
    store.database.prepare("DELETE FROM dependencies WHERE task_id = ? AND dependency_kind = 'ORDER'").run(task.task_id);
    if (afterTaskId) {
        assertDependencyIsAcyclic(store, task.task_id, afterTaskId);
        store.database.prepare("INSERT INTO dependencies (task_id, depends_on_id, dependency_kind) VALUES (?, ?, 'ORDER')").run(task.task_id, afterTaskId);
    }
    store.database.prepare(`
        UPDATE tasks
        SET state = 'QUEUED', blocked_from_state = NULL, base_commit = NULL,
            branch_name = NULL, reviewed_commit = NULL, updated_at = ?
        WHERE task_id = ?
    `).run(currentTimestamp(), task.task_id);
    writeQueueOrder(store, orderedTaskIds);
    const refreshedTask = requireTask(store, task.task_id);
    return {
        action: "ENQUEUED",
        task: serializeTask(refreshedTask),
        afterTaskId: afterTaskId || null,
        executionBrief: {
            taskId: refreshedTask.task_id,
            title: titleForTask(refreshedTask),
            projectRoot: store.projectRoot,
            dependencies: afterTaskId ? [afterTaskId] : [],
            instruction: "Wait for Control Room activation. Do not create a branch, modify files, stage changes, or commit."
        }
    };
}

/**
 * Apply a pending event to the state machine.
 * @param store Open project store.
 * @param event Pending event record.
 */
function applyPendingEvent(store: IStore, event: IEventRow): Record<string, unknown> {
    const task = requireTask(store, event.task_id);
    const payload = JSON.parse(event.payload_json) as IEventPayload;
    if (event.kind === "ENQUEUE_REQUESTED") {
        return applyEnqueueEvent(store, task, payload);
    }
    if (event.kind === "REVIEW_REQUESTED") {
        if (task.state === "APPROVED" || task.state === "DONE") {
            return { action: "REVIEW_ALREADY_RECORDED", task: serializeTask(task), summary: payload.summary || null };
        }
        if (task.state === "REVIEW") {
            return { action: "REVIEW_ALREADY_RECORDED", task: serializeTask(task), summary: payload.summary || null };
        }
        assertCondition(task.state === "RUNNING", `Cannot request review for ${task.task_id} from ${task.state}.`);
        store.database.prepare("UPDATE tasks SET state = 'REVIEW', updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "REVIEW_READY", task: serializeTask(refreshedTask), summary: payload.summary || null };
    }
    if (event.kind === "APPROVAL_REQUESTED") {
        if (task.state === "APPROVED" || task.state === "DONE") {
            return { action: "APPROVAL_ALREADY_RECORDED", task: serializeTask(task), userRequestId: payload.userRequestId };
        }
        assertCondition(task.state === "REVIEW", `Cannot approve ${task.task_id} from ${task.state}.`);
        assertCondition(payload.userRequestId && payload.userRequestId.trim().length > 0, "Approval requires a direct user request ID.");
        store.database.prepare("UPDATE tasks SET state = 'APPROVED', updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "APPROVED", task: serializeTask(refreshedTask), userRequestId: payload.userRequestId };
    }
    if (event.kind === "CANCEL_REQUESTED") {
        assertCondition(payload.userRequestId && payload.userRequestId.trim().length > 0, "Cancellation requires a direct user request ID.");
        if (task.state === "CANCELED") {
            return { action: "CANCELLATION_ALREADY_RECORDED", task: serializeTask(task), userRequestId: payload.userRequestId };
        }
        assertCondition(["PLANNING", "QUEUED", "RUNNING", "REVIEW", "BLOCKED"].includes(task.state), `Cannot cancel ${task.task_id} from ${task.state}.`);
        store.database.prepare("UPDATE tasks SET state = 'CANCELED', blocked_from_state = NULL, queue_position = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const activeRows = store.database.prepare(`
            SELECT task_id FROM tasks
            WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
            ORDER BY queue_position IS NULL, queue_position, task_number
        `).all() as Array<{ task_id: string }>;
        const activeTaskIds: string[] = [];
        for (const activeRow of activeRows) {
            activeTaskIds.push(activeRow.task_id);
        }
        writeQueueOrder(store, activeTaskIds);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "CANCELED", task: serializeTask(refreshedTask), userRequestId: payload.userRequestId };
    }
    assertCondition(event.kind === "BLOCKED_REPORTED", `Unsupported event kind: ${event.kind}`);
    if (task.state === "BLOCKED") {
        return { action: "BLOCK_ALREADY_RECORDED", task: serializeTask(task), reason: payload.reason };
    }
    assertCondition(task.state === "QUEUED" || task.state === "RUNNING" || task.state === "REVIEW", `Cannot block ${task.task_id} from ${task.state}.`);
    assertCondition(payload.reason && payload.reason.trim().length > 0, "A blocked event requires a reason.");
    store.database.prepare("UPDATE tasks SET state = 'BLOCKED', blocked_from_state = ?, updated_at = ? WHERE task_id = ?").run(task.state, currentTimestamp(), task.task_id);
    const refreshedTask = requireTask(store, task.task_id);
    return { action: "BLOCKED", task: serializeTask(refreshedTask), reason: payload.reason };
}

/**
 * Process pending events serially as the coordinator.
 * @param options Project and optional state-root settings.
 */
function processPendingEvents(options: IControlRoomOptions): Record<string, unknown> {
    const store = openStore(options);
    const results: Record<string, unknown>[] = [];
    try {
        requireProject(store);
        const pendingEvents = store.database.prepare(`
            SELECT sequence, event_key, task_id, kind, payload_json
            FROM events
            WHERE processed_at IS NULL
            ORDER BY sequence
        `).all() as IEventRow[];
        for (const event of pendingEvents) {
            beginTransaction(store.database);
            try {
                const stillPending = store.database.prepare("SELECT processed_at FROM events WHERE sequence = ?").get(event.sequence) as { processed_at: string | null } | undefined;
                if (!stillPending || stillPending.processed_at) {
                    commitTransaction(store.database);
                    continue;
                }
                const result = applyPendingEvent(store, event);
                store.database.prepare("UPDATE events SET processed_at = ?, result_json = ? WHERE sequence = ?").run(currentTimestamp(), JSON.stringify(result), event.sequence);
                commitTransaction(store.database);
                results.push({ eventKey: event.event_key, ...result });
            } catch (error) {
                rollbackTransaction(store.database);
                const message = error instanceof Error ? error.message : String(error);
                beginTransaction(store.database);
                try {
                    const rejectedResult = { action: "REJECTED", taskId: event.task_id, error: message };
                    store.database.prepare("UPDATE events SET processed_at = ?, result_json = ? WHERE sequence = ?").run(currentTimestamp(), JSON.stringify(rejectedResult), event.sequence);
                    commitTransaction(store.database);
                    results.push({ eventKey: event.event_key, ...rejectedResult });
                } catch (rejectionError) {
                    rollbackTransaction(store.database);
                    throw rejectionError;
                }
            }
        }
        return { processedCount: results.length, coordinatorTitle: titleForCoordinator(), results };
    } finally {
        store.database.close();
    }
}

/**
 * Determine whether every dependency for a task is complete.
 * @param store Open project store.
 * @param taskId Task whose dependencies must be checked.
 */
function dependenciesAreDone(store: IStore, taskId: string): boolean {
    const unmet = store.database.prepare(`
        SELECT COUNT(*) AS count
        FROM dependencies AS dependency
        JOIN tasks AS prerequisite ON prerequisite.task_id = dependency.depends_on_id
        WHERE dependency.task_id = ? AND prerequisite.state <> 'DONE'
    `).get(taskId) as { count: number };
    return Number(unmet.count) === 0;
}

/**
 * Activate the first eligible queued task when the project is idle.
 * @param options Project and optional state-root settings.
 */
function activateNextTask(options: IControlRoomOptions): Record<string, unknown> {
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const exclusiveTask = store.database.prepare("SELECT task_id, state FROM tasks WHERE state IN ('RUNNING', 'REVIEW', 'APPROVED') LIMIT 1").get() as Record<string, unknown> | undefined;
        assertCondition(!exclusiveTask, exclusiveTask ? `Project is waiting on ${exclusiveTask.task_id} in ${exclusiveTask.state}.` : "Project is not idle.");
        const queuedTasks = store.database.prepare("SELECT * FROM tasks WHERE state = 'QUEUED' ORDER BY queue_position, task_number").all() as ITaskRow[];
        let selectedTask: ITaskRow | undefined;
        for (const queuedTask of queuedTasks) {
            if (dependenciesAreDone(store, queuedTask.task_id)) {
                selectedTask = queuedTask;
                break;
            }
        }
        if (!selectedTask) {
            const coordinatorTitle = titleForCoordinator();
            commitTransaction(store.database);
            return { activated: false, coordinatorTitle, reason: queuedTasks.length === 0 ? "QUEUE_EMPTY" : "DEPENDENCIES_PENDING" };
        }
        const workerBranch = workerBranchForTask(selectedTask.task_id);
        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "The shared Local working tree must be clean before activating a task.");
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        let currentBaseCommit: string;
        if (currentBranch === project.base_branch) {
            currentBaseCommit = requireBaseCheckout(store.projectRoot, project.base_branch);
            const existingWorkerBranch = runGit(store.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workerBranch}`]);
            assertCondition(
                existingWorkerBranch.status === 1,
                existingWorkerBranch.status === 0 ?
                    `Worker branch already exists for ${selectedTask.task_id}: ${workerBranch}` :
                    `Inspect worker branch failed: ${existingWorkerBranch.stderr || existingWorkerBranch.stdout}`
            );
            requireGit(store.projectRoot, ["checkout", "-b", workerBranch, project.base_branch], `Create worker branch ${workerBranch}`);
        } else {
            assertCondition(currentBranch === workerBranch, `ControlRoom requires branch ${project.base_branch}; found ${currentBranch || "detached HEAD"}.`);
            currentBaseCommit = resolveLocalBranchHead(store.projectRoot, project.base_branch);
            assertCondition(requireBranchCheckout(store.projectRoot, workerBranch) === currentBaseCommit, `Interrupted activation branch ${workerBranch} moved before state persistence.`);
        }
        store.database.prepare(`
            UPDATE tasks
            SET state = 'RUNNING', base_commit = ?, branch_name = ?, reviewed_commit = NULL, updated_at = ?
            WHERE task_id = ?
        `).run(currentBaseCommit, workerBranch, currentTimestamp(), selectedTask.task_id);
        const runningTask = requireTask(store, selectedTask.task_id);
        const dependencyRows = store.database.prepare("SELECT depends_on_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_id").all(runningTask.task_id) as Array<{ depends_on_id: string }>;
        const dependencies: string[] = [];
        for (const dependencyRow of dependencyRows) {
            dependencies.push(dependencyRow.depends_on_id);
        }
        const coordinatorTitle = titleForCoordinator();
        commitTransaction(store.database);
        return {
            activated: true,
            coordinatorTitle,
            task: serializeTask(runningTask),
            executionBrief: {
                taskId: runningTask.task_id,
                threadId: runningTask.thread_id,
                semanticName: runningTask.semantic_name,
                projectRoot: store.projectRoot,
                baseCommit: runningTask.base_commit,
                baseBranch: project.base_branch,
                workerBranch: runningTask.branch_name,
                dependencies,
                instruction: "Implement on the active worker branch without staging or committing. Leave all changes uncommitted for review."
            }
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Resume a blocked task to its recorded prior state.
 * @param options Project and optional state-root settings.
 * @param taskId Blocked task identifier.
 */
function resumeTask(options: IControlRoomOptions, taskId: string): Record<string, unknown> {
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        requireProject(store);
        const task = requireTask(store, taskId);
        assertCondition(task.state === "BLOCKED" && task.blocked_from_state, `${task.task_id} is not resumable.`);
        if (task.blocked_from_state === "RUNNING" || task.blocked_from_state === "REVIEW") {
            const exclusiveTask = store.database.prepare("SELECT task_id FROM tasks WHERE state IN ('RUNNING', 'REVIEW', 'APPROVED') AND task_id <> ? LIMIT 1").get(task.task_id) as Record<string, unknown> | undefined;
            assertCondition(!exclusiveTask, exclusiveTask ? `Another task is active: ${exclusiveTask.task_id}` : "Project is not idle.");
        }
        store.database.prepare("UPDATE tasks SET state = blocked_from_state, blocked_from_state = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const resumedTask = requireTask(store, task.task_id);
        commitTransaction(store.database);
        return { resumed: true, task: serializeTask(resumedTask) };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Run a Git command with fixed executable and argument boundaries.
 * @param projectRoot Canonical repository root used as working directory.
 * @param argumentsList Git arguments passed without a shell.
 */
function runGit(projectRoot: string, argumentsList: string[]): IGitResult {
    const result = childProcess.spawnSync("git", argumentsList, {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        shell: false
    });
    return {
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
        stderr: typeof result.stderr === "string" ? result.stderr.trim() : ""
    };
}

/**
 * Require a successful Git command and return its standard output.
 * @param projectRoot Canonical repository root used as working directory.
 * @param argumentsList Git arguments passed without a shell.
 * @param operation Human-readable operation used in failures.
 */
function requireGit(projectRoot: string, argumentsList: string[], operation: string): string {
    const result = runGit(projectRoot, argumentsList);
    assertCondition(result.status === 0, `${operation} failed: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`);
    return result.stdout;
}

/**
 * Require a named branch to be the current checkout and return HEAD.
 * @param projectRoot Canonical repository root used as working directory.
 * @param branchName Expected current branch.
 */
function requireBranchCheckout(projectRoot: string, branchName: string): string {
    const validBranchName = validateBranchName(branchName);
    const repositoryRoot = requireGit(projectRoot, ["rev-parse", "--show-toplevel"], "Resolve Git repository");
    assertCondition(fs.realpathSync(repositoryRoot) === projectRoot, "Git repository root does not match the Control Room project root.");
    const currentBranch = requireGit(projectRoot, ["branch", "--show-current"], "Resolve current branch");
    assertCondition(currentBranch === validBranchName, `ControlRoom requires branch ${validBranchName}; found ${currentBranch || "detached HEAD"}.`);
    return validateCommitId(requireGit(projectRoot, ["rev-parse", "HEAD"], "Resolve current head"));
}

/**
 * Require the configured base branch to be the current checkout and return HEAD.
 * @param projectRoot Canonical repository root used as working directory.
 * @param baseBranch Configured shared base branch.
 */
function requireBaseCheckout(projectRoot: string, baseBranch: string): string {
    return requireBranchCheckout(projectRoot, baseBranch);
}

/**
 * Read staged, unstaged, and untracked working-tree changes.
 * @param projectRoot Canonical repository root used as working directory.
 */
function readWorkingTreeStatus(projectRoot: string): string {
    return requireGit(projectRoot, ["status", "--porcelain", "--untracked-files=all"], "Inspect working tree");
}

/**
 * Resolve an unambiguous local branch head commit.
 * @param projectRoot Canonical repository root used as working directory.
 * @param branchName Local branch name without a refs prefix.
 */
function resolveLocalBranchHead(projectRoot: string, branchName: string): string {
    const validBranchName = validateBranchName(branchName);
    const branchReference = `refs/heads/${validBranchName}^{commit}`;
    return validateCommitId(requireGit(projectRoot, ["rev-parse", "--verify", branchReference], `Resolve local branch ${validBranchName}`));
}

/**
 * Determine whether a commit is the single approval commit expected after a recorded parent.
 * @param projectRoot Canonical repository root used as working directory.
 * @param commitId Candidate approval commit.
 * @param parentCommitId Recorded pre-approval parent commit.
 * @param expectedSubject Expected approval commit subject.
 */
function commitMatchesApproval(projectRoot: string, commitId: string, parentCommitId: string, expectedSubject: string): boolean {
    if (commitId === parentCommitId) {
        return false;
    }
    const parentResult = runGit(projectRoot, ["rev-parse", `${commitId}^`]);
    if (parentResult.status !== 0 || !COMMIT_PATTERN.test(parentResult.stdout)) {
        return false;
    }
    const subjectResult = runGit(projectRoot, ["log", "-1", "--format=%s", commitId]);
    return subjectResult.status === 0 && validateCommitId(parentResult.stdout) === parentCommitId && subjectResult.stdout === expectedSubject;
}

/**
 * Compact active queue positions after a terminal transition.
 * @param store Open project store.
 */
function compactActiveQueue(store: IStore): void {
    const rows = store.database.prepare(`
        SELECT task_id FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all() as Array<{ task_id: string }>;
    const taskIds: string[] = [];
    for (const row of rows) {
        taskIds.push(row.task_id);
    }
    writeQueueOrder(store, taskIds);
}

/**
 * Finalize a successful approved commit in persistent state.
 * @param store Open project store.
 * @param taskId Approved task identifier.
 * @param committedCommit Commit created by approval.
 * @param merged Whether approval fast-forwarded the base branch.
 * @param branchDeleted Whether approval deleted the worker branch.
 */
function finalizeApprovedCommit(store: IStore, taskId: string, committedCommit: string, merged: boolean, branchDeleted: boolean): Record<string, unknown> {
    beginTransaction(store.database);
    try {
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        assertCondition(project.integration_task_id === task.task_id, `Commit lease for ${task.task_id} was lost.`);
        assertCondition(task.state === "APPROVED", `Cannot finalize ${task.task_id} from ${task.state}.`);
        if (branchDeleted) {
            store.database.prepare(`
                UPDATE tasks
                SET state = 'DONE', branch_name = NULL, integrated_commit = ?, queue_position = NULL, updated_at = ?
                WHERE task_id = ?
            `).run(committedCommit, currentTimestamp(), task.task_id);
        } else {
            store.database.prepare(`
                UPDATE tasks
                SET state = 'DONE', integrated_commit = ?, queue_position = NULL, updated_at = ?
                WHERE task_id = ?
            `).run(committedCommit, currentTimestamp(), task.task_id);
        }
        store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
        compactActiveQueue(store);
        const completedTask = requireTask(store, task.task_id);
        commitTransaction(store.database);
        return { committed: true, merged, branchDeleted, coordinatorTitle: titleForCoordinator(), gitMode: GIT_MODE, task: serializeTask(completedTask) };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    }
}

/**
 * Complete an approved task, committing dirty changes on the current task or base branch when needed.
 * @param options Project and optional state-root settings.
 * @param taskId Approved task identifier.
 */
function commitApprovedTask(options: IControlRoomOptions, taskId: string): Record<string, unknown> {
    const store = openStore(options);
    let leaseAcquired = false;
    try {
        beginTransaction(store.database);
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        if (task.state === "DONE") {
            commitTransaction(store.database);
            return {
                committed: false,
                alreadyCompleted: true,
                alreadyCommitted: Boolean(task.integrated_commit),
                coordinatorTitle: titleForCoordinator(),
                gitMode: GIT_MODE,
                task: serializeTask(task)
            };
        }
        assertCondition(task.state === "APPROVED", `Cannot commit ${task.task_id} from ${task.state}.`);
        assertCondition(!project.integration_task_id, `Commit lease is already held by ${project.integration_task_id}; use recover-commit only after confirming the prior process ended.`);
        const workingTreeStatus = readWorkingTreeStatus(store.projectRoot);
        if (workingTreeStatus.length === 0) {
            store.database.prepare("UPDATE tasks SET state = 'DONE', queue_position = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
            compactActiveQueue(store);
            const completedTask = requireTask(store, task.task_id);
            commitTransaction(store.database);
            return {
                committed: false,
                dequeued: true,
                noUncommittedChanges: true,
                coordinatorTitle: titleForCoordinator(),
                gitMode: GIT_MODE,
                task: serializeTask(completedTask)
            };
        }
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        const commitsOnBase = currentBranch === project.base_branch;
        assertCondition(commitsOnBase || currentBranch === task.branch_name, `Cannot commit ${task.task_id} from unrelated branch ${currentBranch || "detached HEAD"}.`);
        const currentHead = validateCommitId(requireGit(store.projectRoot, ["rev-parse", "HEAD"], "Resolve pre-approval head"));
        const timestamp = currentTimestamp();
        store.database.prepare("UPDATE tasks SET reviewed_commit = ?, updated_at = ? WHERE task_id = ?").run(currentHead, timestamp, task.task_id);
        store.database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?, updated_at = ? WHERE project_key = ?").run(task.task_id, timestamp, timestamp, store.projectKey);
        commitTransaction(store.database);
        leaseAcquired = true;

        requireGit(store.projectRoot, ["add", "-A", "--", "."], "Stage approved changes");
        const stagedDifference = runGit(store.projectRoot, ["diff", "--cached", "--quiet", "HEAD", "--"]);
        assertCondition(stagedDifference.status === 1, stagedDifference.status === 0 ? "Approval produced no staged changes." : `Inspect staged changes failed: ${stagedDifference.stderr || stagedDifference.stdout}`);
        const commitMessage = `${task.task_id} - ${task.semantic_name}`;
        requireGit(store.projectRoot, ["commit", "--message", commitMessage], "Commit approved changes");
        const committedCommit = validateCommitId(requireGit(store.projectRoot, ["rev-parse", "HEAD"], "Resolve approved commit"));
        const parentCommit = validateCommitId(requireGit(store.projectRoot, ["rev-parse", "HEAD^"], "Resolve approved commit parent"));
        assertCondition(parentCommit === currentHead, `Approved commit parent ${parentCommit} does not match pre-approval HEAD ${currentHead}.`);
        if (commitsOnBase) {
            return finalizeApprovedCommit(store, task.task_id, committedCommit, false, false);
        }
        assertCondition(task.branch_name, `${task.task_id} has no worker branch.`);
        requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out base branch ${project.base_branch}`);
        requireBaseCheckout(store.projectRoot, project.base_branch);
        requireGit(store.projectRoot, ["merge", "--ff-only", committedCommit], `Fast-forward ${project.base_branch} to ${task.task_id}`);
        assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === committedCommit, `${project.base_branch} did not reach approved commit ${committedCommit}.`);
        requireGit(store.projectRoot, ["branch", "--delete", task.branch_name], `Delete worker branch ${task.branch_name}`);
        return finalizeApprovedCommit(store, task.task_id, committedCommit, true, true);
    } catch (error) {
        rollbackTransaction(store.database);
        const message = error instanceof Error ? error.message : String(error);
        if (leaseAcquired) {
            throw new Error(`${message} The commit lease remains active; run recover-commit only after confirming this process ended.`);
        }
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Recover a commit lease after confirming the previous commit process ended.
 * @param options Project and optional state-root settings.
 * @param taskId Task holding the stale commit lease.
 */
function recoverCommit(options: IControlRoomOptions, taskId: string): Record<string, unknown> {
    const store = openStore(options);
    try {
        const project = requireProject(store);
        const task = requireTask(store, taskId);
        if (task.state === "DONE") {
            return {
                recovered: false,
                alreadyCompleted: true,
                alreadyCommitted: Boolean(task.integrated_commit),
                coordinatorTitle: titleForCoordinator(),
                task: serializeTask(task)
            };
        }
        assertCondition(project.integration_task_id === task.task_id, `${task.task_id} does not hold the commit lease.`);
        assertCondition(task.state === "APPROVED" && task.base_commit && task.reviewed_commit, `${task.task_id} does not have a recoverable approval.`);
        const workerBranchResult = task.branch_name ?
            runGit(store.projectRoot, ["rev-parse", "--verify", `refs/heads/${task.branch_name}^{commit}`]) :
            { status: 128, stdout: "", stderr: "" };
        assertCondition(workerBranchResult.status === 0 || workerBranchResult.status === 128, `Resolve worker branch ${String(task.branch_name)} failed: ${workerBranchResult.stderr || workerBranchResult.stdout}`);
        const workerCommit = workerBranchResult.status === 0 ? validateCommitId(workerBranchResult.stdout) : null;
        const currentBaseCommit = resolveLocalBranchHead(store.projectRoot, project.base_branch);
        const expectedSubject = `${task.task_id} - ${task.semantic_name}`;
        const workerCommitIsApproval = Boolean(workerCommit && commitMatchesApproval(store.projectRoot, workerCommit, task.reviewed_commit, expectedSubject));
        const baseCommitIsApproval = commitMatchesApproval(store.projectRoot, currentBaseCommit, task.reviewed_commit, expectedSubject);
        if (!workerCommitIsApproval && !baseCommitIsApproval && (workerCommit === task.reviewed_commit || currentBaseCommit === task.reviewed_commit)) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
            beginTransaction(store.database);
            const lockedProject = requireProject(store);
            assertCondition(lockedProject.integration_task_id === task.task_id, `Commit lease for ${task.task_id} changed during recovery.`);
            store.database.prepare("UPDATE tasks SET reviewed_commit = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
            store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
            const retryTask = requireTask(store, task.task_id);
            commitTransaction(store.database);
            return { recovered: true, finalized: false, retryCommit: true, coordinatorTitle: titleForCoordinator(), task: serializeTask(retryTask) };
        }
        assertCondition(workerCommitIsApproval || baseCommitIsApproval, `Git history does not contain the approved commit expected for ${task.task_id}.`);
        if (baseCommitIsApproval && workerCommit !== currentBaseCommit) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            if (currentBranch !== project.base_branch) {
                assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, `Cannot restore ${project.base_branch} with a dirty working tree.`);
                requireGit(store.projectRoot, ["checkout", project.base_branch], `Restore base branch ${project.base_branch}`);
            }
            const workerBranchWasDeleted = Boolean(task.branch_name && !workerCommit);
            const result = finalizeApprovedCommit(store, task.task_id, currentBaseCommit, workerBranchWasDeleted, workerBranchWasDeleted);
            return { ...result, recovered: true, finalized: true };
        }
        assertCondition(workerCommit && task.branch_name, `${task.task_id} has no recoverable worker commit.`);
        const approvedCommit = workerCommit;
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        if (currentBranch !== project.base_branch) {
            assertCondition(currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
            requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out base branch ${project.base_branch}`);
        }
        const baseCommit = requireBaseCheckout(store.projectRoot, project.base_branch);
        if (baseCommit !== approvedCommit) {
            requireGit(store.projectRoot, ["merge", "--ff-only", approvedCommit], `Recover fast-forward of ${project.base_branch}`);
        }
        assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === approvedCommit, `${project.base_branch} did not reach recovered commit ${approvedCommit}.`);
        if (workerCommit) {
            requireGit(store.projectRoot, ["branch", "--delete", task.branch_name], `Delete recovered worker branch ${task.branch_name}`);
        }
        const result = finalizeApprovedCommit(store, task.task_id, approvedCommit, true, true);
        return { ...result, recovered: true, finalized: true };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Read the project snapshot or one task without changing state.
 * @param options Project and optional state-root settings.
 * @param taskId Optional task identifier to select.
 */
function getStatus(options: IControlRoomOptions, taskId?: string): Record<string, unknown> {
    const store = openStore(options);
    try {
        const project = requireProject(store);
        if (taskId) {
            return { projectRoot: store.projectRoot, coordinatorTitle: titleForCoordinator(), task: serializeTask(requireTask(store, taskId)) };
        }
        const counts = store.database.prepare("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state ORDER BY state").all() as Array<{ state: TaskState; count: number }>;
        const stateCounts: Record<string, number> = {};
        for (const countRow of counts) {
            stateCounts[countRow.state] = Number(countRow.count);
        }
        return {
            projectRoot: store.projectRoot,
            coordinatorTitle: titleForCoordinator(),
            coordinatorThreadId: project.coordinator_thread_id,
            baseBranch: project.base_branch,
            gitMode: project.git_mode,
            commitTaskId: project.integration_task_id,
            nextTaskId: project.next_task_number <= 9999 ? `T${String(project.next_task_number).padStart(4, "0")}` : null,
            stateCounts
        };
    } finally {
        store.database.close();
    }
}

/**
 * Read the ordered active queue without changing state.
 * @param options Project and optional state-root settings.
 */
function getQueue(options: IControlRoomOptions): Record<string, unknown> {
    const store = openStore(options);
    try {
        requireProject(store);
        const tasks = store.database.prepare(`
            SELECT * FROM tasks
            WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
            ORDER BY queue_position IS NULL, queue_position, task_number
        `).all() as ITaskRow[];
        const queue: Record<string, unknown>[] = [];
        for (const task of tasks) {
            const dependencyRows = store.database.prepare("SELECT depends_on_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_id").all(task.task_id) as Array<{ depends_on_id: string }>;
            const dependencies: string[] = [];
            for (const dependencyRow of dependencyRows) {
                dependencies.push(dependencyRow.depends_on_id);
            }
            queue.push({ ...serializeTask(task), dependencies });
        }
        return { projectRoot: store.projectRoot, coordinatorTitle: titleForCoordinator(), queue };
    } finally {
        store.database.close();
    }
}

module.exports = {
    activateNextTask,
    commitApprovedTask,
    getQueue,
    getStatus,
    initializeProject,
    processPendingEvents,
    recoverCommit,
    registerTask,
    resumeTask,
    submitEvent,
    titleForCoordinator,
    titleForTask
};
