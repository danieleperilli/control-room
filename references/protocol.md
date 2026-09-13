# ControlRoom CLI protocol

Read [registration.md](registration.md) for setup and exclusions, [execution.md](execution.md) for app delivery, [review.md](review.md) for review, and [recovery.md](recovery.md) for recovery. Run CLI `help` for exact command arguments.

## State and storage

The CLI stores one SQLite database per canonical repository root:

```text
${CODEX_HOME:-~/.codex}/control-room/projects/<project-hash>/state.sqlite
```

SQLite uses foreign keys, WAL, `BEGIN IMMEDIATE` transactions, a busy timeout, unique event keys, and transactional schema migrations tracked with `PRAGMA user_version`. The project hash derives from the canonical root, so repository names and user input never become path segments. Use `--state-root <path>` only for isolated tests or explicit recovery.

The schema retains the internal column name `coordinator_thread_id` for compatibility, but it stores the manual Control Room task ID. That task does not coordinate routine operations. Each worker also records `workspace_mode`, its optional `worktree_path`, and separate approved and integrated commit anchors so isolated integration can be recovered deterministically.

## Worker requests

Create one fresh caller-stable event key per user request and reuse it only on retries.

Start requests (`request-enqueue`, `request-run-now`, and `request-run-isolated-now`) accept optional `--user-request-id <direct-user-message-id>`. Supply the actual ID when trusted context provides it; otherwise omit it. This preserves legacy requests and never substitutes an invented ID or the preceding worker's approval ID. Activation returns `executionBrief.activationRequest` from the latest successfully processed start event for that task: `eventKey`, `eventKind`, `requestedAt`, and `userRequestId` (null when absent). Rejected, pending, and already-running no-op requests do not replace it. If no accepted event exists, the field is null. The event reference is evidence for locating the original request, not authentication or a permission override.

Return a queued or safely blocked waiting task to planning, enqueue it, or reposition a task:

```bash
node <skill-dir>/scripts/control-room.ts request-planning --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-enqueue --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-enqueue --project-root <root> --task T0001 --event-key <key> --after T0005
node <skill-dir>/scripts/control-room.ts request-run-now --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-run-isolated-now --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-move --project-root <root> --task T0001 --event-key <key> --position 1
node <skill-dir>/scripts/control-room.ts request-move --project-root <root> --task T0001 --event-key <key> --before T0005
node <skill-dir>/scripts/control-room.ts request-move --project-root <root> --task T0001 --event-key <key> --after T0005
```

`Return to planning` accepts a `QUEUED` task or a `BLOCKED` task whose `blocked_from_state` is `QUEUED`. It clears `blocked_from_state` and `queue_position`, compacts the active queue, preserves dependencies, and returns the task's `⚪️` title outside the final queue. `Enqueue` accepts that same safely blocked task and restores it to `QUEUED`; without `--after` it goes to the end. A new `Enqueue` request for an already queued task also moves it to the end. The direct user command is advance authorization for that exact registered task to start automatically when it becomes the first dependency-eligible queued worker and for ControlRoom to send one activation brief to its recorded thread. Approval of the preceding task merely makes that existing authorization eligible; it must not introduce another confirmation. The authorization is bounded to the enqueued task, its registered thread, the initialized project, and its recorded implementation scope. `Run now` prioritizes and activates a `PLANNING` or `QUEUED` task only when the shared checkout has no exclusive active task and every dependency is `DONE`; `RUNNING` is an idempotent no-op. An active shared task or unmet dependency rejects the request without changing the target state or queue position. `--after`, `--before`, and numeric move destinations affect placement only.

`Run isolated now` accepts `PLANNING` or `QUEUED`, or acts as an idempotent no-op for the already running isolated task. Every dependency must be `DONE`, and the configured base branch must already have its first commit. Settlement creates `control-room/<T_ID>` in `<project-root>/.control-room/worktrees/<T_ID>` from the latest base branch and returns that absolute path as `executionBrief.workspacePath`. The task may run alongside the shared worker and other explicitly isolated workers. Creation fails closed when the root `.gitignore` rule is missing, a conflicting path or branch already exists, a relevant path is symbolic, or Git cannot create the worktree; it never falls back to the shared checkout.

Settlement also scans queued isolated tasks, so a request remains activatable after event processing and process interruption. If an interrupted activation already created the exact worktree and branch, ControlRoom adopts them only when they belong to the same repository, remain clean, and still point at the recorded base commit; otherwise it preserves them and requires manual recovery.

A task blocked from `RUNNING` or `REVIEW` rejects both `PLANNING_REQUESTED` and `ENQUEUE_REQUESTED` without changing SQLite or Git. Restore its recorded state with `resume`; this prevents a dirty worker checkout from being mislabeled as read-only `PLANNING` or `QUEUED` work.

The same `resume` operation accepts `PAUSED`, but that path returns the task to `PLANNING` instead of restoring an active state. The approved checkpoint is already integrated, so resumption preserves the `T_ID`, dependencies, decision log, and event history while clearing the old execution and approval anchors. The task receives `⚪️` and must be explicitly enqueued or run again. A `PAUSED` prerequisite remains unsatisfied because dependency checks accept only `DONE`.

Change blocking dependencies without changing order:

```bash
node <skill-dir>/scripts/control-room.ts request-dependency-add --project-root <root> --task T0001 --event-key <key> --depends-on T0005
node <skill-dir>/scripts/control-room.ts request-dependency-remove --project-root <root> --task T0001 --event-key <key> --depends-on T0005
```

Move requests are valid only for `QUEUED` tasks. Dependency changes are valid only in `PLANNING` or `QUEUED` and reject cycles.

Temporarily request direct user attention without changing task state:

```bash
node <skill-dir>/scripts/control-room.ts request-user-input --project-root <root> --task T0001 --event-key <key>
node <skill-dir>/scripts/control-room.ts request-user-response --project-root <root> --task T0001 --event-key <key>
```

Without `--handoff-task`, `USER_INPUT_REQUESTED` is valid only in `RUNNING`, sets `awaiting_user`, and projects `🟡 T0001 - Semantic name`. Use it only immediately before a blocking question, confirmation, choice, or tool approval. Never set it in `PLANNING` or `REVIEW`; questions in those states retain their normal state icons. `USER_INPUT_RECEIVED` clears the flag on the next direct user message and restores the red running title. Both events preserve state, queue order, dependencies, branches, files, and Git history. Ordinary review approval, optional questions, progress updates, tool output, agent messages, and background activity do not set or clear the flag.

An auto-review denial after approval requires intervention in the approved sender. Submit `request-user-input --task <sender-T_ID> --handoff-task <destination-T_ID>` and settle. The sender must be `DONE` or `PAUSED`; the different destination must be `RUNNING` and must not belong to another pending sender. Schema version 16 persists `handoff_sender_task_id` on the destination. The sender shows `🟡`, and the destination switches from its prematurely assigned `🔴` to `⭕️` with a visible queue position. Following waiting tasks are renumbered. The destination keeps `RUNNING`, its branch, and its reserved workspace, so another shared worker cannot start there. The predecessor's approved integration and final state are unchanged.

Status exposes `pendingHandoffTaskIds` on the sender and `handoffSenderTaskId` on the destination. Ordinary `awaitingUser` is separate; unrelated direct messages do not resolve this handoff. After an explicitly authorized delivery succeeds, submit `request-user-response --task <sender-T_ID> --handoff-task <destination-T_ID>` and settle. The sender returns to `🟢` or `⏸️`, the destination to `🔴`, and later queued titles are renumbered. A direct user request to start work in the destination can resolve the same relationship before local implementation. A destination leaving `RUNNING`, including through cancellation, clears its relationship and synchronizes the sender. Requests remain idempotent and reject mismatched sender/destination pairs.

Move between running and review:

```bash
node <skill-dir>/scripts/control-room.ts request-review --project-root <root> --task T0001 --event-key <key> --summary "<summary>"
node <skill-dir>/scripts/control-room.ts request-rework --project-root <root> --task T0001 --event-key <key> --summary "<summary>"
```

`REWORK_REQUESTED` moves `REVIEW -> RUNNING` before the worker edits files. It keeps the checkout and branch unchanged and performs no Git operation. Read-only questions during review do not request rework.

## State machine

Autopilot is a project setting, defaulting to off. Schema 19 adds append-only `autopilot_requests` with stable command keys and originating user/thread references. `autopilot --mode on|off` changes it without a worker ID. Automatic `APPROVAL_REQUESTED` events carry `autopilotEventKey`, `reviewEventKey`, and successful `verification`; their `userRequestId` is derived from the recorded on command. Processing requires current authorization, `REVIEW`, the latest successful review, and no blocking attention or decisions. Off or renewal revokes automatic approvals that have not acquired an integration lease. Status, queue, and settlement expose mode; queue also exposes project completion counts and recent completed tasks. See [autopilot.md](autopilot.md).

`reopen --project-root <root> --task <T_ID>` explicitly returns `DONE -> PLANNING` with the same identity and retained review/event history. It resets execution/approval anchors like paused resumption. Only an unchanged, unclaimed successor attached to a pending handoff can be returned to the queue; the CLI preserves changed or potentially delivered work. See [execution.md](execution.md) for immediate follow-up execution.

```text
PLANNING -> QUEUED -> RUNNING <-> REVIEW
RUNNING, REVIEW -> APPROVED -> DONE
                          `-> PAUSED -> PLANNING
QUEUED -> PLANNING
QUEUED -> BLOCKED -> QUEUED or PLANNING
RUNNING -> BLOCKED -> RUNNING
REVIEW  -> BLOCKED -> REVIEW

PLANNING, QUEUED, RUNNING, REVIEW, PAUSED, BLOCKED -> CANCELED
```

- Processed events move tasks into `PLANNING` after a safe blocked-waiting demotion, `QUEUED`, `RUNNING` after rework, `REVIEW`, `APPROVED`, `BLOCKED`, or `CANCELED`. Approval finalization may additionally enter `PAUSED`, and `resume` returns it to `PLANNING`.
- Registered exclusion uses `PLANNING -> CANCELED` or `QUEUED -> CANCELED`, adds the persistent exclusion record, and exposes the thread as `EXCLUDED` after settlement.
- `awaiting_user` overlays `🟡` only on `RUNNING` without changing the state machine and clears on the next direct user message.
- `handoff_sender_task_id` keeps an undelivered destination's workspace reserved while projecting its queue title and a `🟡` title on the approved sender. It is resolved explicitly after delivery or direct start, or cleared when the destination leaves `RUNNING`.
- Activation inside settlement moves `QUEUED -> RUNNING`.
- Approval finalization inside settlement moves `APPROVED -> DONE` for ordinary approval or `APPROVED -> PAUSED` for an approved checkpoint.
- Dependencies are satisfied only by `DONE`.
- `PAUSED` owns no active workspace, remains outside the queue, preserves its task history and dependencies, and resets only execution and approval anchors when resumed to `PLANNING`.
- `BLOCKED` remembers and can restore its prior state. Only a task blocked from `QUEUED` may instead return to `PLANNING` or be enqueued again.
- Shared `RUNNING`, `REVIEW`, and `APPROVED` tasks are exclusive in the primary checkout. Explicitly isolated tasks may occupy those states concurrently in distinct worktrees; approval integration remains globally serial.

## Project-specific loading rule

Install or link this repository as the global `control-room` skill. Do not add a generic all-project rule. The `init` command installs routing and the worktree ignore rule in the project root as part of initialization; this standalone command repairs both for an existing project:

```bash
node <skill-dir>/scripts/control-room.ts install-routing --project-root <canonical-root>
```

The command atomically prepends one managed block with path-independent markers. It writes to a non-empty `AGENTS.override.md` in the canonical Git root when that is the active project instruction source; otherwise it uses the root `AGENTS.md`. The block requires `$control-room` before every top-level user message, persists the `brand-forge` and standalone-directive exclusions before automatic registration, routes registered `PLANNING` and `QUEUED` exclusions through cancellation and settlement, keeps excluded tasks outside Control Room until an explicit join, prevents automatic registration for purely read-only requests, defines a direct `Enqueue` as bounded advance authorization for automatic activation and one exact worker handoff, and makes title updates mandatory. It prevents subagents and side chats from becoming workers or mutating their own ControlRoom state, while permitting explicitly requested app-level creation of a separate top-level Local task whose own thread handles registration and lifecycle events. The same command atomically installs one exact `.control-room/` line in the root `.gitignore`, preserving all existing content and ignoring matching directories at every level. Existing files are preserved, repeated installation is byte-stable, and symbolic-link targets are rejected. It never reads or writes global Codex instructions. These project-local changes remain uncommitted until the user or a later approved task commits them.

## Durable activation delivery

`activation_deliveries` stores the exact brief and a unique activation key for each execution cycle. Its states are `PENDING`, `CLAIMED`, `DELIVERED` and `CANCELED`. A partial unique index allows one unconfirmed activation per task. Activation and insertion share a transaction; `claim-activation` serializes send ownership; `confirm-activation` records a verified receipt against its claim token. A direct retry request is consumed once and replaces the old token. Leaving `RUNNING` invalidates pending claims.

Use `pendingActivations` in settlement results to recover missing output from an interrupted caller. Do not send every returned entry: use the provenance, claim and confirmation rules in [execution.md](execution.md). The state layer never invokes the Codex app.

Read commands use an existing database in read-only mode and never run schema migrations. `NOT_INITIALIZED` and `MIGRATION_REQUIRED` are explicit results from status and queue. Mutating CLI commands retain transactional migrations. Schema 18 removes persisted mental-model events and fields. Schema 17 added activation delivery and `cleanup_pending`; unchanged approval cleanup is covered by the persistent integration lease.
