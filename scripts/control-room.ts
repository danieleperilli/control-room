#!/usr/bin/env node

interface IParsedArguments {
    command: string;
    values: Record<string, string>;
}

const USER_COMMANDS = [
    "$control-room init",
    "$control-room join",
    "$control-room queue",
    "$control-room help",
    "Enqueue [after T0002]",
    "Move first | Move to 3 | Move before T0002 | Move after T0002",
    "Depends on T0002 | Remove dependency T0002",
    "Approve | Cancel | Status | Queue status"
];

/**
 * Parse one command and `--name value` options without interpreting shell text.
 * @param argumentsList Process arguments after the Node executable and script path.
 */
function parseArguments(argumentsList: string[]): IParsedArguments {
    const command = argumentsList[0] || "";
    const values: Record<string, string> = {};
    for (let index = 1; index < argumentsList.length; index += 1) {
        const optionName = argumentsList[index];
        if (!optionName.startsWith("--")) {
            throw new Error(`Unexpected argument: ${optionName}`);
        }
        const optionValue = argumentsList[index + 1];
        if (!optionValue || optionValue.startsWith("--")) {
            throw new Error(`Missing value for ${optionName}`);
        }
        const key = optionName.slice(2);
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            throw new Error(`Duplicate option: ${optionName}`);
        }
        values[key] = optionValue;
        index += 1;
    }
    return { command, values };
}

/**
 * Require a named CLI option.
 * @param values Parsed CLI option map.
 * @param name Option name without leading hyphens.
 */
function requireOption(values: Record<string, string>, name: string): string {
    const value = values[name];
    if (!value) {
        throw new Error(`Missing required option: --${name}`);
    }
    return value;
}

/**
 * Build the shared project options for core operations.
 * @param values Parsed CLI option map.
 */
function buildOptions(values: Record<string, string>): { projectRoot: string; stateRoot?: string } {
    const options: { projectRoot: string; stateRoot?: string } = {
        projectRoot: requireOption(values, "project-root")
    };
    if (values["state-root"]) {
        options.stateRoot = values["state-root"];
    }
    return options;
}

/**
 * Reject CLI options that the selected command does not support.
 * @param values Parsed CLI option map.
 * @param allowedNames Allowed option names without leading hyphens.
 */
function validateOptions(values: Record<string, string>, allowedNames: string[]): void {
    for (const optionName of Object.keys(values)) {
        if (!allowedNames.includes(optionName)) {
            throw new Error(`Unknown option for this command: --${optionName}`);
        }
    }
}

/**
 * Parse a one-based queue position without accepting partial numeric text.
 * @param value CLI position text.
 */
function parseQueuePosition(value: string): number {
    if (!/^[1-9]\d{0,3}$/u.test(value)) {
        throw new Error("Queue position must be an integer between 1 and 9999.");
    }
    return Number(value);
}

/**
 * Print concise command usage.
 */
function printHelp(): void {
    process.stdout.write(`ControlRoom CLI

User commands:
${USER_COMMANDS.map((command) => `  ${command}`).join("\n")}

Commands:
  init --project-root ROOT --coordinator-thread ID --base-branch BRANCH [--state-root PATH]
  register --project-root ROOT --thread-id ID --name NAME [--state-root PATH]
  request-enqueue --project-root ROOT --task T0001 --event-key KEY [--after T0002] [--state-root PATH]
  request-move --project-root ROOT --task T0001 --event-key KEY (--position N | --before T0002 | --after T0002) [--state-root PATH]
  request-dependency-add --project-root ROOT --task T0001 --event-key KEY --depends-on T0002 [--state-root PATH]
  request-dependency-remove --project-root ROOT --task T0001 --event-key KEY --depends-on T0002 [--state-root PATH]
  request-review --project-root ROOT --task T0001 --event-key KEY [--summary TEXT] [--state-root PATH]
  request-approve --project-root ROOT --task T0001 --event-key KEY --user-request-id ID [--state-root PATH]
  request-cancel --project-root ROOT --task T0001 --event-key KEY --user-request-id ID [--state-root PATH]
  request-block --project-root ROOT --task T0001 --event-key KEY --reason TEXT [--state-root PATH]
  process --project-root ROOT [--state-root PATH]
  activate-next --project-root ROOT [--state-root PATH]
  recover-commit --project-root ROOT --task T0001 [--state-root PATH]
  resume --project-root ROOT --task T0001 [--state-root PATH]
  commit-approved --project-root ROOT --task T0001 [--state-root PATH]
  status --project-root ROOT [--task T0001] [--state-root PATH]
  queue --project-root ROOT [--state-root PATH]
`);
}

/**
 * Dispatch the parsed command to the deterministic core.
 * @param parsed Parsed command and options.
 */
function executeCommand(parsed: IParsedArguments): Record<string, unknown> | null {
    const values = parsed.values;
    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h" || parsed.command === "") {
        printHelp();
        return null;
    }
    const core = require("./control-room-core.ts");
    if (parsed.command === "init") {
        validateOptions(values, ["project-root", "coordinator-thread", "base-branch", "state-root"]);
        return {
            ...core.initializeProject(buildOptions(values), requireOption(values, "coordinator-thread"), requireOption(values, "base-branch")),
            userCommands: USER_COMMANDS
        };
    }
    if (parsed.command === "register") {
        validateOptions(values, ["project-root", "thread-id", "name", "state-root"]);
        return core.registerTask(buildOptions(values), requireOption(values, "thread-id"), requireOption(values, "name"));
    }
    if (parsed.command === "request-enqueue") {
        validateOptions(values, ["project-root", "task", "event-key", "after", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "ENQUEUE_REQUESTED", {
            afterTaskId: values.after
        });
    }
    if (parsed.command === "request-move") {
        validateOptions(values, ["project-root", "task", "event-key", "position", "before", "after", "state-root"]);
        const selectorCount = Number(Boolean(values.position)) + Number(Boolean(values.before)) + Number(Boolean(values.after));
        if (selectorCount !== 1) {
            throw new Error("request-move requires exactly one of --position, --before, or --after.");
        }
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "MOVE_REQUESTED", {
            afterTaskId: values.after,
            beforeTaskId: values.before,
            position: values.position ? parseQueuePosition(values.position) : undefined
        });
    }
    if (parsed.command === "request-dependency-add") {
        validateOptions(values, ["project-root", "task", "event-key", "depends-on", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "DEPENDENCY_ADD_REQUESTED", {
            dependencyTaskId: requireOption(values, "depends-on")
        });
    }
    if (parsed.command === "request-dependency-remove") {
        validateOptions(values, ["project-root", "task", "event-key", "depends-on", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "DEPENDENCY_REMOVE_REQUESTED", {
            dependencyTaskId: requireOption(values, "depends-on")
        });
    }
    if (parsed.command === "request-review") {
        validateOptions(values, ["project-root", "task", "event-key", "summary", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "REVIEW_REQUESTED", {
            summary: values.summary
        });
    }
    if (parsed.command === "request-approve") {
        validateOptions(values, ["project-root", "task", "event-key", "user-request-id", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "APPROVAL_REQUESTED", {
            userRequestId: requireOption(values, "user-request-id")
        });
    }
    if (parsed.command === "request-cancel") {
        validateOptions(values, ["project-root", "task", "event-key", "user-request-id", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "CANCEL_REQUESTED", {
            userRequestId: requireOption(values, "user-request-id")
        });
    }
    if (parsed.command === "request-block") {
        validateOptions(values, ["project-root", "task", "event-key", "reason", "state-root"]);
        return core.submitEvent(buildOptions(values), requireOption(values, "event-key"), requireOption(values, "task"), "BLOCKED_REPORTED", {
            reason: requireOption(values, "reason")
        });
    }
    if (parsed.command === "process") {
        validateOptions(values, ["project-root", "state-root"]);
        return core.processPendingEvents(buildOptions(values));
    }
    if (parsed.command === "activate-next") {
        validateOptions(values, ["project-root", "state-root"]);
        return core.activateNextTask(buildOptions(values));
    }
    if (parsed.command === "recover-commit") {
        validateOptions(values, ["project-root", "task", "state-root"]);
        return core.recoverCommit(buildOptions(values), requireOption(values, "task"));
    }
    if (parsed.command === "resume") {
        validateOptions(values, ["project-root", "task", "state-root"]);
        return core.resumeTask(buildOptions(values), requireOption(values, "task"));
    }
    if (parsed.command === "commit-approved") {
        validateOptions(values, ["project-root", "task", "state-root"]);
        return core.commitApprovedTask(buildOptions(values), requireOption(values, "task"));
    }
    if (parsed.command === "status") {
        validateOptions(values, ["project-root", "task", "state-root"]);
        return core.getStatus(buildOptions(values), values.task);
    }
    if (parsed.command === "queue") {
        validateOptions(values, ["project-root", "state-root"]);
        return core.getQueue(buildOptions(values));
    }
    throw new Error(`Unknown command: ${parsed.command}`);
}

/**
 * Run the CLI and emit one JSON result or one concise error.
 */
function main(): void {
    try {
        const parsed = parseArguments(process.argv.slice(2));
        const result = executeCommand(parsed);
        if (result) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`ControlRoom error: ${message}\n`);
        process.exitCode = 1;
    }
}

main();
