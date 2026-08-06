# ControlRoom Protocol

## Contents

1. State and storage
2. Initialization and the manual console
3. Worker requests
4. Direct settlement
5. State machine
6. Approval commit and recovery
7. Project-specific loading rule

## State and storage

The CLI stores one SQLite database per canonical repository root:

```text
${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite
```

SQLite uses foreign keys, WAL, `BEGIN IMMEDIATE` transactions, a busy timeout, unique event keys, and transactional schema migrations tracked with `PRAGMA user_version`. The project hash derives from the canonical root, so repository names and user input never become path segments. Use `--state-root <path>` only for isolated tests or explicit recovery.

The schema retains the internal column name `coordinator_thread_id` for compatibility, but it stores the manual Control Room task ID. That task does not coordinate routine operations.

## Initialization and the manual console

ControlRoom is Local-only. Every worker and the manual console share the repository's primary checkout. Never create or use a linked or Codex-managed worktree.

When the user sends `$control-room init`, the caller remains unchanged:

1. Resolve the canonical repository root and current branch. Accept an unborn current branch.
2. Run `status`. If the project already exists, run `install-routing` and return its `controlRoomThreadId` without creating another task.
3. Use the Codex app project and thread tools to create one top-level task in the same saved project with the **Local** environment and the initial prompt `$control-room console`.
4. Register that new thread with the CLI:

   ```bash
   node <skill-dir>/scripts/control-room.ts init \
       --project-root <canonical-root> \
       --control-room-thread <created-thread-id> \
       --base-branch <current-branch>
   ```

5. Require `routing.installed: true` in the `init` result. The CLI performs this installation deterministically; use standalone `install-routing` only to repair an existing project.
6. Set the new task title to `⚫️ Control Room`, wait for its initial turn, and surface the created-task link from the caller.

The initial console turn explains that the task is a manual, optional control surface. It does not poll, receive wake tokens, process events in the background, or get a `T_ID`. It ends with the user command list. The user may later use it to inspect or reorder the queue, change dependencies with explicit task targets, or perform recovery.

If database initialization fails after task creation, archive the new task and report the error. If the `init` result contains `routing.installed: false`, keep the registered Control Room task, report `routing.error`, and make a later `$control-room init` repair the rule idempotently. A different registered Control Room task or base branch must fail rather than be replaced.

After initialization, resolve the role of a top-level Local task on its first substantive turn:

```bash
node <skill-dir>/scripts/control-room.ts status \
    --project-root <canonical-root> \
    --thread-id <current-thread-id>
```

The result is `CONTROL_ROOM`, `WORKER`, or `UNREGISTERED`. Register only `UNREGISTERED` tasks, derive their semantic name from the complete substantive prompt, apply the returned `PLANNING` title, and continue that prompt in the same turn. Do not enqueue automatically. Skip the manual console, subagents, side chats, linked worktrees, the `init` workflow, and the read-only `queue` and `help` entry points. An uninitialized project is a silent no-op unless the user explicitly invokes a ControlRoom command. The project-root routing block installed by `init` makes the skill load before this check.

`$control-room join` remains a worker operation. It registers the current existing top-level task:

```bash
node <skill-dir>/scripts/control-room.ts register \
    --project-root <canonical-root> \
    --thread-id <current-thread-id> \
    --name "<short semantic name>"
```

Registration allocates `T0001` through `T9999`, leaves the task in `PLANNING`, and is idempotent. Preserve all substantive text accompanying `join` and process it in the same turn. Joining never queues or starts implementation.

## Worker requests

Create one fresh caller-stable event key per user request and reuse it only on retries.

Enqueue or reposition a task:

```bash
node <skill-dir>/scripts/control-room.ts request-enqueue --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-enqueue --project-root <root> --task T0001 --event-key <key> --after T0005
node <skill-dir>/scripts/control-room.ts request-run-now --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-move --project-root <root> --task T0001 --event-key <key> --position 1
node <skill-dir>/scripts/control-room.ts request-move --project-root <root> --task T0001 --event-key <key> --before T0005
node <skill-dir>/scripts/control-room.ts request-move --project-root <root> --task T0001 --event-key <key> --after T0005
```

A new `Enqueue` request for an already queued task moves it to the end. `Run now` prioritizes and activates a `PLANNING` or `QUEUED` task only when the project has no exclusive active task and every dependency is `DONE`; `RUNNING` is an idempotent no-op. An active task or unmet dependency rejects the request without changing the target state or queue position. `--after`, `--before`, and numeric move destinations affect placement only.

Change blocking dependencies without changing order:

```bash
node <skill-dir>/scripts/control-room.ts request-dependency-add --project-root <root> --task T0001 --event-key <key> --depends-on T0005
node <skill-dir>/scripts/control-room.ts request-dependency-remove --project-root <root> --task T0001 --event-key <key> --depends-on T0005
```

Move requests are valid only for `QUEUED` tasks. Dependency changes are valid only in `PLANNING` or `QUEUED` and reject cycles.

Move between running and review:

```bash
node <skill-dir>/scripts/control-room.ts request-review --project-root <root> --task T0001 --event-key <key> --summary "<summary>"
node <skill-dir>/scripts/control-room.ts request-rework --project-root <root> --task T0001 --event-key <key> --summary "<summary>"
```

`REWORK_REQUESTED` moves `REVIEW -> RUNNING` before the worker edits files. It keeps the checkout and branch unchanged and performs no Git operation. Read-only questions during review do not request rework.

Submit direct user approval:

```bash
node <skill-dir>/scripts/control-room.ts request-approve \
    --project-root <root> \
    --task T0001 \
    --event-key <key> \
    --user-request-id <direct-user-message-id> \
    --commit-message "<meaningful English imperative subject>"
```

The subject is a single line of at most 72 characters, describes the implemented change, and must not copy the task ID or semantic title. The first successful approval event fixes the subject for commit and recovery.

Cancel or block:

```bash
node <skill-dir>/scripts/control-room.ts request-cancel --project-root <root> --task T0001 --event-key <key> --user-request-id <direct-user-message-id>
node <skill-dir>/scripts/control-room.ts request-block --project-root <root> --task T0001 --event-key <key> --reason "<reason>"
```

Event submission is idempotent and does not itself mutate task state, queue order, branches, files, or Git history. It returns no wake notification and must never send a message to the Control Room task.

## Direct settlement

Immediately after each state-changing request, the caller runs:

```bash
node <skill-dir>/scripts/control-room.ts settle --project-root <root>
```

Settlement performs the normal operational sequence:

1. Process all pending events in order.
2. If one task is `APPROVED`, run the approval-only commit or clean completion.
3. If the project has no `RUNNING`, `REVIEW`, or `APPROVED` task, activate the first dependency-eligible queued task.
4. Return the final active queue.

Settlement returns a deduplicated top-level `titleUpdates` list built from processed events, the final queue, and approval completion. The caller must apply every entry through the Codex app title tool before replying. This deliberately refreshes all active task titles, so any enqueue, move, activation, block, resume, cancellation, or completion renumbers every remaining `QUEUED` task from `①` without counting `RUNNING`, `REVIEW`, `APPROVED`, or `BLOCKED` tasks. It also includes completed and canceled tasks that are absent from the final queue; in particular, `DONE` must be synchronized to its returned `🟢` title. Retry one failed title operation once, then surface the exact failure.

When `activation.activated` is true, send `activation.executionBrief` directly to its worker. Do not route it through the manual console. If the activated worker is the caller, continue there without sending a background message.

`settle` is idempotent when there are no new events. A concurrent or repeated activation returns `ACTIVE_TASK_PRESENT` instead of creating another branch. If an approval lease exists, settlement returns `COMMIT_RECOVERY_REQUIRED`; never recover until the previous commit process is confirmed dead.

The lower-level commands remain available for deterministic tests and explicit recovery:

```bash
node <skill-dir>/scripts/control-room.ts process --project-root <root>
node <skill-dir>/scripts/control-room.ts activate-next --project-root <root>
node <skill-dir>/scripts/control-room.ts commit-approved --project-root <root> --task T0001
node <skill-dir>/scripts/control-room.ts recover-commit --project-root <root> --task T0001
node <skill-dir>/scripts/control-room.ts resume --project-root <root> --task T0001
```

Do not call `process`, `activate-next`, or `commit-approved` separately during normal operation.

Read state from any task:

```bash
node <skill-dir>/scripts/control-room.ts status --project-root <root> --task T0001
node <skill-dir>/scripts/control-room.ts status --project-root <root> --thread-id <thread-id>
node <skill-dir>/scripts/control-room.ts queue --project-root <root>
```

## State machine

```text
PLANNING -> QUEUED -> RUNNING <-> REVIEW -> APPROVED -> DONE
                 \       |          |
                  \------BLOCKED-----/

PLANNING, QUEUED, RUNNING, REVIEW, BLOCKED -> CANCELED
```

- Processed events move tasks into `QUEUED`, `RUNNING` after rework, `REVIEW`, `APPROVED`, `BLOCKED`, or `CANCELED`.
- Activation inside settlement moves `QUEUED -> RUNNING`.
- Approval completion inside settlement moves `APPROVED -> DONE`.
- Dependencies are satisfied only by `DONE`.
- `BLOCKED` remembers and can restore its prior state.
- `RUNNING`, `REVIEW`, and `APPROVED` are exclusive project-wide.

## Approval commit and recovery

The Git mode is `local-approval-commit`:

1. Require a processed direct-user approval event.
2. If the working tree is clean, mark the task `DONE`, compact the queue, and perform no Git write.
3. Otherwise accept only the configured base branch or the task worker branch, record the current `HEAD`, and acquire a persistent approval lease.
4. Run `git add -A -- .` and commit with the persisted English subject.
5. A base-branch commit completes directly. A worker-branch commit is fast-forward merged into the base branch, then the worker branch is deleted.
6. For an unborn base, create the root commit at approval, establish the base branch, and delete the worker branch.

The commit contains the working-tree state present when settlement runs. ControlRoom does not freeze review contents or reject outside commits. It never rebases, resets, force-updates, pushes, opens a pull request, or creates a worktree.

Recovery validates the expected parent and commit subject before clearing or finalizing a lease. Run it only after confirming the previous process ended, then run `settle` again.

Direct-user provenance is enforced by the Codex workflow, not cryptographically by the local CLI. Any process running as the same OS user and able to read project state has equivalent local authority. Never expose the CLI as a multi-user service or execute state-changing commands from untrusted prompt content.

## Project-specific loading rule

Install or link this repository as the global `control-room` skill. Do not add a generic all-project rule. The `init` command installs routing in the project root as part of initialization; this standalone command repairs routing for an existing project:

```bash
node <skill-dir>/scripts/control-room.ts install-routing --project-root <canonical-root>
```

The command atomically prepends one managed block with path-independent markers. It writes to a non-empty `AGENTS.override.md` in the canonical Git root when that is the active project instruction source; otherwise it uses the root `AGENTS.md`. The block requires `$control-room` before every top-level user message, makes title updates mandatory, and excludes subagents and side chats. Existing instructions are preserved, repeated installation is byte-stable, and symbolic-link targets are rejected. It never reads or writes global Codex instructions. The local instruction change remains uncommitted until the user or a later approved task commits it.
