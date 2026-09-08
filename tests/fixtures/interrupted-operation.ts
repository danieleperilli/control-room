const childProcess: typeof import("node:child_process") = require("node:child_process");
const core: import("../../scripts/control-room-core.ts").IControlRoomApi = require("../../scripts/control-room-core.ts");
const [projectRoot, stateRoot, taskId, operation, gitArgumentsJson] = process.argv.slice(2);
const expectedArguments = JSON.parse(gitArgumentsJson) as string[];
const originalSpawn = childProcess.spawnSync;

/**
 * Terminate this fixture after the exact Git operation succeeds, before SQLite can finalize.
 * @param command Executable name.
 * @param args Process arguments.
 * @param options Process options.
 */
const interruptedSpawn = (command: string, args: readonly string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => {
    const result = originalSpawn(command, args, options);
    if (command === "git" && JSON.stringify(args.slice(0, expectedArguments.length)) === JSON.stringify(expectedArguments) && result.status === 0) {
        process.kill(process.pid, "SIGKILL");
    }
    return result;
};

// Only this disposable child process replaces the Git runner; production has no failure switches.
childProcess.spawnSync = interruptedSpawn as typeof childProcess.spawnSync;
if (operation === "activate") {
    core.activateNextTask({ projectRoot, stateRoot });
} else {
    core.commitApprovedTask({ projectRoot, stateRoot }, taskId);
}
throw new Error("The requested interruption point was not reached.");
