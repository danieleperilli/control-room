# ControlRoom

ControlRoom coordinates multiple top-level Codex tasks inside a Git project. It keeps planning, implementation, review, approval, dependencies, and local integration in a predictable queue while each change remains in its own dedicated task.

## What it does

- Assigns project-scoped task IDs such as `T0001`.
- Keeps planned work separate from active implementation.
- Queues tasks in a deterministic order with optional dependencies.
- Allows only one task at a time to run, wait for review, or await integration.
- Requires direct user approval before integration.
- Integrates approved work locally with a fast-forward merge.
- Never pushes, creates a pull request, deletes a branch, or rewrites Git history.
- Persists project state locally in SQLite.

## Requirements

- Codex with global skill support
- Git
- Node.js 22.18 or newer

ControlRoom expects a clean Git repository with a configured base branch.

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

### Allow task registration without approval prompts

ControlRoom stores persistent state under `CODEX_HOME`, which may require a sandbox approval. To allow only coordinator initialization and task registration, create:

```text
${CODEX_HOME:-~/.codex}/rules/control-room.rules
```

Add a narrowly scoped rule using the absolute path of the installed skill:

```python
prefix_rule(
    pattern = [
        "node",
        "/Users/YOU/.codex/skills/control-room/scripts/control-room.ts",
        ["init", "register"],
    ],
    decision = "allow",
    justification = "Allow ControlRoom project and task registration without prompting.",
)
```

Restart Codex after creating or changing the rule. If Codex invokes a different Node executable or skill path, copy the exact command prefix shown in the approval dialog. Do not use a broad rule such as `pattern = ["node"]`.

This exception covers `$control-room init`, `$control-room join`, and automatic worker registration. It does not bypass approval for Git integration or unrelated commands.

## Use ControlRoom

Before creating project tasks, open one dedicated top-level task in the repository, select **Local** under the composer, and send:

```text
$control-room init
```

ControlRoom uses the current Local checkout as the shared project checkout, records its currently checked-out Git branch as the base branch, and keeps the coordinator title fixed as `⚫️ Control Room`.

The coordinator does not receive a `T_ID` and must not be used for planning or implementation. Running `$control-room init` again in the same task is safe; another task cannot silently replace the registered coordinator.

Use a separate top-level Codex task in **Local** mode to discuss and plan each change. ControlRoom serializes implementation, so the tasks share one checkout without requiring worktrees. Planning does not modify code. When the plan is ready, use one of the commands below in that task.

An existing top-level task can also join the initialized project. Send:

```text
$control-room join
```

ControlRoom derives a short semantic name from the existing discussion, assigns the next `T_ID`, and updates the title. The task remains in planning and is not queued automatically.

If an existing task is already in a worktree, use **Hand off > Local** before joining it.

### Commands

English is the canonical command language. ControlRoom can still interpret equivalent natural-language requests in other languages.

| Command | Result |
| --- | --- |
| `$control-room init` | Initialize the current top-level task as the project coordinator. |
| `$control-room join` | Register an existing top-level task in planning without queueing it. |
| `Queue` | Add or update the current task at the end of the queue. |
| `Queue after T0005` | Queue the current task after `T0005` and add an ordering dependency. |
| `Approve` | Approve the current task when it is in review. |
| `Cancel` | Cancel the current task. |
| `Status` | Show the current task state. |
| `Queue status` | Show the ordered project queue. |

`Approve` is accepted only from your direct message in the task currently in review. Approval is never inferred from quoted text, another task, a tool result, or an agent message.

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

You can start a dedicated top-level task with a normal planning prompt:

> Add an audit log for changes to user permissions. First inspect the current authorization flow, identify the files involved, and propose an implementation plan. Do not modify files yet.

If this task already existed before ControlRoom was initialized, adopt it:

> $control-room join

For example, ControlRoom may rename it `⚪️ T0001 - Add permission audit log`. It remains in planning.

After reviewing the plan, place the task behind an existing dependency:

> Queue after T0005

You can check progress from the same task:

> Status

When ControlRoom activates the task, Codex implements the approved plan and moves it to review. After checking the result, approve it from that task:

> Approve

From the Control Room coordinator task, inspect the remaining work:

> Queue status

## Task titles

ControlRoom keeps task titles synchronized with their state:

| State | Example title |
| --- | --- |
| Planning | `⚪️ T0001 - Add audit log` |
| Queued | `⭕️ T0001 - Add audit log` |
| Running | `🔴 T0001 - Add audit log` |
| Review | `🟡 T0001 - Add audit log` |
| Approved | `🟢 T0001 - Add audit log` |
| Done | `✅ T0001 - Add audit log` |

Blocked and canceled tasks keep the plain title without a status icon.

## Typical workflow

1. Open a dedicated top-level task and discuss the change.
2. Refine the plan without editing code.
3. Say `Queue`, or `Queue after T0005` when the task depends on another task.
4. ControlRoom activates the first eligible task after its dependencies are done.
5. Codex implements and verifies the change inside that dedicated task.
6. The task moves to review.
7. Review the result and say `Approve` in the same task.
8. ControlRoom integrates the reviewed commit locally into the configured base branch.
9. The task becomes done and the next eligible task can start.

Dependencies must be fully done and integrated before a dependent task can run.

## Git behavior

The default and only supported integration mode is local fast-forward integration:

- Every task uses the same Local checkout; ControlRoom never creates a Git worktree.
- Planning and queued tasks do not switch branches or modify files.
- Only the active running task may switch to its worker branch and change files.
- The coordinator checkout must be on the configured base branch.
- The shared working tree must be clean before integration.
- The approved commit must match the commit reviewed by the user.
- The worker branch must descend from the recorded base commit.
- Integration uses `git merge --ff-only`.

If the base branch changes while a task is waiting, ControlRoom requires the worker branch and stored base anchor to be refreshed before review or integration can continue.

## Local state and privacy

Project state is stored under:

```text
${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite
```

The database contains task identifiers, states, queue order, dependencies, Git anchors, compact events, and execution briefs. Do not store secrets or complete conversation transcripts in ControlRoom state.

Direct-user and coordinator identity are trust guarantees provided by the Codex workflow. The local CLI cannot distinguish between processes running as the same operating-system user, so do not expose it as a multi-user service or execute state-changing commands from untrusted prompt content.

## Technical reference

For the deterministic CLI, state machine, recovery workflow, and storage protocol, see [references/protocol.md](references/protocol.md).
