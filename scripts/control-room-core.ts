const childProcess = require("node:child_process");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

type TaskState = "PLANNING" | "QUEUED" | "RUNNING" | "REVIEW" | "APPROVED" | "DONE" | "BLOCKED" | "CANCELED";
type EventKind = "ENQUEUE_REQUESTED" | "MOVE_REQUESTED" | "DEPENDENCY_ADD_REQUESTED" | "DEPENDENCY_REMOVE_REQUESTED" | "REVIEW_REQUESTED" | "REWORK_REQUESTED" | "APPROVAL_REQUESTED" | "CANCEL_REQUESTED" | "BLOCKED_REPORTED";

interface IControlRoomOptions {
    projectRoot: string;
    stateRoot?: string;
}

interface IEventPayload {
    afterTaskId?: string;
    beforeTaskId?: string;
    commitMessage?: string;
    dependencyTaskId?: string;
    position?: number;
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
    queued_display_position?: number | null;
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

interface ITitleUpdate {
    taskId: string;
    threadId: string;
    title: string;
}

const TASK_ID_PATTERN = /^T\d{4}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const ACTIVE_STATES: TaskState[] = ["QUEUED", "RUNNING", "REVIEW", "APPROVED", "BLOCKED"];
const QUEUE_POSITION_DIGITS = ["⓪", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
const TASK_WITH_QUEUED_POSITION_SELECT = `
    SELECT task.*,
        CASE
            WHEN task.state = 'QUEUED' AND task.queue_position IS NOT NULL THEN (
                SELECT COUNT(*)
                FROM tasks AS queued_task
                WHERE queued_task.state = 'QUEUED'
                    AND (
                        queued_task.queue_position < task.queue_position
                        OR (
                            queued_task.queue_position = task.queue_position
                            AND queued_task.task_number <= task.task_number
                        )
                    )
            )
            ELSE NULL
        END AS queued_display_position
    FROM tasks AS task
`;
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
    const normalizedName = semanticName.trim().replace(/^(?:⚪️|⭕️|🔴|🟡|🔵|💪|🟢|✅|❌|👉)\s*(?:(?:[⓪①-⑨]+|[❶-❾]|#\d{1,4})\s+)?/u, "");
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
 * Validate a concise one-line Git commit subject.
 * @param commitMessage Commit subject supplied with direct approval.
 */
function validateCommitMessage(commitMessage: string | undefined): string {
    const normalizedMessage = validateCompactText(commitMessage, "Commit message", 72, true);
    assertCondition(normalizedMessage && normalizedMessage.length >= 8, "Commit message must contain at least 8 characters.");
    assertCondition(!/[\t\r\n]/u.test(normalizedMessage), "Commit message must be a single line.");
    assertCondition(/[A-Za-z]/u.test(normalizedMessage), "Commit message must contain Latin letters.");
    return normalizedMessage;
}

/**
 * Reject a commit subject copied from the task identifier or semantic title.
 * @param task Task receiving direct approval.
 * @param commitMessage Proposed commit subject.
 */
function validateApprovalCommitMessage(task: ITaskRow, commitMessage: string | undefined): string {
    const normalizedMessage = validateCommitMessage(commitMessage);
    const normalizedComparison = normalizedMessage.toLocaleLowerCase("en-US");
    const semanticComparison = task.semantic_name.trim().toLocaleLowerCase("en-US");
    assertCondition(normalizedComparison !== semanticComparison, "Commit message must describe the implemented change rather than copy the task name.");
    assertCondition(!normalizedComparison.startsWith(`${task.task_id.toLocaleLowerCase("en-US")} -`), "Commit message must not use the task title format.");
    return normalizedMessage;
}

/**
 * Validate a one-based position in the waiting queue.
 * @param position Queue position supplied by the caller.
 */
function validateQueuePosition(position: number | undefined): number {
    assertCondition(Number.isSafeInteger(position) && Number(position) >= 1 && Number(position) <= 9999, "Queue position must be an integer between 1 and 9999.");
    return Number(position);
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
    if (kind === "MOVE_REQUESTED") {
        const selectorCount = Number(Boolean(payload.beforeTaskId)) + Number(Boolean(payload.afterTaskId)) + Number(payload.position !== undefined);
        assertCondition(selectorCount === 1, "Move requires exactly one destination: before, after, or position.");
        return {
            afterTaskId: payload.afterTaskId ? validateTaskId(payload.afterTaskId) : undefined,
            beforeTaskId: payload.beforeTaskId ? validateTaskId(payload.beforeTaskId) : undefined,
            position: payload.position !== undefined ? validateQueuePosition(payload.position) : undefined
        };
    }
    if (kind === "DEPENDENCY_ADD_REQUESTED" || kind === "DEPENDENCY_REMOVE_REQUESTED") {
        return {
            dependencyTaskId: validateTaskId(String(payload.dependencyTaskId || ""))
        };
    }
    if (kind === "REVIEW_REQUESTED" || kind === "REWORK_REQUESTED") {
        return {
            summary: validateCompactText(payload.summary, kind === "REVIEW_REQUESTED" ? "Review summary" : "Rework summary", 2000, false)
        };
    }
    if (kind === "APPROVAL_REQUESTED") {
        return {
            commitMessage: validateCommitMessage(payload.commitMessage),
            userRequestId: validateCompactText(payload.userRequestId, "Direct user request ID", 200, true)
        };
    }
    if (kind === "CANCEL_REQUESTED") {
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
    assertCondition(schemaVersion >= 0 && schemaVersion <= 5, `Unsupported Control Room schema version: ${schemaVersion}`);
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
                dependency_kind TEXT NOT NULL CHECK (dependency_kind = 'BLOCKING'),
                PRIMARY KEY (task_id, depends_on_id, dependency_kind),
                CHECK (task_id <> depends_on_id)
            );
            CREATE TABLE IF NOT EXISTS events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                kind TEXT NOT NULL CHECK (kind IN ('ENQUEUE_REQUESTED', 'MOVE_REQUESTED', 'DEPENDENCY_ADD_REQUESTED', 'DEPENDENCY_REMOVE_REQUESTED', 'REVIEW_REQUESTED', 'REWORK_REQUESTED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
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
        if (eventTable && !eventTable.sql.includes("REWORK_REQUESTED")) {
            database.exec(`
                ALTER TABLE events RENAME TO events_legacy;
                CREATE TABLE events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                    kind TEXT NOT NULL CHECK (kind IN ('ENQUEUE_REQUESTED', 'MOVE_REQUESTED', 'DEPENDENCY_ADD_REQUESTED', 'DEPENDENCY_REMOVE_REQUESTED', 'REVIEW_REQUESTED', 'REWORK_REQUESTED', 'APPROVAL_REQUESTED', 'CANCEL_REQUESTED', 'BLOCKED_REPORTED')),
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    processed_at TEXT,
                    result_json TEXT
                );
                INSERT INTO events (sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json)
                SELECT sequence, event_key, task_id, kind, payload_json, created_at, processed_at, result_json
                FROM events_legacy;
                DROP TABLE events_legacy;
            `);
        }
        database.exec(`
            CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_position);
            CREATE INDEX IF NOT EXISTS idx_events_pending ON events(processed_at, sequence);
            PRAGMA user_version = 5;
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
    const row = store.database.prepare(`${TASK_WITH_QUEUED_POSITION_SELECT} WHERE task.task_id = ?`).get(validTaskId) as ITaskRow | undefined;
    assertCondition(row, `Unknown task: ${validTaskId}`);
    return row;
}

/**
 * Format the visual marker for one waiting-queue position.
 * @param position One-based waiting-queue position.
 */
function queuePositionMarker(position: number | null): string {
    if (!Number.isSafeInteger(position) || Number(position) < 1) {
        return "";
    }
    return String(position).split("").map((digit) => QUEUE_POSITION_DIGITS[Number(digit)]).join("");
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
        const positionMarker = queuePositionMarker(task.queued_display_position ?? task.queue_position);
        prefix = positionMarker ? `⭕️ ${positionMarker} ` : "⭕️ ";
    } else if (task.state === "RUNNING") {
        prefix = "🔴 ";
    } else if (task.state === "REVIEW") {
        prefix = "💪 ";
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
 * Return the fixed Control Room console title.
 */
function titleForControlRoom(): string {
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
        queuedPosition: task.queued_display_position ?? null,
        baseCommit: task.base_commit,
        branchName: task.branch_name,
        committedCommit: task.integrated_commit
    };
}

/**
 * Initialize project coordination idempotently.
 * @param options Project and optional state-root settings.
 * @param controlRoomThreadId Control Room console thread identifier.
 * @param baseBranch Local Git base branch.
 */
function initializeProject(options: IControlRoomOptions, controlRoomThreadId: string, baseBranch: string): Record<string, unknown> {
    const validControlRoomThreadId = validateThreadId(controlRoomThreadId);
    const validBaseBranch = validateBranchName(baseBranch);
    const store = openStore(options);
    try {
        beginTransaction(store.database);
        const existingProject = store.database.prepare("SELECT * FROM projects WHERE project_key = ?").get(store.projectKey) as IProjectRow | undefined;
        if (existingProject) {
            assertCondition(existingProject.project_root === store.projectRoot, "Project hash collision detected.");
            assertCondition(existingProject.coordinator_thread_id === validControlRoomThreadId, "A different Control Room task is already registered for this project.");
            assertCondition(existingProject.base_branch === validBaseBranch, "The configured base branch does not match.");
            const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, existingProject.base_branch);
            const controlRoomTitle = titleForControlRoom();
            commitTransaction(store.database);
            return {
                created: false,
                title: controlRoomTitle,
                controlRoomTitle,
                projectRoot: store.projectRoot,
                controlRoomThreadId: existingProject.coordinator_thread_id,
                baseBranch: existingProject.base_branch,
                baseCommit,
                gitMode: existingProject.git_mode,
                databasePath: store.databasePath
            };
        }
        const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, validBaseBranch);
        if (!baseCommit) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            assertCondition(currentBranch === validBaseBranch, `Unborn base branch ${validBaseBranch} must be the current branch.`);
            assertCondition(resolveCurrentHeadIfExists(store.projectRoot) === null, `Base branch ${validBaseBranch} does not exist, but the current branch already has commits.`);
        }
        const timestamp = currentTimestamp();
        store.database.prepare(`
            INSERT INTO projects (project_key, project_root, coordinator_thread_id, base_branch, git_mode, next_task_number, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'local-approval-commit', 1, ?, ?)
        `).run(store.projectKey, store.projectRoot, validControlRoomThreadId, validBaseBranch, timestamp, timestamp);
        const controlRoomTitle = titleForControlRoom();
        commitTransaction(store.database);
        return {
            created: true,
            title: controlRoomTitle,
            controlRoomTitle,
            projectRoot: store.projectRoot,
            controlRoomThreadId: validControlRoomThreadId,
            baseBranch: validBaseBranch,
            baseCommit,
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
        assertCondition(project.coordinator_thread_id !== validThreadId, "The Control Room task cannot be registered as a worker task.");
        const existingTask = store.database.prepare("SELECT * FROM tasks WHERE thread_id = ?").get(validThreadId) as ITaskRow | undefined;
        if (existingTask) {
            if (existingTask.semantic_name !== validSemanticName) {
                assertCondition(existingTask.state === "PLANNING", "A semantic task name can change only during PLANNING.");
                store.database.prepare("UPDATE tasks SET semantic_name = ?, updated_at = ? WHERE task_id = ?").run(validSemanticName, currentTimestamp(), existingTask.task_id);
            }
            const refreshedTask = requireTask(store, existingTask.task_id);
            commitTransaction(store.database);
            return { created: false, controlRoomThreadId: project.coordinator_thread_id, ...serializeTask(refreshedTask) };
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
        return { created: true, controlRoomThreadId: project.coordinator_thread_id, ...serializeTask(createdTask) };
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
        requireProject(store);
        const task = requireTask(store, validTaskId);
        const payloadJson = JSON.stringify(validPayload);
        const existingEvent = store.database.prepare("SELECT event_key, task_id, kind, payload_json, processed_at FROM events WHERE event_key = ?").get(validEventKey) as Record<string, unknown> | undefined;
        if (existingEvent) {
            assertCondition(existingEvent.task_id === validTaskId && existingEvent.kind === kind && existingEvent.payload_json === payloadJson, "Event key already exists with different content.");
            commitTransaction(store.database);
            return {
                created: false,
                processed: Boolean(existingEvent.processed_at),
                eventKey: validEventKey
            };
        }
        if (kind === "ENQUEUE_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot request enqueue for ${task.task_id} from ${task.state}.`);
            if (validPayload.afterTaskId) {
                assertCondition(validPayload.afterTaskId !== task.task_id, "A task cannot be queued after itself.");
                requireTask(store, validPayload.afterTaskId);
            }
        } else if (kind === "MOVE_REQUESTED") {
            assertCondition(task.state === "QUEUED", `Cannot move ${task.task_id} from ${task.state}.`);
            const referenceTaskId = validPayload.beforeTaskId || validPayload.afterTaskId;
            if (referenceTaskId) {
                assertCondition(referenceTaskId !== task.task_id, "A task cannot be moved relative to itself.");
                const referenceTask = requireTask(store, referenceTaskId);
                assertCondition(referenceTask.state === "QUEUED", `${referenceTask.task_id} is not waiting in the queue.`);
            }
        } else if (kind === "DEPENDENCY_ADD_REQUESTED" || kind === "DEPENDENCY_REMOVE_REQUESTED") {
            assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot change dependencies for ${task.task_id} from ${task.state}.`);
            assertCondition(validPayload.dependencyTaskId !== task.task_id, "A task cannot depend on itself.");
            requireTask(store, String(validPayload.dependencyTaskId));
        } else if (kind === "REVIEW_REQUESTED") {
            assertCondition(task.state === "RUNNING" || task.state === "REVIEW", `Cannot request review for ${task.task_id} from ${task.state}.`);
        } else if (kind === "REWORK_REQUESTED") {
            assertCondition(task.state === "REVIEW", `Cannot request rework for ${task.task_id} from ${task.state}.`);
        } else if (kind === "APPROVAL_REQUESTED") {
            assertCondition(task.state === "REVIEW" || task.state === "APPROVED" || task.state === "DONE", `Cannot request approval for ${task.task_id} from ${task.state}.`);
            validateApprovalCommitMessage(task, validPayload.commitMessage);
        } else if (kind === "CANCEL_REQUESTED") {
            assertCondition(["PLANNING", "QUEUED", "RUNNING", "REVIEW", "BLOCKED", "CANCELED"].includes(task.state), `Cannot request cancellation for ${task.task_id} from ${task.state}.`);
        } else {
            assertCondition(["QUEUED", "RUNNING", "REVIEW", "BLOCKED"].includes(task.state), `Cannot report ${task.task_id} blocked from ${task.state}.`);
        }
        store.database.prepare(`
            INSERT INTO events (event_key, task_id, kind, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(validEventKey, validTaskId, kind, payloadJson, currentTimestamp());
        commitTransaction(store.database);
        return {
            created: true,
            processed: false,
            eventKey: validEventKey
        };
    } catch (error) {
        rollbackTransaction(store.database);
        throw error;
    } finally {
        store.database.close();
    }
}

/**
 * Normalize active queue positions and return changed queued title projections.
 * @param store Open project store.
 * @param orderedTaskIds Active task IDs in desired order.
 */
function writeQueueOrder(store: IStore, orderedTaskIds: string[]): ITitleUpdate[] {
    const readCurrentPosition = store.database.prepare("SELECT state, queue_position FROM tasks WHERE task_id = ?");
    const updatePosition = store.database.prepare("UPDATE tasks SET queue_position = ?, updated_at = ? WHERE task_id = ?");
    const timestamp = currentTimestamp();
    const changedQueuedTaskIds: string[] = [];
    for (let index = 0; index < orderedTaskIds.length; index += 1) {
        const taskId = orderedTaskIds[index];
        const nextPosition = index + 1;
        const current = readCurrentPosition.get(taskId) as { queue_position: number | null; state: TaskState } | undefined;
        assertCondition(current, `Cannot order unknown task: ${taskId}`);
        if (current.queue_position !== nextPosition) {
            updatePosition.run(nextPosition, timestamp, taskId);
            if (current.state === "QUEUED") {
                changedQueuedTaskIds.push(taskId);
            }
        }
    }
    const titleUpdates: ITitleUpdate[] = [];
    for (const taskId of changedQueuedTaskIds) {
        const queuedTask = requireTask(store, taskId);
        titleUpdates.push({
            taskId: queuedTask.task_id,
            threadId: queuedTask.thread_id,
            title: titleForTask(queuedTask)
        });
    }
    return titleUpdates;
}

/**
 * Project title updates for queued tasks at or after an active queue position.
 * @param store Open project store.
 * @param minimumQueuePosition First active queue position whose queued titles may have changed.
 */
function readQueuedTitleUpdates(store: IStore, minimumQueuePosition: number): ITitleUpdate[] {
    const queuedTasks = store.database.prepare(`
        ${TASK_WITH_QUEUED_POSITION_SELECT}
        WHERE task.state = 'QUEUED' AND task.queue_position >= ?
        ORDER BY task.queue_position, task.task_number
    `).all(minimumQueuePosition) as ITaskRow[];
    const titleUpdates: ITitleUpdate[] = [];
    for (const queuedTask of queuedTasks) {
        titleUpdates.push({
            taskId: queuedTask.task_id,
            threadId: queuedTask.thread_id,
            title: titleForTask(queuedTask)
        });
    }
    return titleUpdates;
}

/**
 * Read explicit blocking dependencies for one task.
 * @param store Open project store.
 * @param taskId Task whose dependencies should be read.
 */
function readTaskDependencies(store: IStore, taskId: string): string[] {
    const dependencyRows = store.database.prepare("SELECT depends_on_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_id").all(taskId) as Array<{ depends_on_id: string }>;
    const dependencies: string[] = [];
    for (const dependencyRow of dependencyRows) {
        dependencies.push(dependencyRow.depends_on_id);
    }
    return dependencies;
}

/**
 * Reject a blocking dependency that would create a cycle.
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
    assertCondition(!cycle, `Making ${taskId} depend on ${dependsOnId} would create a dependency cycle.`);
}

/**
 * Place a task at the requested queue location without changing dependencies.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Enqueue request payload.
 */
function applyEnqueueEvent(store: IStore, task: ITaskRow, payload: IEventPayload): Record<string, unknown> {
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot enqueue ${task.task_id} from ${task.state}.`);
    const wasAlreadyQueued = task.state === "QUEUED";
    let afterTaskId: string | undefined;
    if (payload.afterTaskId) {
        afterTaskId = validateTaskId(payload.afterTaskId);
        assertCondition(afterTaskId !== task.task_id, "A task cannot be queued after itself.");
        const afterTask = requireTask(store, afterTaskId);
        assertCondition(ACTIVE_STATES.includes(afterTask.state), `${afterTask.task_id} is not in the active queue.`);
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
    store.database.prepare(`
        UPDATE tasks
        SET state = 'QUEUED', blocked_from_state = NULL, base_commit = NULL,
            branch_name = NULL, reviewed_commit = NULL, updated_at = ?
        WHERE task_id = ?
    `).run(currentTimestamp(), task.task_id);
    const titleUpdates = writeQueueOrder(store, orderedTaskIds);
    const refreshedTask = requireTask(store, task.task_id);
    return {
        action: wasAlreadyQueued ? "REENQUEUED" : "ENQUEUED",
        task: serializeTask(refreshedTask),
        afterTaskId: afterTaskId || null,
        titleUpdates,
        executionBrief: {
            taskId: refreshedTask.task_id,
            title: titleForTask(refreshedTask),
            projectRoot: store.projectRoot,
            dependencies: readTaskDependencies(store, refreshedTask.task_id),
            instruction: "Wait for Control Room activation. Do not create a branch, modify files, stage changes, or commit."
        }
    };
}

/**
 * Reposition a waiting task without changing dependencies.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Move request payload.
 */
function applyMoveEvent(store: IStore, task: ITaskRow, payload: IEventPayload): Record<string, unknown> {
    assertCondition(task.state === "QUEUED", `Cannot move ${task.task_id} from ${task.state}.`);
    const activeRows = store.database.prepare(`
        SELECT task_id, state FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED') AND task_id <> ?
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all(task.task_id) as Array<{ task_id: string; state: TaskState }>;
    const orderedTaskIds = activeRows.map((row) => row.task_id);
    const waitingTaskIds = activeRows.filter((row) => row.state === "QUEUED").map((row) => row.task_id);
    let insertionIndex: number;
    if (payload.beforeTaskId) {
        insertionIndex = orderedTaskIds.indexOf(payload.beforeTaskId);
        assertCondition(insertionIndex >= 0 && waitingTaskIds.includes(payload.beforeTaskId), `${payload.beforeTaskId} is not waiting in the queue.`);
    } else if (payload.afterTaskId) {
        insertionIndex = orderedTaskIds.indexOf(payload.afterTaskId);
        assertCondition(insertionIndex >= 0 && waitingTaskIds.includes(payload.afterTaskId), `${payload.afterTaskId} is not waiting in the queue.`);
        insertionIndex += 1;
    } else {
        const position = validateQueuePosition(payload.position);
        assertCondition(position <= waitingTaskIds.length + 1, `Queue position ${position} exceeds the waiting queue length ${waitingTaskIds.length + 1}.`);
        if (position <= waitingTaskIds.length) {
            insertionIndex = orderedTaskIds.indexOf(waitingTaskIds[position - 1]);
        } else if (waitingTaskIds.length > 0) {
            insertionIndex = orderedTaskIds.indexOf(waitingTaskIds[waitingTaskIds.length - 1]) + 1;
        } else {
            insertionIndex = orderedTaskIds.length;
        }
    }
    orderedTaskIds.splice(insertionIndex, 0, task.task_id);
    const titleUpdates = writeQueueOrder(store, orderedTaskIds);
    const refreshedTask = requireTask(store, task.task_id);
    const refreshedWaitingRows = store.database.prepare("SELECT task_id FROM tasks WHERE state = 'QUEUED' ORDER BY queue_position, task_number").all() as Array<{ task_id: string }>;
    return {
        action: "MOVED",
        task: serializeTask(refreshedTask),
        waitingPosition: refreshedWaitingRows.findIndex((row) => row.task_id === task.task_id) + 1,
        titleUpdates,
        dependencies: readTaskDependencies(store, task.task_id)
    };
}

/**
 * Add or remove one explicit blocking dependency.
 * @param store Open project store.
 * @param task Current task row.
 * @param payload Dependency request payload.
 * @param shouldAdd Whether the dependency should be added.
 */
function applyDependencyEvent(store: IStore, task: ITaskRow, payload: IEventPayload, shouldAdd: boolean): Record<string, unknown> {
    assertCondition(task.state === "PLANNING" || task.state === "QUEUED", `Cannot change dependencies for ${task.task_id} from ${task.state}.`);
    const dependencyTaskId = validateTaskId(String(payload.dependencyTaskId || ""));
    assertCondition(dependencyTaskId !== task.task_id, "A task cannot depend on itself.");
    const dependencyTask = requireTask(store, dependencyTaskId);
    if (shouldAdd) {
        assertCondition(dependencyTask.state !== "CANCELED", `${dependencyTask.task_id} is canceled and cannot be used as a dependency.`);
        assertDependencyIsAcyclic(store, task.task_id, dependencyTaskId);
        const change = store.database.prepare("INSERT OR IGNORE INTO dependencies (task_id, depends_on_id, dependency_kind) VALUES (?, ?, 'BLOCKING')").run(task.task_id, dependencyTaskId);
        store.database.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        return {
            action: Number(change.changes) > 0 ? "DEPENDENCY_ADDED" : "DEPENDENCY_ALREADY_PRESENT",
            task: serializeTask(requireTask(store, task.task_id)),
            dependencyTaskId,
            dependencies: readTaskDependencies(store, task.task_id)
        };
    }
    const change = store.database.prepare("DELETE FROM dependencies WHERE task_id = ? AND depends_on_id = ? AND dependency_kind = 'BLOCKING'").run(task.task_id, dependencyTaskId);
    store.database.prepare("UPDATE tasks SET updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
    return {
        action: Number(change.changes) > 0 ? "DEPENDENCY_REMOVED" : "DEPENDENCY_ALREADY_ABSENT",
        task: serializeTask(requireTask(store, task.task_id)),
        dependencyTaskId,
        dependencies: readTaskDependencies(store, task.task_id)
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
    if (event.kind === "MOVE_REQUESTED") {
        return applyMoveEvent(store, task, payload);
    }
    if (event.kind === "DEPENDENCY_ADD_REQUESTED") {
        return applyDependencyEvent(store, task, payload, true);
    }
    if (event.kind === "DEPENDENCY_REMOVE_REQUESTED") {
        return applyDependencyEvent(store, task, payload, false);
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
    if (event.kind === "REWORK_REQUESTED") {
        if (task.state === "RUNNING") {
            return { action: "REWORK_ALREADY_STARTED", task: serializeTask(task), summary: payload.summary || null };
        }
        assertCondition(task.state === "REVIEW", `Cannot request rework for ${task.task_id} from ${task.state}.`);
        store.database.prepare("UPDATE tasks SET state = 'RUNNING', updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "REWORK_STARTED", task: serializeTask(refreshedTask), summary: payload.summary || null };
    }
    if (event.kind === "APPROVAL_REQUESTED") {
        if (task.state === "APPROVED" || task.state === "DONE") {
            const commitMessage = validateApprovalCommitMessage(task, payload.commitMessage);
            return { action: "APPROVAL_ALREADY_RECORDED", task: serializeTask(task), userRequestId: payload.userRequestId, commitMessage };
        }
        assertCondition(task.state === "REVIEW", `Cannot approve ${task.task_id} from ${task.state}.`);
        assertCondition(payload.userRequestId && payload.userRequestId.trim().length > 0, "Approval requires a direct user request ID.");
        const commitMessage = validateApprovalCommitMessage(task, payload.commitMessage);
        store.database.prepare("UPDATE tasks SET state = 'APPROVED', updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "APPROVED", task: serializeTask(refreshedTask), userRequestId: payload.userRequestId, commitMessage };
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
        const titleUpdates = writeQueueOrder(store, activeTaskIds);
        const refreshedTask = requireTask(store, task.task_id);
        return { action: "CANCELED", task: serializeTask(refreshedTask), titleUpdates, userRequestId: payload.userRequestId };
    }
    assertCondition(event.kind === "BLOCKED_REPORTED", `Unsupported event kind: ${event.kind}`);
    if (task.state === "BLOCKED") {
        return { action: "BLOCK_ALREADY_RECORDED", task: serializeTask(task), reason: payload.reason };
    }
    assertCondition(task.state === "QUEUED" || task.state === "RUNNING" || task.state === "REVIEW", `Cannot block ${task.task_id} from ${task.state}.`);
    assertCondition(payload.reason && payload.reason.trim().length > 0, "A blocked event requires a reason.");
    store.database.prepare("UPDATE tasks SET state = 'BLOCKED', blocked_from_state = ?, updated_at = ? WHERE task_id = ?").run(task.state, currentTimestamp(), task.task_id);
    const titleUpdates = task.state === "QUEUED" ? readQueuedTitleUpdates(store, task.queue_position || 1) : [];
    const refreshedTask = requireTask(store, task.task_id);
    return { action: "BLOCKED", task: serializeTask(refreshedTask), reason: payload.reason, titleUpdates };
}

/**
 * Process pending events serially through the deterministic engine.
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
        return { processedCount: results.length, controlRoomTitle: titleForControlRoom(), results };
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
        if (exclusiveTask) {
            const controlRoomTitle = titleForControlRoom();
            commitTransaction(store.database);
            return { activated: false, controlRoomTitle, reason: "ACTIVE_TASK_PRESENT", taskId: exclusiveTask.task_id, state: exclusiveTask.state };
        }
        const queuedTasks = store.database.prepare("SELECT * FROM tasks WHERE state = 'QUEUED' ORDER BY queue_position, task_number").all() as ITaskRow[];
        let selectedTask: ITaskRow | undefined;
        for (const queuedTask of queuedTasks) {
            if (dependenciesAreDone(store, queuedTask.task_id)) {
                selectedTask = queuedTask;
                break;
            }
        }
        if (!selectedTask) {
            const controlRoomTitle = titleForControlRoom();
            commitTransaction(store.database);
            return { activated: false, controlRoomTitle, reason: queuedTasks.length === 0 ? "QUEUE_EMPTY" : "DEPENDENCIES_PENDING" };
        }
        const workerBranch = workerBranchForTask(selectedTask.task_id);
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        const baseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        let currentBaseCommit: string | null;
        if (!baseCommit) {
            assertCondition(resolveCurrentHeadIfExists(store.projectRoot) === null, `Base branch ${project.base_branch} has no commits, but ${currentBranch || "the current branch"} has a commit.`);
            const previousTask = store.database.prepare(`
                SELECT task_id FROM tasks
                WHERE branch_name = ? AND state IN ('DONE', 'CANCELED')
                LIMIT 1
            `).get(currentBranch) as { task_id: string } | undefined;
            assertCondition(
                currentBranch === project.base_branch || currentBranch === workerBranch || previousTask,
                `ControlRoom requires unborn branch ${project.base_branch}; found ${currentBranch || "detached HEAD"}.`
            );
            const previousActivation = store.database.prepare("SELECT task_id FROM tasks WHERE branch_name IS NOT NULL LIMIT 1").get() as { task_id: string } | undefined;
            if (previousActivation) {
                assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "The shared Local working tree must be clean before activating another task.");
            }
            const existingWorkerBranch = runGit(store.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${workerBranch}`]);
            assertCondition(
                existingWorkerBranch.status === 1,
                existingWorkerBranch.status === 0 ?
                    `Worker branch already exists for ${selectedTask.task_id}: ${workerBranch}` :
                    `Inspect worker branch failed: ${existingWorkerBranch.stderr || existingWorkerBranch.stdout}`
            );
            requireGit(store.projectRoot, ["symbolic-ref", "HEAD", `refs/heads/${workerBranch}`], `Create unborn worker branch ${workerBranch}`);
            currentBaseCommit = null;
        } else if (currentBranch === project.base_branch) {
            assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "The shared Local working tree must be clean before activating a task.");
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
            assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "The shared Local working tree must be clean before activating a task.");
            assertCondition(currentBranch === workerBranch, `ControlRoom requires branch ${project.base_branch}; found ${currentBranch || "detached HEAD"}.`);
            currentBaseCommit = baseCommit;
            assertCondition(requireBranchCheckout(store.projectRoot, workerBranch) === currentBaseCommit, `Interrupted activation branch ${workerBranch} moved before state persistence.`);
        }
        store.database.prepare(`
            UPDATE tasks
            SET state = 'RUNNING', base_commit = ?, branch_name = ?, reviewed_commit = NULL, updated_at = ?
            WHERE task_id = ?
        `).run(currentBaseCommit, workerBranch, currentTimestamp(), selectedTask.task_id);
        const runningTask = requireTask(store, selectedTask.task_id);
        const titleUpdates = readQueuedTitleUpdates(store, selectedTask.queue_position || 1);
        const controlRoomTitle = titleForControlRoom();
        commitTransaction(store.database);
        return {
            activated: true,
            controlRoomTitle,
            task: serializeTask(runningTask),
            titleUpdates,
            executionBrief: {
                taskId: runningTask.task_id,
                threadId: runningTask.thread_id,
                semanticName: runningTask.semantic_name,
                projectRoot: store.projectRoot,
                baseCommit: runningTask.base_commit,
                baseBranch: project.base_branch,
                workerBranch: runningTask.branch_name,
                dependencies: readTaskDependencies(store, runningTask.task_id),
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
        const resumedQueuePosition = task.blocked_from_state === "QUEUED" ? task.queue_position || 1 : null;
        store.database.prepare("UPDATE tasks SET state = blocked_from_state, blocked_from_state = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
        const resumedTask = requireTask(store, task.task_id);
        const titleUpdates = resumedQueuePosition ? readQueuedTitleUpdates(store, resumedQueuePosition) : [];
        commitTransaction(store.database);
        return { resumed: true, task: serializeTask(resumedTask), titleUpdates };
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
 * Resolve the current commit or return null when HEAD is unborn.
 * @param projectRoot Canonical repository root used as working directory.
 */
function resolveCurrentHeadIfExists(projectRoot: string): string | null {
    const result = runGit(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    assertCondition(result.status === 0 || result.status === 1, `Resolve current head failed: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`);
    return result.status === 0 ? validateCommitId(result.stdout) : null;
}

/**
 * Resolve a local branch commit or return null when the branch is unborn or absent.
 * @param projectRoot Canonical repository root used as working directory.
 * @param branchName Local branch name without a refs prefix.
 */
function resolveLocalBranchHeadIfExists(projectRoot: string, branchName: string): string | null {
    const validBranchName = validateBranchName(branchName);
    const branchResult = runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${validBranchName}`]);
    assertCondition(branchResult.status === 0 || branchResult.status === 1, `Inspect local branch ${validBranchName} failed: ${branchResult.stderr || branchResult.stdout || `exit ${String(branchResult.status)}`}`);
    return branchResult.status === 0 ? resolveLocalBranchHead(projectRoot, validBranchName) : null;
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
 * Determine whether a commit has exactly the expected parent, including a root commit.
 * @param projectRoot Canonical repository root used as working directory.
 * @param commitId Commit whose parent list should be inspected.
 * @param expectedParentCommit Expected sole parent, or null for a root commit.
 */
function commitHasExpectedParent(projectRoot: string, commitId: string, expectedParentCommit: string | null): boolean {
    const validCommitId = validateCommitId(commitId);
    const parentsResult = runGit(projectRoot, ["rev-list", "--parents", "--max-count=1", validCommitId]);
    if (parentsResult.status !== 0) {
        return false;
    }
    const commitParts = parentsResult.stdout.split(/\s+/u);
    if (commitParts[0] !== validCommitId) {
        return false;
    }
    if (expectedParentCommit === null) {
        return commitParts.length === 1;
    }
    return commitParts.length === 2 && commitParts[1] === validateCommitId(expectedParentCommit);
}

/**
 * Determine whether a commit is the single approval commit expected after a recorded parent.
 * @param projectRoot Canonical repository root used as working directory.
 * @param commitId Candidate approval commit.
 * @param parentCommitId Recorded pre-approval parent commit, or null for an unborn repository.
 * @param expectedSubject Expected approval commit subject.
 */
function commitMatchesApproval(projectRoot: string, commitId: string, parentCommitId: string | null, expectedSubject: string): boolean {
    if (parentCommitId && commitId === parentCommitId) {
        return false;
    }
    if (!commitHasExpectedParent(projectRoot, commitId, parentCommitId)) {
        return false;
    }
    const subjectResult = runGit(projectRoot, ["log", "-1", "--format=%s", commitId]);
    return subjectResult.status === 0 && subjectResult.stdout === expectedSubject;
}

/**
 * Create the first base branch ref at an approved commit.
 * @param projectRoot Canonical repository root used as working directory.
 * @param baseBranch Configured base branch.
 * @param commitId Approved commit used as the initial base tip.
 */
function createInitialBaseBranch(projectRoot: string, baseBranch: string, commitId: string): void {
    const validBaseBranch = validateBranchName(baseBranch);
    const validCommitId = validateCommitId(commitId);
    assertCondition(resolveLocalBranchHeadIfExists(projectRoot, validBaseBranch) === null, `Base branch ${validBaseBranch} was created concurrently.`);
    requireGit(projectRoot, ["branch", validBaseBranch, validCommitId], `Create initial base branch ${validBaseBranch}`);
}

/**
 * Read the first meaningful commit subject accepted for a task.
 * @param store Open project store.
 * @param task Approved task whose commit subject is required.
 */
function readApprovalCommitMessage(store: IStore, task: ITaskRow): string {
    const approvalEvents = store.database.prepare(`
        SELECT payload_json, result_json
        FROM events
        WHERE task_id = ? AND kind = 'APPROVAL_REQUESTED' AND processed_at IS NOT NULL
        ORDER BY sequence
    `).all(task.task_id) as Array<{ payload_json: string; result_json: string | null }>;
    for (const approvalEvent of approvalEvents) {
        if (!approvalEvent.result_json) {
            continue;
        }
        const approvalResult = JSON.parse(approvalEvent.result_json) as { action?: string };
        if (approvalResult.action !== "APPROVED" && approvalResult.action !== "APPROVAL_ALREADY_RECORDED") {
            continue;
        }
        const approvalPayload = JSON.parse(approvalEvent.payload_json) as IEventPayload;
        if (approvalPayload.commitMessage !== undefined) {
            return validateApprovalCommitMessage(task, approvalPayload.commitMessage);
        }
    }
    throw new Error(`${task.task_id} has no successful approval event with a commit message.`);
}

/**
 * Compact active queue positions after a terminal transition.
 * @param store Open project store.
 */
function compactActiveQueue(store: IStore): ITitleUpdate[] {
    const rows = store.database.prepare(`
        SELECT task_id FROM tasks
        WHERE state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
        ORDER BY queue_position IS NULL, queue_position, task_number
    `).all() as Array<{ task_id: string }>;
    const taskIds: string[] = [];
    for (const row of rows) {
        taskIds.push(row.task_id);
    }
    return writeQueueOrder(store, taskIds);
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
        const titleUpdates = compactActiveQueue(store);
        const completedTask = requireTask(store, task.task_id);
        commitTransaction(store.database);
        return { committed: true, merged, branchDeleted, controlRoomTitle: titleForControlRoom(), gitMode: GIT_MODE, task: serializeTask(completedTask), titleUpdates };
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
                controlRoomTitle: titleForControlRoom(),
                gitMode: GIT_MODE,
                task: serializeTask(task)
            };
        }
        assertCondition(task.state === "APPROVED", `Cannot commit ${task.task_id} from ${task.state}.`);
        assertCondition(!project.integration_task_id, `Commit lease is already held by ${project.integration_task_id}; use recover-commit only after confirming the prior process ended.`);
        const workingTreeStatus = readWorkingTreeStatus(store.projectRoot);
        if (workingTreeStatus.length === 0) {
            store.database.prepare("UPDATE tasks SET state = 'DONE', queue_position = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
            const titleUpdates = compactActiveQueue(store);
            const completedTask = requireTask(store, task.task_id);
            commitTransaction(store.database);
            return {
                committed: false,
                dequeued: true,
                noUncommittedChanges: true,
                controlRoomTitle: titleForControlRoom(),
                gitMode: GIT_MODE,
                task: serializeTask(completedTask),
                titleUpdates
            };
        }
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
        const commitsOnBase = currentBranch === project.base_branch;
        assertCondition(commitsOnBase || currentBranch === task.branch_name, `Cannot commit ${task.task_id} from unrelated branch ${currentBranch || "detached HEAD"}.`);
        const commitMessage = readApprovalCommitMessage(store, task);
        const currentHead = resolveCurrentHeadIfExists(store.projectRoot);
        const timestamp = currentTimestamp();
        store.database.prepare("UPDATE tasks SET reviewed_commit = ?, updated_at = ? WHERE task_id = ?").run(currentHead, timestamp, task.task_id);
        store.database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ?, updated_at = ? WHERE project_key = ?").run(task.task_id, timestamp, timestamp, store.projectKey);
        commitTransaction(store.database);
        leaseAcquired = true;

        requireGit(store.projectRoot, ["add", "-A", "--", "."], "Stage approved changes");
        const stagedDifference = currentHead ?
            runGit(store.projectRoot, ["diff", "--cached", "--quiet", "HEAD", "--"]) :
            runGit(store.projectRoot, ["diff", "--cached", "--quiet", "--"]);
        assertCondition(stagedDifference.status === 1, stagedDifference.status === 0 ? "Approval produced no staged changes." : `Inspect staged changes failed: ${stagedDifference.stderr || stagedDifference.stdout}`);
        requireGit(store.projectRoot, ["commit", "--message", commitMessage], "Commit approved changes");
        const committedCommit = validateCommitId(requireGit(store.projectRoot, ["rev-parse", "HEAD"], "Resolve approved commit"));
        assertCondition(commitHasExpectedParent(store.projectRoot, committedCommit, currentHead), currentHead ?
            `Approved commit does not have expected parent ${currentHead}.` :
            "Approved initial commit is not a root commit.");
        if (commitsOnBase) {
            return finalizeApprovedCommit(store, task.task_id, committedCommit, false, false);
        }
        assertCondition(task.branch_name, `${task.task_id} has no worker branch.`);
        if (resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch) === null) {
            createInitialBaseBranch(store.projectRoot, project.base_branch, committedCommit);
            requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out initial base branch ${project.base_branch}`);
            assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === committedCommit, `${project.base_branch} did not reach initial approved commit ${committedCommit}.`);
            requireGit(store.projectRoot, ["branch", "--delete", task.branch_name], `Delete worker branch ${task.branch_name}`);
            return finalizeApprovedCommit(store, task.task_id, committedCommit, true, true);
        }
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
                controlRoomTitle: titleForControlRoom(),
                task: serializeTask(task)
            };
        }
        assertCondition(project.integration_task_id === task.task_id, `${task.task_id} does not hold the commit lease.`);
        const hasRecoverableAnchor = Boolean(task.base_commit && task.reviewed_commit) || task.base_commit === null;
        assertCondition(task.state === "APPROVED" && hasRecoverableAnchor, `${task.task_id} does not have a recoverable approval.`);
        const workerBranchResult = task.branch_name ?
            runGit(store.projectRoot, ["rev-parse", "--verify", `refs/heads/${task.branch_name}^{commit}`]) :
            { status: 128, stdout: "", stderr: "" };
        assertCondition(workerBranchResult.status === 0 || workerBranchResult.status === 128, `Resolve worker branch ${String(task.branch_name)} failed: ${workerBranchResult.stderr || workerBranchResult.stdout}`);
        const workerCommit = workerBranchResult.status === 0 ? validateCommitId(workerBranchResult.stdout) : null;
        const currentBaseCommit = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
        const expectedSubject = readApprovalCommitMessage(store, task);
        const workerCommitIsApproval = Boolean(workerCommit && commitMatchesApproval(store.projectRoot, workerCommit, task.reviewed_commit, expectedSubject));
        const baseCommitIsApproval = Boolean(currentBaseCommit && commitMatchesApproval(store.projectRoot, currentBaseCommit, task.reviewed_commit, expectedSubject));
        const noCommitWasCreated = task.reviewed_commit === null ?
            workerCommit === null && currentBaseCommit === null :
            workerCommit === task.reviewed_commit || currentBaseCommit === task.reviewed_commit;
        if (!workerCommitIsApproval && !baseCommitIsApproval && noCommitWasCreated) {
            const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve current branch");
            assertCondition(currentBranch === project.base_branch || currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
            beginTransaction(store.database);
            const lockedProject = requireProject(store);
            assertCondition(lockedProject.integration_task_id === task.task_id, `Commit lease for ${task.task_id} changed during recovery.`);
            store.database.prepare("UPDATE tasks SET reviewed_commit = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
            store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
            const retryTask = requireTask(store, task.task_id);
            commitTransaction(store.database);
            return { recovered: true, finalized: false, retryCommit: true, controlRoomTitle: titleForControlRoom(), task: serializeTask(retryTask) };
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
        if (!currentBaseCommit) {
            assertCondition(task.base_commit === null, `Configured base branch ${project.base_branch} disappeared after activation.`);
            assertCondition(currentBranch === task.branch_name, `Recovery found unexpected branch ${currentBranch || "detached HEAD"}.`);
            createInitialBaseBranch(store.projectRoot, project.base_branch, approvedCommit);
            requireGit(store.projectRoot, ["checkout", project.base_branch], `Check out initial base branch ${project.base_branch}`);
            assertCondition(requireBaseCheckout(store.projectRoot, project.base_branch) === approvedCommit, `${project.base_branch} did not reach recovered initial commit ${approvedCommit}.`);
            requireGit(store.projectRoot, ["branch", "--delete", task.branch_name], `Delete recovered worker branch ${task.branch_name}`);
            const result = finalizeApprovedCommit(store, task.task_id, approvedCommit, true, true);
            return { ...result, recovered: true, finalized: true };
        }
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
 * Read the project snapshot, one task, or the role of one Codex thread without changing state.
 * @param options Project and optional state-root settings.
 * @param taskId Optional task identifier to select.
 * @param threadId Optional Codex thread identifier to resolve.
 */
function getStatus(options: IControlRoomOptions, taskId?: string, threadId?: string): Record<string, unknown> {
    assertCondition(!(taskId && threadId), "Status accepts either a task ID or a thread ID, not both.");
    const validThreadId = threadId ? validateThreadId(threadId) : null;
    const store = openStore(options);
    try {
        const project = requireProject(store);
        if (taskId) {
            return { projectRoot: store.projectRoot, controlRoomTitle: titleForControlRoom(), task: serializeTask(requireTask(store, taskId)) };
        }
        if (validThreadId) {
            if (validThreadId === project.coordinator_thread_id) {
                return { projectRoot: store.projectRoot, controlRoomTitle: titleForControlRoom(), controlRoomThreadId: project.coordinator_thread_id, role: "CONTROL_ROOM", task: null };
            }
            const task = store.database.prepare(`${TASK_WITH_QUEUED_POSITION_SELECT} WHERE task.thread_id = ?`).get(validThreadId) as ITaskRow | undefined;
            return {
                projectRoot: store.projectRoot,
                controlRoomTitle: titleForControlRoom(),
                controlRoomThreadId: project.coordinator_thread_id,
                role: task ? "WORKER" : "UNREGISTERED",
                task: task ? serializeTask(task) : null
            };
        }
        const counts = store.database.prepare("SELECT state, COUNT(*) AS count FROM tasks GROUP BY state ORDER BY state").all() as Array<{ state: TaskState; count: number }>;
        const stateCounts: Record<string, number> = {};
        for (const countRow of counts) {
            stateCounts[countRow.state] = Number(countRow.count);
        }
        return {
            projectRoot: store.projectRoot,
            controlRoomTitle: titleForControlRoom(),
            controlRoomThreadId: project.coordinator_thread_id,
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
            ${TASK_WITH_QUEUED_POSITION_SELECT}
            WHERE task.state IN ('QUEUED', 'RUNNING', 'REVIEW', 'APPROVED', 'BLOCKED')
            ORDER BY task.queue_position IS NULL, task.queue_position, task.task_number
        `).all() as ITaskRow[];
        const queue: Record<string, unknown>[] = [];
        for (const task of tasks) {
            queue.push({ ...serializeTask(task), dependencies: readTaskDependencies(store, task.task_id) });
        }
        return { projectRoot: store.projectRoot, controlRoomTitle: titleForControlRoom(), queue };
    } finally {
        store.database.close();
    }
}

/**
 * Add one serialized task title to a deduplicated settlement update map.
 * @param updates Title updates keyed by Codex thread ID.
 * @param task Serialized task candidate.
 */
function addSettlementTitleUpdate(updates: Map<string, ITitleUpdate>, task: unknown): void {
    if (!task || typeof task !== "object") {
        return;
    }
    const candidate = task as Record<string, unknown>;
    if (typeof candidate.taskId !== "string" || typeof candidate.threadId !== "string" || typeof candidate.title !== "string") {
        return;
    }
    updates.set(candidate.threadId, {
        taskId: candidate.taskId,
        threadId: candidate.threadId,
        title: candidate.title
    });
}

/**
 * Collect every final title that the caller must apply after settlement.
 * @param processed Processed event batch.
 * @param queue Final active queue snapshot.
 * @param completion Optional approval completion result.
 */
function collectSettlementTitleUpdates(processed: Record<string, unknown>, queue: Record<string, unknown>[], completion: Record<string, unknown> | null): ITitleUpdate[] {
    const updates = new Map<string, ITitleUpdate>();
    const results = Array.isArray(processed.results) ? processed.results : [];
    for (const result of results) {
        if (result && typeof result === "object") {
            addSettlementTitleUpdate(updates, (result as Record<string, unknown>).task);
        }
    }
    for (const task of queue) {
        addSettlementTitleUpdate(updates, task);
    }
    if (completion) {
        addSettlementTitleUpdate(updates, completion.task);
    }
    return Array.from(updates.values());
}

/**
 * Process pending events, complete an approved task, and activate the next eligible task.
 * @param options Project and optional state-root settings.
 */
function settleProject(options: IControlRoomOptions): Record<string, unknown> {
    const processed = processPendingEvents(options);
    let status = getStatus(options);
    if (status.commitTaskId) {
        const queue = getQueue(options);
        const activeQueue = queue.queue as Record<string, unknown>[];
        return {
            settled: false,
            reason: "COMMIT_RECOVERY_REQUIRED",
            commitTaskId: status.commitTaskId,
            controlRoomTitle: titleForControlRoom(),
            processed,
            completion: null,
            activation: null,
            queue: activeQueue,
            titleUpdates: collectSettlementTitleUpdates(processed, activeQueue, null)
        };
    }
    const stateCounts = status.stateCounts as Record<string, number>;
    let completion: Record<string, unknown> | null = null;
    if (Number(stateCounts.APPROVED || 0) > 0) {
        const activeQueue = getQueue(options).queue as Record<string, unknown>[];
        const approvedTasks = activeQueue.filter((task) => task.state === "APPROVED");
        assertCondition(approvedTasks.length === 1, "ControlRoom requires exactly one approved task before settlement.");
        completion = commitApprovedTask(options, String(approvedTasks[0].taskId));
        status = getStatus(options);
    }
    let activation: Record<string, unknown>;
    if (status.commitTaskId) {
        activation = { activated: false, reason: "COMMIT_RECOVERY_REQUIRED", commitTaskId: status.commitTaskId };
    } else {
        activation = activateNextTask(options);
    }
    const queue = getQueue(options);
    const activeQueue = queue.queue as Record<string, unknown>[];
    return {
        settled: !status.commitTaskId,
        controlRoomTitle: titleForControlRoom(),
        processed,
        completion,
        activation,
        queue: activeQueue,
        titleUpdates: collectSettlementTitleUpdates(processed, activeQueue, completion)
    };
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
    settleProject,
    submitEvent,
    titleForControlRoom,
    titleForTask
};
