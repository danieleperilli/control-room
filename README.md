# ControlRoom

ControlRoom coordinates multiple top-level Codex tasks inside a Git project. It keeps planning, implementation, review, approval, dependencies, and local commits in a predictable queue while each change remains in its own dedicated task.

## What it does

- Assigns project-scoped task IDs such as `T0001`.
- Automatically registers new substantive Local tasks after project initialization.
- Persistently excludes `brand-forge` tasks and tasks with an explicit opt-out directive.
- Keeps planned work separate from active implementation.
- Queues tasks in a deterministic order with optional dependencies.
- Runs tasks serially in the shared checkout by default, with explicit concurrent isolation when requested.
- Leaves changes uncommitted during implementation and review.
- Creates a worker branch only when a queued task starts running.
- Creates a commit only after direct user approval and only when uncommitted changes exist.
- Can approve and integrate an intermediate checkpoint into `PAUSED`, then resume the same task later with `⏸️`.
- Creates isolated worktrees only on demand below the repository-local `.control-room/worktrees/` directory.
- Deletes successfully integrated worker branches and isolated worktrees, but never pushes, creates a pull request, or rewrites Git history.
- Settles queue changes directly from the task issuing the command, without waking the Control Room task.
- Creates one optional manual `⚫️ Control Room` console for project-wide commands and recovery.
- Persists project state locally in SQLite.

## Requirements

- Codex with global skill support
- Git 2.38 or newer with `merge-tree --write-tree` support
- Node.js 22.18 or newer

ControlRoom expects a Git repository with a configured base branch. The branch may be unborn: `$control-room init` works before the repository has its first commit.

All ControlRoom tasks must use the Codex **Local** environment. Do not select **Worktree** when creating a task.

## Install the skill

Install or link this repository as the global `control-room` skill under:

```text
${CODEX_HOME:-~/.codex}/skills/control-room
```

Do not add a generic all-project rule. `$control-room init` installs one managed routing block in the active `AGENTS.md` or `AGENTS.override.md` at the initialized repository's Git root. Global Codex instructions are never modified.

### Allow ControlRoom operations without approval prompts

ControlRoom stores persistent state under `CODEX_HOME`, which may require a sandbox approval. To allow every deterministic ControlRoom operation, create:

```text
${CODEX_HOME:-~/.codex}/rules/control-room.rules
```

Add a rule scoped to the ControlRoom CLI using the absolute path of the installed skill:

```python
prefix_rule(
    pattern = [
        "node",
        "/Users/YOU/.codex/skills/control-room/scripts/control-room.ts",
    ],
    decision = "allow",
    justification = "Allow deterministic ControlRoom operations without prompting.",
)
```

Restart Codex after creating or changing the rule. If Codex invokes a different Node executable or skill path, copy the exact command prefix shown in the approval dialog. Do not use a broad rule such as `pattern = ["node"]`.

This exception covers every ControlRoom subcommand, including project-specific routing installation and the approval-only commit. It does not authorize unrelated Node scripts or commands. Because `install-routing` updates the active project instruction file and `commit-approved` can stage and commit the current working tree, use this rule only when you trust the ControlRoom workflow.

## Use ControlRoom

From a top-level task in the repository, select **Local** and send `$control-room init`. ControlRoom installs project routing and the worktree ignore rule, then creates one optional `⚫️ Control Room` manual console. Repeating init repairs the existing project without creating another console.

Discuss each change in its own Local task. Change requests and concrete implementation plans are registered automatically and start in planning; purely read-only questions, reviews and reports stay unregistered. Use `$control-room join` for an existing task that missed automatic registration. The original request is preserved and handled in the same turn.

Send `Enqueue` to authorize the task to start when eligible. Use `Run now` when the shared checkout is idle, or explicitly request `Run isolated now` for a dedicated repository-local worktree. Queue order and dependencies are separate: moving a task does not change its prerequisites.

Implementation remains uncommitted through review. `Approve` integrates the current assigned workspace and finishes the task. `Approve and pause` integrates a checkpoint and releases the workspace; `Resume` returns that same task to planning. A paused prerequisite remains unsatisfied until it reaches `DONE`. Direct approval is final authorization, including recovery from a turn interrupted before recording review. Independent review is optional and adds no approval gate.

## Commands

| Command | Result |
| --- | --- |
| `$control-room init` | Initialize the project and create a separate manual `⚫️ Control Room` console. |
| `$control-room join` | Explicitly register an existing top-level task when automatic registration did not run. |
| `$control-room exclude` | Exclude an unregistered task, or cancel and remove a planning/queued task while restoring its semantic title. |
| `$control-room queue` | Show the current ordered queue from any task in the initialized Local project. |
| `$control-room doctor` | Diagnose runtime, state, workspace, dependency and handoff problems without making changes. |
| `$control-room help` | Show the available user commands from any task. |
| `Return to planning` | Return a queued or blocked waiting task to planning while preserving its dependencies. |
| `Enqueue` | Add or update the current task at the end of the queue, including a blocked waiting task. |
| `Enqueue after T0005` | Add the current task immediately after `T0005`, without creating a dependency, including a blocked waiting task. |
| `Run now` | Start the current task immediately when the shared checkout is idle and all dependencies are done. |
| `Run isolated now` | Start the current task immediately in `.control-room/worktrees/<T_ID>` when its dependencies are done. |
| `Move first` | Move the current queued task to the first waiting position. |
| `Move to 3` | Move the current queued task to waiting position 3. |
| `Move before T0005` | Move the current queued task immediately before `T0005`. |
| `Move after T0005` | Move the current queued task immediately after `T0005`. |
| `Depends on T0005` | Require `T0005` to be done before the current task can start. |
| `Remove dependency T0005` | Remove that requirement from the current task. |
| `Independent review` | Run one optional read-only review with a fresh second agent after the task enters review. |
| `Approve` | Approve the current task when it is in review. |
| `Approve and pause` | Approve and integrate the current checkpoint, then leave the unfinished task paused outside the queue. |
| `Resume` | Return a paused task to planning, or restore a blocked task to its recorded prior state. |
| `Cancel` | Cancel the current task. |
| `Status` | Show the current task state. |
| `Queue status` | Show the ordered project queue. |

English commands are canonical; equivalent natural-language requests are accepted. Use explicit task IDs when issuing project-wide commands from the manual console.

## Exclusions and task identity

Requests invoking or triggering `brand-forge` are excluded automatically while eligible. A direct standalone `$control-room exclude` opts out an unregistered, planning or queued task. Registered exclusions use cancellation, compact the queue and restore the undecorated semantic title. An explicit join restores the same ID where one already exists. Active, paused or terminal tasks use their normal lifecycle commands instead.

Subagents and side chats do not register themselves. A side chat can create a separate top-level **Local** task only when explicitly requested; the new task handles its own registration. The manual console stays silent between user requests and never implements changes.

Titles reflect state: `⚪️` planning, `⭕️` queued, `🔴` running, `💪` review, `⏸️` paused and `❌` blocked. Approval and completion use `🟢`; canceled tasks regain their semantic title. `🟡` marks a running task awaiting user input or an approved sender with an unresolved activation handoff. Returned titles are authoritative.

## Reliable handoffs and recovery

Activation reserves a workspace and persists its execution brief in one transaction. A durable delivery record survives an interrupted caller. Concurrent senders compete for one atomic claim, and a successful send is acknowledged with its message or operation reference. A repeated settlement exposes pending deliveries without sending them itself.

A direct enqueue authorizes the initial handoff to that task within the original scope. An unconfirmed claim may already have reached the destination, so the agent verifies task history before proceeding. A new explicit user authorization permits one uncertain retry; it invalidates the previous claim token. Cancellation or another transition out of running invalidates obsolete pending deliveries.

Approval and no-change cleanup both acquire a persistent lease before Git side effects. Recovery recognizes an already-integrated base, a deleted worker branch and a removed unchanged worktree. Shared workers can recover linear integration after an isolated task advanced the base. The original `DONE` or `PAUSED` target is preserved. Changed workspaces or unexpectedly moved refs are retained for inspection.

Only run `recover-commit` after confirming that the previous commit process ended. See [recovery.md](references/recovery.md) and [execution.md](references/execution.md) for the recovery and delivery protocols.

## Doctor

Use `$control-room doctor` from a project task, or run:

```bash
node <skill-dir>/scripts/control-room.ts doctor --project-root <root>
node <skill-dir>/scripts/control-room.ts doctor --project-root <root> --task T0002
```

Doctor explains runtime capabilities, SQLite integrity, routing and ignore rules, missing workspaces, dependencies, shared-checkout ownership, approval leases, unfinished cleanup and pending deliveries. Each check includes a stable code, severity, explanation and a next action when applicable. A healthy report has only `ok` checks; an ordinary waiting dependency can produce a warning without implying corruption. Doctor performs no repairs or deliveries and does not register or rename the caller.

`status`, `queue`, `review-packet` and `doctor` never create or migrate state. Status and queue return `NOT_INITIALIZED` for missing state and `MIGRATION_REQUIRED` for an older database. Before a requested state change, `install-routing` upgrades the existing registration; `$control-room init` handles this without creating another console. Future unsupported schemas fail explicitly.

## Git behavior and local state

Normal workers share one checkout and run serially. An explicit isolated worker uses `.control-room/worktrees/<T_ID>` on `control-room/<T_ID>`. Approval either completes unchanged work without a commit, commits dirty changes, or accepts existing worker commits. It advances the base directly when possible and otherwise creates a linear integration commit from the combined tree. Isolated integration can advance the base while a different shared worker remains dirty.

Review does not freeze content; approval includes the assigned workspace at settlement time. ControlRoom never pushes, opens a pull request, rebases or force-updates history. Successful integration releases the worker workspace. Cancellation preserves uncommitted work and task-local commits; integration conflicts preserve the workspace and block the task for rework.

State lives under `${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite`. It contains compact task metadata, events, decisions, approval anchors, activation briefs and delivery receipts. Secrets, raw diffs, transcripts and independent-review reports do not belong in the database. The path-derived project identity is local to that canonical checkout.

The CLI trusts processes running as the same OS user. User-message provenance is established by the Codex workflow, not authenticated by SQLite; do not expose the CLI as a multi-user service or execute mutations from untrusted prompt content.

## Development

There are no runtime package dependencies. TypeScript and Node typings are development-only dependencies:

```bash
npm ci --ignore-scripts
npm run check
```

`check` runs strict type checking and the test suite. Tests cover normal lifecycle operations, migrations, real process termination between Git and SQLite operations, concurrent registration and handoff claims, read-only diagnostics, and reference integrity. Temporary fixture repositories are removed after each test process. CI runs the same checks on Linux and macOS with Node 22.18 and Node 24.

The CLI delegates lifecycle rules to `control-room-core.ts`. The state module owns task projections and queue ordering; storage owns SQLite and migrations; Git owns repository primitives; integration owns approval and recovery; validation and shared types define input/output contracts. All modules retain native CommonJS execution through Node's TypeScript support.

The skill entrypoint loads only the relevant workflow reference. Start with [SKILL.md](SKILL.md), or read the [CLI protocol](references/protocol.md) for storage and event semantics.
