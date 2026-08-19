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
- Creates isolated worktrees only on demand below the repository-local `.control-room/worktrees/` directory.
- Deletes successfully integrated worker branches and isolated worktrees, but never pushes, creates a pull request, or rewrites Git history.
- Settles queue changes directly from the task issuing the command, without waking the Control Room task.
- Creates one optional manual `⚫️ Control Room` console for project-wide commands and recovery.
- Persists project state locally in SQLite.

## Requirements

- Codex with global skill support
- Git
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

From any top-level task in the repository, select **Local** under the composer and send:

```text
$control-room init
```

ControlRoom leaves the current task unchanged and creates a separate Local task named `⚫️ Control Room`. That task explains the available commands and acts only as an optional manual console. It does not process events in the background or receive routine notifications.

The project records the current Local checkout and checked-out Git branch as its shared root and base branch. The deterministic `init` command atomically prepends a managed block to the active instruction file and adds the exact `.control-room/` line to the root `.gitignore`. Because the pattern has no leading slash, Git ignores `.control-room` directories at every repository level. The routing block forces new top-level tasks in this repository to load ControlRoom, apply task exclusions before registration or while planning/waiting, and apply all returned title updates; it explicitly excludes subagents and side chats. Running `$control-room init` again repairs both files without creating a duplicate console.

If the local instruction file or root `.gitignore` cannot be updated, initialization remains registered and reports a partial failure. Fix the reported permission or file-safety problem, then run `$control-room init` again. ControlRoom never changes the global `AGENTS.md`.

Initialization does not create a worktree or commit. Its project-local instruction and `.gitignore` changes remain uncommitted. In a new repository, the first activated shared task may also start with other files that are still untracked or otherwise uncommitted. They remain uncommitted through implementation and review; `Approve` creates the root commit, establishes the configured base branch, and removes the worker branch. Isolated execution becomes available after that first base commit exists.

The Control Room console does not receive a `T_ID` and must not be used for planning or implementation. You can open it manually to inspect or reorder the queue, manage dependencies with explicit task IDs, or perform recovery.

Use a separate top-level Codex task in **Local** mode to discuss and plan each change. After initialization, the installed project-specific routing rule makes the task load ControlRoom on its first substantive prompt. ControlRoom assigns a `T_ID`, derives its semantic name, and leaves it in planning only when the requested outcome is a project change or a concrete plan, design, specification, or brief intended for later implementation. Normal implementation remains serialized in one shared checkout. Planning and queueing do not modify code or create branches. When a genuinely independent component must proceed immediately, `Run isolated now` explicitly gives only that task a dedicated repository-local worktree.

Purely read-only requests do not become ControlRoom tasks. Questions, explanations, inspections, diagnoses, audits, reviews, and reports remain unregistered when they ask for no implementation or other project mutation; their title is left unchanged and no `T_ID` is allocated. If a later turn in that same conversation requests a change, ControlRoom registers it then. A mixed request is registered when any substantive part asks for a project change or its implementation plan. Explicit `$control-room join` still forces registration.

Tasks that invoke or trigger the installed `brand-forge` skill are automatically excluded while unregistered, planning, or waiting in the queue. You can opt out any other task in those same states by adding this exact standalone directive to a direct message:

```text
$control-room exclude
```

For an unregistered task, exclusion consumes no `T_ID`, leaves its title unchanged, and never enters the queue. For a registered `PLANNING` or `QUEUED` task, ControlRoom processes the directive through the normal cancellation event: the task becomes `CANCELED`, leaves and compacts the queue, and regains its semantic title without icon or task ID. Its thread then behaves as excluded outside Control Room. You can put a normal request after the directive in the same message; ControlRoom removes only the directive and continues that request outside the queue. Mentions in prose, quoted text, code, tool output, subagent messages, and side chats do not trigger it.

Registered exclusion is rejected from `RUNNING`, `REVIEW`, `APPROVED`, `BLOCKED`, `DONE`, and ordinary `CANCELED`; use the explicit lifecycle commands appropriate to those states. `$control-room join` adopts an excluded task, restoring the same registered task to `PLANNING` when it already had a `T_ID`.

Automatic registration also does not run for persistently excluded tasks, the manual Control Room console, subagents, side chats, `$control-room init`, `$control-room queue`, or `$control-room help`. Outside initialized projects it does nothing.

Codex reads project instructions when a task run starts. Tasks opened before the routing block was installed may therefore still need `$control-room join`; newly started top-level tasks load the rule automatically.

If automatic registration did not run, an existing top-level task can still join explicitly:

```text
$control-room join
```

ControlRoom derives a short semantic name from the existing discussion, assigns the next `T_ID`, and updates the title. The task remains in planning and is not queued automatically.

`join` can be placed at the beginning of a normal request. ControlRoom registers the task first and then processes the rest of that same message; you do not need to repeat the request:

> $control-room join
>
> Inspect the current permission flow, identify the likely cause of duplicate audit entries, and propose a fix. Do not modify files yet.

In this example, Codex both joins the task and performs the requested inspection and planning. If the message contains only `$control-room join`, Codex returns a short registration acknowledgement.

If an existing task is already in a worktree, use **Hand off > Local** before joining it.

### Commands

English is the canonical command language. ControlRoom can still interpret equivalent natural-language requests in other languages.

| Command | Result |
| --- | --- |
| `$control-room init` | Initialize the project and create a separate manual `⚫️ Control Room` console. |
| `$control-room join` | Explicitly register an existing top-level task when automatic registration did not run. |
| `$control-room exclude` | Exclude an unregistered task, or cancel and remove a planning/queued task while restoring its semantic title. |
| `$control-room queue` | Show the current ordered queue from any task in the initialized Local project. |
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
| `Cancel` | Cancel the current task. |
| `Status` | Show the current task state. |
| `Queue status` | Show the ordered project queue. |

`$control-room queue` is the fast, read-only queue command. It works in the manual console, a registered worker, or an unregistered top-level task whose Local environment points to the initialized repository. It does not register or rename the caller. `$control-room help` is also read-only and does not require an initialized project.

Queue order and dependencies are separate. `Enqueue after` and every `Move` command change only the order. `Depends on` and `Remove dependency` change only start eligibility and never move a task.

`Run now` is stricter than `Move first`: it succeeds only when the task can start in the shared checkout during the same settlement. If another shared task is running, in review, or approved, or if a dependency is not done, ControlRoom rejects the request without changing the task state or queue position. Explicit isolated workers do not occupy the shared checkout. A task already running treats the command as an idempotent no-op. From `⚫️ Control Room`, use `Run T0003 now`.

`Run isolated now` is the explicit concurrency switch. It accepts a planning or queued task whose dependencies are all `DONE`, creates `control-room/T0003` at `<project-root>/.control-room/worktrees/T0003`, and starts it without switching or cleaning the shared checkout. This is especially useful when a long shared task is already dirty and the new task touches an independent monorepo component. ControlRoom does not infer independence from paths, and it does not fall back to the shared checkout if worktree creation fails. From `⚫️ Control Room`, use `Run T0003 isolated now`.

From a worker, `Move` and dependency commands apply to that task. From `⚫️ Control Room`, include the target ID, for example `Move T0003 before T0005` or `Make T0003 depend on T0005`.

If the current task is already queued, sending `Enqueue` again moves it from its current position to the end. Retrying the same request is still idempotent; a later explicit `Enqueue` is treated as a new request and performs the move.

A queued task can use `Return to planning` to leave the queue. A task blocked while it was waiting can also return to planning or use `Enqueue` to re-enter at the end; `Enqueue after T0005` chooses an explicit position. These transitions preserve dependencies, and returning to planning clears the old queue position. A task blocked from `RUNNING` or `REVIEW` rejects them because its worker branch may contain uncommitted changes; resume it to its recorded prior state instead.

`Approve` is accepted only from your direct message in the task currently in review. Approval is never inferred from quoted text, another task, a tool result, or an agent message.

A task may be enqueued without a mental model. When it starts, ControlRoom checks its task-local mental model: the relevant current state, desired outcome, approach, affected areas, invariants, non-goals, and verification plan. If it is missing, the activated worker creates it from the task conversation before modifying project files. This also lets tasks queued before the feature was introduced start normally. During planning and implementation, Codex records only the macro decisions that materially shape the result, each with confidence, impact, evidence, and any remaining uncertainty. Superseded decisions remain in the append-only history.

When the task enters review, ControlRoom shows the final mental model, what changed from its baseline, and the decisions ordered from lowest to highest confidence, with unresolved items called out explicitly. It then asks whether you want an independent review. This is optional: you can decline it or say `Approve` immediately.

If you accept, one second agent receives a fresh, read-only review brief containing the request, acceptance criteria, changed-file scope, and verification commands. It does not receive the implementer's reasoning, mental model, or decision log. Its report is advisory and does not change the task state or create an additional approval gate.

At approval time, Codex generates a concise English commit subject that describes the actual final change, such as `Add atomic queue position updates`. It does not reuse `T0001 - Semantic name` or copy the task title. The subject is stored with the approval event so recovery uses the same message.

- If the working tree is clean, ControlRoom only marks the current task done and removes it from the queue. It performs no Git write and does not interpret or merge existing commits.
- If uncommitted changes are already on the configured base branch, ControlRoom commits them directly there without a merge.
- If uncommitted changes are on a task worker branch, ControlRoom commits them there and integrates the result linearly into the latest base branch.
- After successful isolated integration, ControlRoom removes the isolated worktree and worker branch. A conflict instead blocks the task and preserves both so it can be resumed and reworked.

## Quiet coordination

ControlRoom uses task titles as the normal status display and keeps routine orchestration out of the conversation:

- Registration, queue movements, title changes, approval, and completion are normally silent.
- A direct ControlRoom command receives at most one short acknowledgement.
- A worker receives one activation brief when it can start.
- Additional operational messages appear only when an error, blocker, recovery step, or user action needs attention.
- `Status` and `Queue status` show details only when requested.

The task issuing a state-changing command immediately invokes the deterministic settlement engine. Settlement processes pending events, serially integrates approved tasks, activates requested isolated workers, activates the next eligible shared worker when that checkout is idle, and returns one mandatory `titleUpdates` list in the same turn. Codex applies every entry before replying, including the green title for a completed task and the renumbered titles of all remaining queued tasks. No wake or routine message is sent to `⚫️ Control Room`.

## Example usage

Initialize from any top-level Local task:

> $control-room init

ControlRoom leaves that task unchanged and creates a separate `⚫️ Control Room` task. Its first response explains that it is a silent manual console and ends with the command list. You do not need to keep it open.

Routine queue work happens directly in worker tasks. The console runs only when you open it and send a command.

You can then start a dedicated top-level Local task with a normal planning prompt:

> Add an audit log for changes to user permissions. First inspect the current authorization flow, identify the files involved, and propose an implementation plan. Do not modify files yet.

ControlRoom automatically registers it and may rename it `⚪️ T0001 - Add permission audit log`. It remains in planning. `$control-room join` remains available as a fallback.

After reviewing the plan, queue the task:

> Enqueue

Suppose two more tasks are waiting and the queue is `T0001`, `T0002`, `T0003`. You can reprioritize `T0003` from its own task:

> Move first

Or do the same from the manual console:

> Move T0003 before T0001

If `T0003` cannot start until `T0005` is completed, add that constraint separately:

> Depends on T0005

You can check progress from the same task:

> $control-room queue

If `T0001` is already a long-running dirty shared task and a new `T0002` concerns an independent monorepo component, send this from `T0002`:

> Run isolated now

ControlRoom creates `<project-root>/.control-room/worktrees/T0002` and starts `T0002` there immediately. `T0001` stays checked out and dirty exactly as it was. When you approve `T0002`, ControlRoom commits in that worktree, serially integrates the result into the latest base branch, then removes the worktree and `control-room/T0002`. `T0001` can continue in its existing shared workspace. If integration conflicts, `T0002` becomes blocked and its worktree is preserved for rework.

To see the available commands at any time:

> $control-room help

While the task is queued, no branch exists for it. When ControlRoom activates the task, it creates and checks out `control-room/T0001`; Codex implements the approved plan there without committing, then moves it to review. If you request more implementation during review, the task returns to running before Codex changes files, keeps the same branch, and enters review again afterward. Questions and read-only checks do not restart it. When the current working tree is ready, approve it from that task:

> Approve

The older conversational form remains available when you want queue details:

> Queue status

## Task titles

ControlRoom keeps task titles synchronized with their state:

| Status | Example title |
| --- | --- |
| Planning | `⚪️ T0001 - Add audit log` |
| Queued | `⭕️ ① T0001 - Add audit log` |
| Queued, multi-digit position | `⭕️ ①⓪ T0010 - Add audit log` |
| Running | `🔴 T0001 - Add audit log` |
| Running, awaiting your response | `👉 T0001 - Add audit log` |
| Review | `💪 T0001 - Add audit log` |
| Approved | `🟢 T0001 - Add audit log` |
| Done | `🟢 T0001 - Add audit log` |
| Blocked | `❌ T0001 - Add audit log` |
| Canceled | `Add audit log` |

When a running task cannot continue without your direct answer, confirmation, choice, or approval, it temporarily switches from `🔴` to `👉`. The underlying state, queue order, branch, and files do not change. Your next direct message restores `🔴` before the task continues; if it still needs an answer, it shows `👉` again. Planning and review tasks always retain their normal state icons, even when Codex asks a question. Ordinary review approval and optional questions do not use this marker.

Blocked tasks retain the `❌` status icon and task ID. A queued task or one blocked from the waiting queue can return explicitly to planning; the blocked task can also be enqueued again. Canceled and registered-excluded tasks leave the active queue and return to their undecorated semantic title.

The queue marker is derived from SQLite's active order, but it counts only tasks still in `QUEUED`. A task in `RUNNING`, `REVIEW`, `APPROVED`, or `BLOCKED` keeps its internal order without consuming `①`, `②`, and so on. The marker is never stored in the semantic task name. Every settlement returns the final queue snapshot and a deduplicated `titleUpdates` list. Codex applies the list before reporting success, including returned-to-planning and terminal tasks that no longer appear in the queue. Therefore activation, moving, blocking, return-to-planning, resuming, cancellation, exclusion, or completion renumbers every remaining queued task automatically, returns `PLANNING` to `⚪️`, and changes `DONE` to `🟢`.

## Typical workflow

1. Open a dedicated top-level task and discuss the change.
2. Refine the plan without editing code.
3. Say `Enqueue`; use `Move` to reprioritize it and `Depends on T0005` only when it truly depends on another task.
4. The worker invokes settlement, which activates the first eligible task after its dependencies are done.
5. If its mental model is missing, the activated worker creates and records it from the task context before modifying files. Codex then implements and verifies the change while recording material decisions. If it needs a blocking confirmation, its title switches from `🔴` to `👉` until you respond.
6. The task moves to review and shows its mental model and confidence-ordered decisions. ControlRoom asks whether you also want one independent review; it never starts one automatically.
7. Review the result, optionally request the independent pass, and say `Approve` in the same task when satisfied. Further implementation requests return it to running, then back to review when the changes are ready.
8. Settlement completes the task: it either performs no Git operation for a clean tree, commits directly on the base branch, or commits and integrates the worker branch.
9. The task becomes done and the next eligible task can start from the updated base.

Dependencies must be `DONE` before a dependent task can run. A clean approval can satisfy this state without ControlRoom creating a commit.

For the opt-in concurrent path, replace step 3 with `Run isolated now`. The task receives its own `workspacePath` and may proceed while the shared worker remains dirty. Approval still enters the same serialized integration sequence; success removes the isolated workspace, while a conflict preserves it and marks the task `BLOCKED` until it is resumed and reworked.

## Git behavior

ControlRoom uses one shared mode by default and one explicit isolated mode:

- Every Codex task remains in the **Local** environment.
- Normal tasks use the same primary checkout and remain mutually exclusive there.
- `Run isolated now` creates `<project-root>/.control-room/worktrees/<T_ID>` on `control-room/<T_ID>` from the latest configured base branch. The root `.gitignore` pattern `.control-room/` excludes this directory name at every level.
- Planning and queued tasks do not modify files or create branches.
- When a normal queued task starts, ControlRoom creates and checks out `control-room/T0001` from the configured base branch in the primary checkout.
- The worker changes files only in the `workspacePath` from its activation brief, without staging or committing them. Review feedback that requires edits first returns the task to running in the same workspace and branch.
- Review does not require dirty files and does not freeze the working tree; manual or external changes may still continue until `Approve`.
- A clean shared approval performs no Git write and only removes the task from the active queue. A clean isolated approval also removes its unused worktree and branch.
- When dirty changes are already on the configured base branch, approval commits them there using the meaningful English subject captured by the approval event.
- When dirty changes are on the worker branch, approval creates that commit on the worker branch.
- The commit contains the current uncommitted changes at approval time.
- Worker commits are integrated one at a time into the latest base. If the base is already an ancestor, it advances directly; otherwise ControlRoom creates a linear single-parent integration commit with the combined tree, without a merge commit or rebase.
- A dirty shared task can remain checked out while an isolated approval advances the base branch reference; its `HEAD`, index, and working files are untouched.
- After successful isolated integration, ControlRoom removes the worktree and branch. If integration conflicts, it clears the lease, keeps both, and marks the task `BLOCKED` from `RUNNING`; resume it before reworking and requesting review again.
- Canceling an unchanged isolated task removes its workspace and branch. Canceling a task with uncommitted changes or task-local commits preserves them and reports the path for recovery.
- ControlRoom does not push or open a pull request.

ControlRoom itself does not create commits before approval and does not reject approval based on commits made outside its workflow.

## Local state and privacy

Project state is stored under:

```text
${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite
```

The database contains task identifiers, states, queue order, dependencies, the approval commit anchor, compact mental-model snapshots, decision records, other compact events, and execution briefs. Independent-review reports, raw diffs, secrets, and complete conversation transcripts are not stored in ControlRoom state.

Direct-user provenance is a trust guarantee provided by the Codex workflow. The local CLI cannot distinguish between processes running as the same operating-system user, so do not expose it as a multi-user service or execute state-changing commands from untrusted prompt content.

## Technical reference

For the deterministic CLI, state machine, recovery workflow, and storage protocol, see [references/protocol.md](references/protocol.md).
