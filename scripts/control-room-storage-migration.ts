import type { IStoreLocation } from "./control-room-types.ts";
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const crypto: typeof import("node:crypto") = require("node:crypto");
const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
const { ensurePrivateDirectory, pathIsSymbolicLink, readMigrationDigest, CURRENT_SCHEMA_VERSION }: import("./control-room-storage.ts").IStorageApi = require("./control-room-storage.ts");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;

/**
 * Flush a completed file or its containing directory before advancing migration.
 * @param targetPath File or directory whose changes must be durable.
 */
function syncPath(targetPath: string): void {
    const descriptor = fs.openSync(targetPath, "r");
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

/**
 * Relocate legacy state with a durable receipt, preserving interrupted transfers.
 * @param location Validated local and legacy paths for the canonical project.
 */
function migrateProjectStore(location: IStoreLocation): void {
    const source = location.legacyDatabasePath!;
    const destination = location.databasePath;
    const directory = path.dirname(destination);
    const receiptPath = path.join(directory, "state-migration.json");
    const temporaryPath = path.join(directory, "state.sqlite.migrating");
    const receiptTemporaryPath = `${receiptPath}.tmp`;
    assertCondition(!pathIsSymbolicLink(receiptPath), `Migration receipt cannot be a symbolic link: ${receiptPath}`);
    if (!fs.existsSync(source) && !fs.existsSync(receiptPath)) {
        return;
    }
    ensurePrivateDirectory(directory);
    const lockPath = path.join(directory, ".state-migration-lock");
    for (const target of [lockPath, `${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`]) {
        assertCondition(!pathIsSymbolicLink(target), `Migration lock cannot be a symbolic link: ${target}`);
        assertCondition(!fs.existsSync(target) || fs.lstatSync(target).isFile(), `Migration lock is not a regular file: ${target}`);
    }
    // Keep the lock inode: deleting it would let waiting processes lock different files.
    const lock = new DatabaseSync(lockPath);
    try {
        fs.chmodSync(lockPath, 0o600);
        lock.exec("PRAGMA busy_timeout = 5000; BEGIN EXCLUSIVE");
        for (const target of [receiptPath, temporaryPath, receiptTemporaryPath]) {
            assertCondition(!pathIsSymbolicLink(target), `Migration file cannot be a symbolic link: ${target}`);
            assertCondition(!fs.existsSync(target) || fs.lstatSync(target).isFile(), `Migration path is not a regular file: ${target}`);
        }
        if (!fs.existsSync(source) && !fs.existsSync(receiptPath)) {
            return;
        }
        let digest = readMigrationDigest(location);
        assertCondition(!fs.existsSync(source) || !fs.existsSync(destination) || digest !== undefined, "Both local and legacy ControlRoom databases exist; preserve both and resolve the storage conflict before continuing.");
        const { installWorktreeIgnoreAtRoot }: import("./control-room-core.ts").IControlRoomApi = require("./control-room-core.ts");
        installWorktreeIgnoreAtRoot(location.projectRoot);
        if (fs.existsSync(source)) {
            const deadline = Date.now() + 5000;
            while (true) {
                const database = new DatabaseSync(source);
                try {
                    database.exec("PRAGMA busy_timeout = 5000");
                    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
                    assertCondition(version >= 0 && version <= CURRENT_SCHEMA_VERSION, `Unsupported Control Room schema version: ${version}`);
                    const projectTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
                    if (projectTable) {
                        const projects = database.prepare("SELECT project_key, project_root FROM projects").all();
                        assertCondition(projects.length <= 1 && projects.every((project) => project.project_key === location.projectKey && project.project_root === location.projectRoot), "Legacy database does not belong to this canonical project root.");
                    }
                    const integrity = database.prepare("PRAGMA quick_check").all();
                    assertCondition(integrity.length === 1 && integrity[0].quick_check === "ok", "Legacy ControlRoom database failed its integrity check; the original has been preserved.");
                    // DELETE mode checkpoints WAL and refuses the switch while other WAL connections remain open.
                    database.exec("PRAGMA locking_mode = EXCLUSIVE");
                    const journal = database.prepare("PRAGMA journal_mode = DELETE").get();
                    assertCondition(journal?.journal_mode === "delete", "Legacy ControlRoom database is busy; retry migration after its current commands finish.");
                    database.exec("BEGIN EXCLUSIVE; COMMIT");
                    break;
                } catch (error) {
                    if (!error || typeof error !== "object" || !("errcode" in error) || (Number(error.errcode) & 0xff) !== 5 || Date.now() >= deadline) {
                        throw error;
                    }
                } finally {
                    database.close();
                }
                // Release the source connection before retrying a journal-mode lock upgrade.
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            }
        }
        if (digest === undefined) {
            digest = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
            fs.writeFileSync(receiptTemporaryPath, JSON.stringify({ source, sha256: digest }), { mode: 0o600 });
            syncPath(receiptTemporaryPath);
            fs.renameSync(receiptTemporaryPath, receiptPath);
            syncPath(directory);
        }
        // No store opens the destination for writing until source removal has completed.
        assertCondition(fs.existsSync(source) || fs.existsSync(destination), "Interrupted ControlRoom migration is missing both databases; preserve the receipt for recovery.");
        for (const candidate of [source, destination]) {
            if (fs.existsSync(candidate)) {
                const actual = crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
                assertCondition(actual === digest, `ControlRoom database changed during migration; preserve both locations for recovery: ${candidate}`);
            }
        }
        if (!fs.existsSync(destination)) {
            try {
                fs.renameSync(source, destination);
            } catch (error) {
                if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EXDEV") {
                    throw error;
                }
                // A partial cross-device copy is disposable while the original and receipt remain intact.
                fs.rmSync(temporaryPath, { force: true });
                fs.copyFileSync(source, temporaryPath, fs.constants.COPYFILE_EXCL);
                syncPath(temporaryPath);
                assertCondition(crypto.createHash("sha256").update(fs.readFileSync(temporaryPath)).digest("hex") === digest, "Copied ControlRoom database failed verification; the original has been preserved.");
                fs.renameSync(temporaryPath, destination);
            }
        }
        fs.chmodSync(destination, 0o600);
        syncPath(destination);
        syncPath(directory);
        if (fs.existsSync(source)) {
            fs.unlinkSync(source);
        }
        syncPath(path.dirname(source));
        fs.unlinkSync(receiptPath);
        syncPath(directory);
    } finally {
        lock.close();
    }
}

const api = { migrateProjectStore };
module.exports = api;
export interface IStorageMigrationApi extends Readonly<typeof api> {}
