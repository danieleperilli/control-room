const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const [projectRoot, codexHome, source, checkpoint] = process.argv.slice(2);
process.env.CODEX_HOME = codexHome;
if (checkpoint === "wal-crash") {
    const { DatabaseSync }: typeof import("node:sqlite") = require("node:sqlite");
    const database = new DatabaseSync(source);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    database.prepare("UPDATE tasks SET semantic_name = ? WHERE task_id = 'T0001'").run("Committed WAL update");
    process.kill(process.pid, "SIGKILL");
}
const destination = path.join(projectRoot, ".control-room", "state.sqlite");
const originalRename = fs.renameSync;
const originalUnlink = fs.unlinkSync;

/** Interrupt publication or simulate a transfer between filesystems. @param from Source path. @param to Destination path. */
fs.renameSync = (from, to) => {
    if (String(from) === source && String(to) === destination) {
        if (checkpoint === "before-publish") {
            process.kill(process.pid, "SIGKILL");
        }
        if (checkpoint === "cross-device" || checkpoint === "before-source-removal") {
            throw Object.assign(new Error("Cross-device fixture"), { code: "EXDEV" });
        }
    }
    originalRename(from, to);
    if (String(to) === destination && checkpoint === "after-publish") {
        process.kill(process.pid, "SIGKILL");
    }
};

/** Interrupt cleanup after a cross-device copy was published. @param target File to remove. */
fs.unlinkSync = (target) => {
    if (String(target) === source && checkpoint === "before-source-removal") {
        process.kill(process.pid, "SIGKILL");
    }
    originalUnlink(target);
};

const core: import("../../scripts/control-room-core.ts").IControlRoomApi = require("../../scripts/control-room-core.ts");
core.installProjectRouting({ projectRoot });
