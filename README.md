# ControlRoom

ControlRoom coordinates multiple top-level Codex tasks inside a Git project. It keeps planning, implementation, review, approval, dependencies, and local commits in a predictable queue while each change remains in its own dedicated task.

## What it does

- Assigns project-scoped task IDs such as `T0001`.
- Keeps planned work separate from active implementation.
- Queues tasks in a deterministic order with optional dependencies.
- Allows only one task at a time to run, wait for review, or await its approval commit.
- Leaves changes uncommitted during implementation and review.
- Creates a worker branch only when a queued task starts running.
- Creates a commit only after direct user approval and only when uncommitted changes exist.
- Deletes the merged worker branch, but never pushes, creates a pull request, or rewrites Git history.
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

Add this minimal routing rule to your global `AGENTS.md`:

```markdown
For every top-level Codex project task, load and follow `$control-room`. Do not apply it to subagents or side chats.
```

Keep the detailed workflow in the skill rather than copying it into `AGENTS.md`.

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

This exception covers every ControlRoom subcommand, including the approval-only commit. It does not authorize unrelated Node scripts or commands. Because `commit-approved` can stage and commit the current working tree, use this rule only when you trust the ControlRoom workflow.

## Use ControlRoom

Before creating project tasks, open one dedicated top-level task in the repository, select **Local** under the composer, and send:

```text
$control-room init
```

ControlRoom uses the current Local checkout as the shared project checkout, records its currently checked-out Git branch as the base branch, and keeps the coordinator title fixed as `⚫️ Control Room`.

Initialization does not create a commit. In a new repository, the first activated task may start with files that are still untracked or otherwise uncommitted. They remain uncommitted through implementation and review; `Approve` creates the root commit, establishes the configured base branch, and removes the worker branch.

The coordinator does not receive a `T_ID` and must not be used for planning or implementation. Running `$control-room init` again in the same task is safe; another task cannot silently replace the registered coordinator.

Use a separate top-level Codex task in **Local** mode to discuss and plan each change. ControlRoom serializes implementation, so the tasks share one checkout without requiring worktrees. Planning and queueing do not modify code or create branches. When the plan is ready, use one of the commands below in that task.

An existing top-level task can also join the initialized project. Send:

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
| `$control-room init` | Initialize the current top-level task as the project coordinator. |
| `$control-room join` | Register an existing top-level task in planning without queueing it. |
| `$control-room queue` | Show the current ordered queue from any task in the initialized Local project. |
| `$control-room help` | Show the available user commands from any task. |
| `Enqueue` | Add or update the current task at the end of the queue. |
| `Enqueue after T0005` | Add the current task immediately after `T0005`, without creating a dependency. |
| `Move first` | Move the current queued task to the first waiting position. |
| `Move to 3` | Move the current queued task to waiting position 3. |
| `Move before T0005` | Move the current queued task immediately before `T0005`. |
| `Move after T0005` | Move the current queued task immediately after `T0005`. |
| `Depends on T0005` | Require `T0005` to be done before the current task can start. |
| `Remove dependency T0005` | Remove that requirement from the current task. |
| `Approve` | Approve the current task when it is in review. |
| `Cancel` | Cancel the current task. |
| `Status` | Show the current task state. |
| `Queue status` | Show the ordered project queue. |

`$control-room queue` is the fast, read-only queue command. It works in the coordinator, in a registered worker, or in an unregistered top-level task whose Local environment points to the initialized repository. It does not register the task, change its title, or notify the coordinator. `$control-room help` is also read-only and does not require an initialized project.

Queue order and dependencies are separate. `Enqueue after` and every `Move` command change only the order. `Depends on` and `Remove dependency` change only start eligibility and never move a task.

From a worker, `Move` and dependency commands apply to that task. From `⚫️ Control Room`, include the target ID, for example `Move T0003 before T0005` or `Make T0003 depend on T0005`.

If the current task is already queued, sending `Enqueue` again moves it from its current position to the end. Retrying the same request is still idempotent; a later explicit `Enqueue` is treated as a new request and performs the move.

`Approve` is accepted only from your direct message in the task currently in review. Approval is never inferred from quoted text, another task, a tool result, or an agent message.

At approval time, Codex generates a concise English commit subject that describes the actual final change, such as `Add atomic queue position updates`. It does not reuse `T0001 - Semantic name` or copy the task title. The subject is stored with the approval event so recovery uses the same message.

- If the working tree is clean, ControlRoom only marks the current task done and removes it from the queue. It performs no Git write and does not interpret or merge existing commits.
- If uncommitted changes are already on the configured base branch, ControlRoom commits them directly there without a merge.
- If uncommitted changes are on the task's worker branch, ControlRoom commits, fast-forward merges into the base branch, and deletes the worker branch.

## Quiet coordination

ControlRoom uses task titles as the normal status display and keeps routine orchestration out of the conversation:

- Registration, queue movements, title changes, approval, and completion are normally silent.
- A direct ControlRoom command receives at most one short acknowledgement.
- A worker receives one activation brief when it can start.
- Additional operational messages appear only when an error, blocker, recovery step, or user action needs attention.
- `Status` and `Queue status` show details only when requested.

Workers send the coordinator a minimal internal wake-up rather than a detailed status notification. The authoritative event remains in SQLite, and the coordinator processes all pending events together. The wake-up token and routine processing output should not be echoed into user-visible messages.

## Example usage

First, create a dedicated top-level task for the repository and initialize the coordinator:

> $control-room init

ControlRoom renames that task `⚫️ Control Room` and keeps that title in every state. Leave it dedicated to coordination.

After initialization, the final response confirms the configured base branch and ends with the same concise command list available through `$control-room help`. The list is shown on both the first initialization and an idempotent retry.

You can start a dedicated top-level task with a normal planning prompt:

> Add an audit log for changes to user permissions. First inspect the current authorization flow, identify the files involved, and propose an implementation plan. Do not modify files yet.

If this task already existed before ControlRoom was initialized, adopt it:

> $control-room join

For example, ControlRoom may rename it `⚪️ T0001 - Add permission audit log`. It remains in planning.

After reviewing the plan, queue the task:

> Enqueue

Suppose two more tasks are waiting and the queue is `T0001`, `T0002`, `T0003`. You can reprioritize `T0003` from its own task:

> Move first

Or do the same from the coordinator:

> Move T0003 before T0001

If `T0003` cannot start until `T0005` is completed, add that constraint separately:

> Depends on T0005

You can check progress from the same task:

> $control-room queue

To see the available commands at any time:

> $control-room help

While the task is queued, no branch exists for it. When ControlRoom activates the task, it creates and checks out `control-room/T0001`; Codex implements the approved plan there without committing, then moves it to review. You may continue requesting changes during review. When the current working tree is ready, approve it from that task:

> Approve

The older conversational form remains available when you want queue details:

> Queue status

## Task titles

ControlRoom keeps task titles synchronized with their state:

| State | Example title |
| --- | --- |
| Planning | `⚪️ T0001 - Add audit log` |
| Queued | `⭕️ ① T0001 - Add audit log` |
| Queued, multi-digit position | `⭕️ ①⓪ T0010 - Add audit log` |
| Running | `🔴 T0001 - Add audit log` |
| Review | `🟡 T0001 - Add audit log` |
| Approved | `🟢 T0001 - Add audit log` |
| Done | `🟢 T0001 - Add audit log` |
| Blocked | `❌ T0001 - Add audit log` |
| Canceled | `❌ T0001 - Add audit log` |

Blocked and canceled tasks use the same `❌` status icon.

The queue marker is derived from SQLite's active order, but it counts only tasks still in `QUEUED`. A task in `RUNNING`, `REVIEW`, `APPROVED`, or `BLOCKED` keeps its internal order without consuming `①`, `②`, and so on. The marker is never stored in the semantic task name. Queue and state changes return title updates for the affected queued tasks, so activation, moving, blocking, resuming, or removing a task renumbers every changed title automatically.

## Typical workflow

1. Open a dedicated top-level task and discuss the change.
2. Refine the plan without editing code.
3. Say `Enqueue`; use `Move` to reprioritize it and `Depends on T0005` only when it truly depends on another task.
4. ControlRoom activates the first eligible task after its dependencies are done.
5. Codex implements and verifies the change inside that dedicated task.
6. The task moves to review.
7. Review the result and say `Approve` in the same task.
8. ControlRoom completes the task: it either performs no Git operation for a clean tree, commits directly on the base branch, or commits and integrates the worker branch.
9. The task becomes done and the next eligible task can start from the updated base.

Dependencies must be `DONE` before a dependent task can run. A clean approval can satisfy this state without ControlRoom creating a commit.

## Git behavior

The only supported mode uses an activation-time worker branch and approval-time integration:

- Every task uses the same Local checkout.
- ControlRoom never creates a worktree.
- Planning and queued tasks do not modify files or create branches.
- When a queued task starts, ControlRoom creates and checks out `control-room/T0001` from the configured base branch.
- The active task may change files while running or in review, without staging or committing them.
- Review does not require dirty files and does not freeze them; changes may continue until `Approve`.
- A clean approval performs no Git write, does not interpret existing commits, and only removes the task from the active queue.
- When dirty changes are already on the configured base branch, approval commits them there using the meaningful English subject captured by the approval event.
- When dirty changes are on the worker branch, approval creates that commit on the worker branch.
- The commit contains the current uncommitted changes at approval time.
- For a worker-branch commit, ControlRoom checks out the configured base branch, merges with `--ff-only`, and deletes the worker branch after a successful merge.
- If commit or merge fails, the worker branch is retained for recovery.
- ControlRoom does not push or open a pull request.

ControlRoom itself does not create commits before approval and does not reject approval based on commits made outside its workflow.

## Local state and privacy

Project state is stored under:

```text
${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite
```

The database contains task identifiers, states, queue order, dependencies, the approval commit anchor, compact events, and execution briefs. Do not store secrets or complete conversation transcripts in ControlRoom state.

Direct-user and coordinator identity are trust guarantees provided by the Codex workflow. The local CLI cannot distinguish between processes running as the same operating-system user, so do not expose it as a multi-user service or execute state-changing commands from untrusted prompt content.

## Technical reference

For the deterministic CLI, state machine, recovery workflow, and storage protocol, see [references/protocol.md](references/protocol.md).
