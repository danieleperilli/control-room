# Execution and task delivery

## Identify roles and boundaries

- Keep `⚫️ Control Room` fixed as a manual console. It receives no routine messages and does not run in the background.
- Let any worker or the manual console submit a valid event, then invoke the deterministic `settle` command in that same turn.
- Treat the ControlRoom engine as the only queue and state writer. A task triggers the engine but does not edit SQLite directly.
- Keep `PLANNING`, `QUEUED`, and `PAUSED` read-only on the configured base branch.
- Allow only a `RUNNING` or `REVIEW` task to modify files, and only inside the `workspacePath` returned by its activation brief.
- Keep normal tasks exclusive in the shared checkout. Allow additional tasks to run concurrently only after the user explicitly requests isolated execution for each one.
- Create a worker branch only when settlement activates a task. Normal activation switches the shared checkout; isolated activation creates `<project-root>/.control-room/worktrees/<T_ID>` on the same `control-room/<T_ID>` branch without touching the shared checkout.
- Record macro implementation decisions append-only while the task is in `PLANNING`, `QUEUED`, or `RUNNING`.
- Scope all state to the canonical local repository root.

Read [protocol.md](protocol.md) for unfamiliar CLI event contracts, [review.md](review.md) for decisions and review, and [recovery.md](recovery.md) only when a recovery is required.

## Title tasks

Use every returned title exactly:

- `RUNNING` while awaiting direct user input: `🟡 T0001 - Semantic name`
- Approved sender awaiting intervention for an undelivered activation: `🟡 T0001 - Semantic name`
- Destination awaiting that activation handoff: its `⭕️` queue title and visible position
- `PLANNING`: `⚪️ T0001 - Semantic name`
- `QUEUED`: concatenate one circled glyph per decimal digit, such as `⭕️ ① T0001 - Semantic name` or `⭕️ ①⓪ T0010 - Semantic name`
- `RUNNING`: `🔴 T0001 - Semantic name`
- `REVIEW`: `💪 T0001 - Semantic name`
- `APPROVED`: `🟢 T0001 - Semantic name`
- `PAUSED`: `⏸️ T0001 - Semantic name`
- `DONE`: `🟢 T0001 - Semantic name`
- `BLOCKED`: `❌ T0001 - Semantic name`
- `CANCELED`: `Semantic name`, with every ControlRoom icon, queue marker, and task ID removed

The ordinary `🟡` marker is a temporary presentation override backed by `awaiting_user` and is valid only while the underlying state is `RUNNING`; it does not change the underlying task state, queue order, branch, or Git behavior. A failed approval handoff has a separate persisted relationship: the sender remains `DONE` or `PAUSED` but shows `🟡`, and its undelivered destination retains `RUNNING` and its reserved workspace but shows `⭕️`. The queue marker counts both `QUEUED` tasks and these undelivered destinations. Other active tasks retain internal order without consuming a visible number. `PAUSED` remains outside the active queue. Persist only numeric `queue_position` and the undecorated semantic name.

After every settlement, apply every returned `titleUpdates` entry with the Codex app title tool before sending the final response; do not rely on a worker to rename itself. The engine emits only tasks whose projected title may have changed, including every queued task whose visible position changed. Do not resubmit unchanged titles from the final `queue`. A task returned to `PLANNING` must receive its `⚪️` title. `PAUSED` and `DONE` normally receive `⏸️` and `🟢`; use the returned `🟡` override while they own a pending handoff. A `CANCELED` task must be reset to its semantic name only. Retry one failed title update once, then report the exact unsynchronized task instead of claiming success. For explicit title recovery, read the queue and any completed sender identified by `handoffSenderTaskId`, then apply their projected titles.

When controlling Chrome for a worker, name the browser session or tab group `🤖 <T_ID>`, such as `🤖 T0001`.

## Handle natural commands

Use English as the canonical command language and recognize equivalent intent in other languages:

- `Return to planning`: submit `PLANNING_REQUESTED`. Accept a `QUEUED` task or a `BLOCKED` task whose recorded prior state is `QUEUED`; settlement removes its queue position, preserves dependencies, and returns the `⚪️` title.
- `Enqueue`: submit `ENQUEUE_REQUESTED`. The direct user command is advance authorization for that exact registered task to start automatically when it later becomes the first dependency-eligible queued worker, including one activation brief to its recorded thread. Do not ask for another confirmation merely because approval of a different task frees the queue. This deferred authorization never covers another task, thread, project, or implementation scope. A new request for an already queued task moves it to the end. A `BLOCKED` task whose recorded prior state is `QUEUED` also returns to the end of the queue with its dependencies unchanged.
- `Enqueue after T0005`: submit the same event with `--after T0005`; this changes placement only and also accepts a safely blocked waiting task.
- `Run now`: submit `RUN_NOW_REQUESTED`. Accept only `PLANNING`, `QUEUED`, or the idempotent `RUNNING` no-op. Settlement prioritizes and activates the task only when no shared task is `RUNNING`, `REVIEW`, or `APPROVED` and every dependency is `DONE`; otherwise reject without changing its state or queue position. Explicit isolated workers do not occupy the shared checkout.
- `Run isolated now`: submit `RUN_ISOLATED_NOW_REQUESTED`. Accept only `PLANNING`, `QUEUED`, or the idempotent already-isolated `RUNNING` no-op. Require every dependency to be `DONE` and an existing first commit on the configured base branch. Settlement creates `<project-root>/.control-room/worktrees/<T_ID>` and activates the task there immediately even while shared or other isolated tasks are active. Never infer this mode from component paths and never fall back to the shared checkout if worktree creation fails.
- `Move first`, `Move to 3`, `Move before T0005`, or `Move after T0005`: submit `MOVE_REQUESTED` with the matching destination.
- `Depends on T0005`: submit `DEPENDENCY_ADD_REQUESTED`.
- `Remove dependency T0005`: submit `DEPENDENCY_REMOVE_REQUESTED`.
- `Independent review`: accept only in `REVIEW` after the user explicitly chooses it. Run the single fresh-context, read-only reviewer described in [review.md](review.md) without changing ControlRoom state.
- `Approve`: follow [Approve the current work](review.md#approve-the-current-work), including the required message ID, commit-subject limits and complete command. Then apply the returned titles and deliver any pending activation as described below.
- `Approve and pause`: follow the same [approval procedure](review.md#approve-the-current-work) using `request-approve-and-pause`; settlement targets `PAUSED` with `⏸️` and leaves dependents unsatisfied.
- `Resume`: for `PAUSED`, run `resume` to return the same `T_ID` to `PLANNING`, preserve dependencies and review history, reset the execution and approval anchors for the next checkpoint, apply the returned `⚪️` title, and settle. For `BLOCKED`, retain the existing recovery behavior that restores its recorded prior state.
- `Cancel`: submit an idempotent cancellation request from the current worker.
- `$control-room exclude`: persist an unregistered opt-out, or submit `request-exclude` and settle for a `PLANNING` or `QUEUED` worker. Apply the undecorated canceled title and every renumbered queued title before continuing outside Control Room.
- `Status`: read the current task snapshot.
- `Queue status` or `$control-room queue`: read the project queue.
- `$control-room doctor`: diagnose state and blockers without registration, repairs or settlement.
- `$control-room help`: show commands without changing state.

From a worker, return-to-planning, resume, run-now, run-isolated-now, move, and dependency commands target that task. From the manual console, require an explicit target such as `Return T0003 to planning`, `Resume T0003`, `Run T0003 now`, `Run T0003 isolated now`, `Move T0003 before T0005`, or `Make T0003 depend on T0005`. Moving never changes dependencies, and dependency changes never alter queue order.

Reject `Return to planning` and `Enqueue` when `BLOCKED` records `RUNNING` or `REVIEW` as its prior state. Those tasks may own a worker branch and uncommitted changes, so use the lower-level `resume` operation to restore the recorded state instead of demoting them into a read-only state. A `PAUSED` task has already integrated its approved checkpoint and uses that same operation to return safely to `PLANNING`.

Generate one caller-stable event key for each user request and reuse it only for retries of that same request. A later direct command gets a new key.

For `request-enqueue`, `request-run-now`, and `request-run-isolated-now`, include `--user-request-id <direct-user-message-id>` when that ID is available from trusted context. Omit it when unavailable; never invent an ID or substitute the approval message from a different task. The activation brief returns the accepted start event as `activationRequest`, including its event key, kind, timestamp, and original user-request ID when recorded. This is a reference to the request, not independent proof of user authorization.

## Signal blocking user input

Use the ordinary attention marker only when a `RUNNING` worker cannot make meaningful progress without a direct answer, confirmation, choice, or tool approval from the user. Never set it in `PLANNING` or `REVIEW`; ask any question there without replacing the state icon. Do not use it for optional questions, routine progress updates, or the ordinary approval expected after entering `REVIEW`. Failed activation delivery after approval uses the paired handoff marker described below.

Before ending the turn with a blocking request, submit and settle:

```bash
node <skill-dir>/scripts/control-room.ts request-user-input \
    --project-root <canonical-root> --task <T_ID> --event-key <key>
```

Apply the returned `🟡` title before presenting the blocking question or approval request. At the start of the next direct user turn, if status returns `awaitingUser: true`, submit `request-user-response` with a fresh caller-stable event key and settle before processing the complete response. This restores the title for the unchanged underlying state, normally `🔴` for `RUNNING`. Do not clear attention for agent messages, activation briefs, tool output, automatic continuations, or background activity. If the response does not resolve the blocker, request attention again before ending that turn.

If an activation message is denied after the sender's approval, mark the **approved sender** and its destination together before asking for intervention:

```bash
node <skill-dir>/scripts/control-room.ts request-user-input \
    --project-root <canonical-root> --task <sender-T_ID> \
    --handoff-task <destination-T_ID> --event-key <key>
node <skill-dir>/scripts/control-room.ts settle --project-root <canonical-root>
```

The sender must be `DONE` or `PAUSED`, and the distinct destination must still be `RUNNING`. Apply every title update: the sender shows `🟡`, the destination shows `⭕️` with its position, and the following queue titles are renumbered. The destination was marked `🔴` before delivery; the handoff marker corrects that presentation without releasing its reserved workspace. Status exposes `pendingHandoffTaskIds` on the sender and `handoffSenderTaskId` on the destination. These are separate from ordinary `awaitingUser`, so a direct message must not clear them automatically.

## Settle and deliver activations

After submitting a state-changing event, run `settle --project-root <canonical-root>` in the same task. Settlement processes pending events, finalizes approvals, activates requested isolated tasks and the next eligible shared task. It does not wake the manual console. Apply all returned `titleUpdates` before the final response; surface rejected events, integration failures or recovery requirements.

Each activation stores an immutable execution brief in SQLite in the same transaction that sets the task to `RUNNING`. Its `activationKey` identifies that execution cycle. Settlement also returns `pendingActivations` until delivery is confirmed or the execution is superseded. Deduplicate fresh `activation.executionBrief`, `isolatedActivations[].executionBrief` and pending entries by `activationKey`.

A direct enqueue is advance authorization for that exact task's eventual start and one handoff to its recorded thread; completion of the preceding task makes this existing authorization eligible. Before sending, use `activationRequest` to locate the original direct start request with the app's task-reading tool when it is not already in trusted context. Read relevant destination or manual-console turns, paginate as needed, and check later changes or cancellation. The stored event and an agent summary are references for finding the request, not authentication or a permission override. Never invent provenance for legacy requests with a null request ID.

For each authorized activation:

1. Verify the task, registered thread, canonical root and workspace against current task state. A worktree is used only for its explicit isolated request.
2. Claim it with `claim-activation --project-root <root> --activation-key <key>`. The CLI atomically reserves delivery and returns `claimed: true`, a `claimToken` and the stored brief. Only this successful claimant may send. A `claimed: false` result is not permission to send.
3. If the target is the caller, continue locally and confirm the direct start using its trusted user-request reference. Otherwise send the claimed brief once to its exact thread, include `activationKey`, preserve `activationRequest`, and explain its connection to the original request. Do not message the manual console.
4. After an unequivocally successful send, run `confirm-activation --project-root <root> --activation-key <key> --claim-token <token> --receipt <app-message-or-operation-reference>`. Store only a compact reference. Do not invent a successful receipt when the tool result is ambiguous. The receiving worker may begin from the authorized brief; its sender owns confirmation.
5. If the worker already progressed beyond `RUNNING`, confirmation can return `ACTIVATION_SUPERSEDED`; do not resend an obsolete execution. Pending delivery records are canceled on leaving `RUNNING`. A delivered record is retained, and matching confirmation retries are idempotent.

The worker uses `workspacePath` for every repository operation and `projectRoot` for state commands.

### Uncertain or denied deliveries

A `CLAIMED` entry without a receipt may already have reached the destination. Settlement and `doctor` expose it but never retry it automatically. Inspect the destination history for the exact activation key. If delivery is verified, confirm it using the persisted claim token and actual message reference; do not send a duplicate. If the user explicitly starts work directly in the destination, that direct-start request is a valid receipt for the existing execution.

If authorization cannot be established or auto-review rejects the send, stop delivery. Do not retry with different wording, another tool or weaker approval settings. Report the exact target and actual reason. When an approved predecessor owns this handoff, record `request-user-input --task <sender-T_ID> --handoff-task <destination-T_ID>`, settle, and apply the sender's `🟡`, destination's `⭕️` and renumbered titles. Preserve the destination's reserved workspace. Without an approved sender, report the pending delivery in the caller without inventing a sender identity.

A new direct user authorization permits one retry of the exact unresolved handoff. Verify current task/thread/workspace and original scope, then use `claim-activation --activation-key <key> --retry-user-request-id <new-direct-message-id>`. The ID is consumed once, a fresh claim token invalidates old confirmations, and a repeated retry request cannot send again. An ambiguous or denied retry stays unconfirmed and ends this attempt; never loop on retries.

After confirmation of a successful delivery or verified direct start, clear any existing sender/destination relationship with `request-user-response --task <sender-T_ID> --handoff-task <destination-T_ID>` and settle. A sender reply that does not authorize or establish delivery must not clear those markers. Ordinary direct replies clear only ordinary `awaitingUser` attention.

The CLI manages durable state and concurrent claims; app delivery and user-message provenance remain the calling agent's responsibility. No database row authorizes a new task, a new scope, or an unrelated message.
