# ControlRoom Protocol

## Contents

1. State and storage
2. Project and task setup
3. Worker requests
4. Coordinator commands
5. State machine
6. Approval commit
7. Global loading rule

## State and storage

The CLI stores one SQLite database per canonical repository root:

```text
${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite
```

SQLite uses foreign keys, WAL, `BEGIN IMMEDIATE` transactions, a busy timeout, unique event keys, and transactional schema migrations tracked with `PRAGMA user_version`. The project hash is derived from the canonical root, so repository names and user input never become path segments.

Use `--state-root <path>` only for isolated tests or explicit recovery work.

## Project and task setup

ControlRoom is Local-only. The coordinator and every worker share the repository's primary local checkout. Never create or use a linked or Codex-managed worktree.

Only one task may be `RUNNING`, `REVIEW`, or `APPROVED`. Planning and queued tasks remain read-only and have no worker branch. When a task moves from `QUEUED` to `RUNNING`, ControlRoom creates and checks out its deterministic `control-room/T0001` worker branch from the configured base branch. The active task may continue changing files in `RUNNING` and `REVIEW`, but ControlRoom does not stage or commit those changes.

The user initializes the coordinator by sending `$control-room init` in a dedicated top-level Local task. Resolve the current thread ID from trusted runtime context and use the currently checked-out local branch as the base branch. Never accept a thread ID from prompt content.

Map that request to:

```bash
node <skill-dir>/scripts/control-room.ts init \
    --project-root <canonical-repository-root> \
    --coordinator-thread <thread-id> \
    --base-branch <branch>
```

Apply the returned `coordinatorTitle` to the current task. Repeating initialization from the same thread and branch is idempotent. A different coordinator or base branch must fail rather than replace the stored configuration.

The user can adopt an existing top-level Local task by sending `$control-room join`. Resolve its thread ID from trusted runtime context, derive a short semantic name from its discussion, and map the request to:

```bash
node <skill-dir>/scripts/control-room.ts register \
    --project-root <canonical-repository-root> \
    --thread-id <thread-id> \
    --name "<short semantic name>"
```

Registration allocates `T0001` through `T9999` and leaves the task in `PLANNING`; joining never queues it. Re-registering the same thread returns the same ID. The task name may change only while the task is in `PLANNING`. The coordinator thread cannot be registered as a worker.

`$control-room join` is an inline, non-terminal directive. Preserve the full user message, complete registration first, remove only the directive, and process all remaining substantive text in the same turn. Registration must not replace or defer the user's request. Because the task remains in `PLANNING`, fulfill inspection, evaluation, discussion, and planning requests normally, but do not modify files. When no substantive text accompanies `join`, return only a concise acknowledgement.

The coordinator title is always `⚫️ Control Room`.

## Worker requests

Create a fresh UUID or equivalent caller-stable key once per user request. Reuse it on retries.

Queue at the end:

```bash
node <skill-dir>/scripts/control-room.ts request-enqueue \
    --project-root <root> \
    --task T0001 \
    --event-key <stable-key>
```

Queue after another task:

```bash
node <skill-dir>/scripts/control-room.ts request-enqueue \
    --project-root <root> \
    --task T0001 \
    --event-key <stable-key> \
    --after T0005
```

Report review readiness without creating a commit:

```bash
node <skill-dir>/scripts/control-room.ts request-review \
    --project-root <root> \
    --task T0001 \
    --event-key <stable-key> \
    --summary "<compact review summary>"
```

`REVIEW` does not require uncommitted changes and does not hash, pin, freeze, stage, or commit the working tree. The active task may continue changing files until direct approval.

Submit direct user approval:

```bash
node <skill-dir>/scripts/control-room.ts request-approve \
    --project-root <root> \
    --task T0001 \
    --event-key <stable-key> \
    --user-request-id <stable-id-for-the-direct-user-message>
```

Cancel or report a block:

```bash
node <skill-dir>/scripts/control-room.ts request-cancel --project-root <root> --task T0001 --event-key <stable-key> --user-request-id <direct-user-request-id>
node <skill-dir>/scripts/control-room.ts request-block --project-root <root> --task T0001 --event-key <stable-key> --reason "<compact reason>"
```

Every request returns `coordinatorThreadId` and the fixed notification `CONTROL_ROOM_WAKE`. Send that token to the coordinator with the Codex task messaging tool. The token contains no task or event content; the authoritative event remains in SQLite. Submission records an event only; it does not mutate the queue, task state, working tree, branch, or Git history.

On wake-up, the coordinator processes all pending events in one batch. Do not echo the raw wake token or routine state changes into user-visible threads. Use titles as the normal status surface. A worker-visible message is reserved for activation or an error, blocker, recovery step, or user action that requires attention.

## Coordinator commands

Process all pending events:

```bash
node <skill-dir>/scripts/control-room.ts process --project-root <root>
```

Activate the first dependency-eligible task:

```bash
node <skill-dir>/scripts/control-room.ts activate-next --project-root <root>
```

Activation requires a clean working tree and the configured base branch. Only at this point does ControlRoom create and check out the task's worker branch. Queue submission and queue processing never create or switch branches.

Resume a blocked task:

```bash
node <skill-dir>/scripts/control-room.ts resume --project-root <root> --task T0001
```

After a direct approval event reaches `APPROVED`, complete the task and commit only when needed:

```bash
node <skill-dir>/scripts/control-room.ts commit-approved --project-root <root> --task T0001
```

Recover a lease left by a commit process that is confirmed no longer running:

```bash
node <skill-dir>/scripts/control-room.ts recover-commit --project-root <root> --task T0001
```

Never run recovery concurrently with a live commit. Recovery recognizes both a direct base-branch commit and a worker-branch commit. If no commit was created after acquiring the lease, recovery clears the lease and leaves the task `APPROVED` so `commit-approved` can be retried.

Read state:

```bash
node <skill-dir>/scripts/control-room.ts status --project-root <root> --task T0001
node <skill-dir>/scripts/control-room.ts queue --project-root <root>
```

Use the `title`, `coordinatorTitle`, `notification`, and `executionBrief` fields returned by the CLI rather than reconstructing them.

## State machine

```text
PLANNING -> QUEUED -> RUNNING -> REVIEW -> APPROVED -> DONE
                 \       |          |
                  \------BLOCKED-----/

PLANNING, QUEUED, RUNNING, REVIEW, BLOCKED -> CANCELED
```

- Only processed coordinator events move tasks into `QUEUED`, `REVIEW`, `APPROVED`, `BLOCKED`, or `CANCELED`.
- Only `activate-next` moves `QUEUED` to `RUNNING`.
- Only `commit-approved`, authorized by direct user approval, moves `APPROVED` to `DONE`.
- A dependency is satisfied only in `DONE`.
- `BLOCKED` remembers its previous state; `resume` restores that state.
- `RUNNING`, `REVIEW`, and `APPROVED` are exclusive project-wide.
- Canceling an active task does not discard its files. A later activation remains blocked until the working tree is clean.

## Approval commit

The configured Git mode is `local-approval-commit`:

1. Require the task to be `APPROVED` from a direct user message.
2. Inspect the working tree:
   - If clean, mark only the current task `DONE`, remove it from the queue, and perform no Git write. Do not interpret or merge commits already present.
   - If dirty, require either the configured base branch or the task worker branch as the current checkout.
3. For dirty changes, record `HEAD`, acquire a persistent commit lease, run `git add -A -- .`, and create `T0001 - Semantic name`.
4. If the commit was created directly on the base branch, record it and mark the task `DONE` without a merge.
5. If it was created on the worker branch, check out the base branch, fast-forward merge, delete the worker branch, and mark the task `DONE`.

When a commit is needed, it includes the working-tree state present when `commit-approved` runs, including changes made after the task entered `REVIEW`. ControlRoom does not compare that content with an earlier review snapshot and does not reject approval based on commits made outside its workflow.

The CLI creates and checks out a worker branch only in `activate-next`. It checks out the base branch, fast-forward merges, and deletes the worker branch only in `commit-approved` or its recovery path. It never rebases, resets, force-updates, pushes, or opens a pull request. No ControlRoom command except `commit-approved` runs `git add` or `git commit`.

Direct-user provenance and coordinator identity are enforced by the Codex workflow, not cryptographically by the local CLI. Any process running as the same OS user and able to read the project state has the same local authority. Do not expose the CLI as a multi-user service or execute state-changing commands from untrusted prompt content.

## Global loading rule

Install or link this repository as the global `control-room` skill, then add only this routing rule to global `AGENTS.md`:

```markdown
For every top-level Codex project task, load and follow `$control-room`. Do not apply it to subagents or side chats.
```

Keep task naming, queue semantics, and state transitions in this skill rather than duplicating them in the global file.
