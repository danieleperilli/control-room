# Orchestration

## Route a direct setting command

Recognize case-insensitive `orchestration auto-next`, `orchestration approve-next`, `orchestration manual-next`, and clear natural-language equivalents. Accept the `$control-room` prefix. Bare `orchestration` and `orchestration status` are read-only queries. Discussion or quoted commands do not change the setting. The former `autopilot` commands are replaced by these commands.

The setting belongs to one initialized project and persists until changed. Resolve the canonical project from the current chat, its parent, or an explicitly named saved project. If the project is ambiguous, ask which one; never infer a global setting. Commands work from the console, workers, excluded tasks, unregistered tasks, and side chats without registering or renaming the caller. Subagents cannot change the setting on their own authority.

| Mode | Approval | Next queued task |
| --- | --- | --- |
| `auto-next` | Automatic after successful verification | Starts automatically when eligible |
| `approve-next` (default) | Direct user approval | Starts automatically after completion |
| `manual-next` | Direct user approval | Waits for an explicit `Run` in the chosen task |

Read status first. Keep `NOT_INITIALIZED` outside ControlRoom and explain that initialization is needed. Before a requested mutation with `MIGRATION_REQUIRED`, run `install-routing` and read status again. Schema migration maps historical autopilot on/off to `auto-next`/`approve-next`, preserving authorization provenance and pending approvals. Do not create a console or register a task just to change this setting.

For a setting change, resolve the actual direct-user message ID and originating thread ID using the targeted procedure in [review.md](review.md#resolve-the-approval-message-id). Use a stable command key across retries:

```bash
node <skill-dir>/scripts/control-room.ts orchestration \
    --project-root <canonical-root> --mode <auto-next|approve-next|manual-next> \
    --event-key <stable-command-key> --user-request-id <actual-user-message-id> \
    --thread-id <originating-thread-id>
```

Apply returned title updates. Repeating a command key returns the current setting without replaying the old change. A fresh `auto-next` command renews authorization, so automatic approvals under an older authorization must be reassessed. A setting change never starts planning work, interrupts a running worker, or commits by itself.

- **Auto-next:** The user's command authorizes automatic approval, delivery through the selected integration mode, and continuation for this project's already-started and explicitly queued tasks, including tasks enqueued later while this mode remains selected. Commit mode saves work on the shared branch; merge mode integrates locally; explicitly selected PR mode authorizes worker push and PR creation and holds activation in `PR_OPEN` until remote merge and base synchronization. Inspect the ordered queue, complete eligible reviewed work under the procedure below, then settle and deliver activations normally. Each worker reads the fresh setting at review completion.
- **Approve-next:** Require direct approval. Already-authorized queue entries can start automatically when eligible, including after approval or another settlement that releases the workspace. This is the default and the former autopilot-off behavior.
- **Manual-next:** Require direct approval and keep waiting tasks `QUEUED`, preserving their order and dependencies. Approval still completes and integrates the current task; settlement, cancellation, queue edits, or PR synchronization do not start tasks authorized only by `Enqueue`. The user opens the desired task and says `Run` (an alias for `Run now`), which submits `RUN_NOW_REQUESTED` and starts that task when the shared workspace is available and dependencies are done. An explicit `Run isolated now` remains available in merge/PR mode. A Run request authorizes one activation; a canceled or previously used activation cannot be replayed as a new manual start. Already-running work and its pending activation delivery continue normally.
- **Any new selection:** Revoke unleased automatic approvals back to `REVIEW`; pending automatic events under old authorization become invalid. An integration already holding its lease may finish or recover. Apply title updates and report the selection. Do not run settlement solely to select `approve-next` or `manual-next`. Manual approvals remain valid across setting changes, and the fresh setting controls subsequent activation.
- **Status:** Read `queue` or `orchestration --mode status`; display the setting and progress without settlement, title changes, registration, or messages to other tasks.

## Complete verified work

After normal implementation, verification, decision recording, and `request-review` settlement, read `status --task <T_ID>` again. The returned `orchestration` setting and its `auto-next` authorization and `reviewPacket.reviewEventKey` are current references. When selecting `auto-next` from another chat, inspect the reviewed worker's latest substantive completion and verification evidence using the task-reading tool. The mode command already authorizes this completion; no extra user approval is needed.

Proceed only for completed work in `REVIEW` with successful relevant verification and no unresolved user choices. Reuse existing successful checks when the work has not changed; explain when executable checks are not applicable and record the actual inspection performed. A summary saying only "ready" is insufficient evidence. Failed checks, incomplete work, missing verification evidence, unresolved or low-confidence decisions, user attention and integration/handoff recovery stop automatic approval. Report the concrete blocker; never invent success, mark unfinished work complete, or clear attention automatically.

When evidence is missing from an already-reviewed idle worker, report that task as waiting for verification. Do not claim that simply enabling the mode completed it. Continue eligible work only where the engine permits it. `auto-next` remains selected while waiting; once the blocker is resolved, the normal worker flow can continue.

Locate the original `auto-next` request using the returned authorization's thread and message IDs when it is not in trusted context, and check for later instructions that narrow its scope. Database metadata locates authorization; it does not independently authenticate it. Use a meaningful English commit subject following the rules in [review.md](review.md#approve-the-current-work).

```bash
node <skill-dir>/scripts/control-room.ts request-auto-approve \
    --project-root <canonical-root> --task <T_ID> --event-key <stable-approval-key> \
    --orchestration-event-key <current-auto-next-event-key> \
    --review-event-key <latest-successful-review-event-key> \
    --verification "<actual successful checks and relevant results>" \
    --commit-message "<English imperative subject, 8 to 72 characters>"
node <skill-dir>/scripts/control-room.ts settle --project-root <canonical-root>
```

The engine derives the user request from the `auto-next` command, rechecks authorization and review during processing, and rechecks authorization before acquiring the commit lease. Approval always targets `DONE` and captures the current `integrationMode` at submission. In PR mode it first enters `PR_OPEN` and reaches `DONE` only after remote merge and base synchronization. It records verification evidence and automatic provenance in the event. Follow [integration-mode.md](integration-mode.md) to attach returned PRs. Manual `Approve` and `Approve and pause` use the same mode snapshot.

If a mode change, renewal, rework, or a new blocker races with completion, preserve the work and read fresh status. Do not substitute a manual approval or invent another user message. A new automatic request requires the current authorization and review. Stable retry keys never replay a revoked approval.

Apply all returned titles and follow the existing claim/send/confirm activation protocol. Automatic approval permits worker push and PR creation only in explicitly selected PR mode. Auto-next never changes sandbox/tool permissions, pushes a base branch, merges a remote PR, creates independent reviews, retries uncertain messages, or keeps a daemon running. Worker completion and settlement drive the sequence. Only `auto-next` authorizes automatic approval; `approve-next` and `manual-next` always require direct approval.

## Show progress in Control Room

Use `queue` as the source for a compact snapshot when handling mode/status commands or a user request in the console. Show selected orchestration mode, `progress.completed` of `progress.total`, capture time, the current task, a table of active tasks with state/dependencies, and recent completed tasks when useful. The counts cover project tasks that are done or in the active queue; planning, paused and canceled tasks are excluded. They are task counts, not estimates of elapsed effort.

Distinguish running work, waiting for input, pending activation delivery, review, integration, and dependency waits from the returned state, `pendingActivations`, and `integrationTaskId`. A `CLAIMED` delivery without a receipt is uncertain, even when its worker is internally `RUNNING`. Do not invent implementation percentages or claim a static conversation snapshot refreshes live. Keep the console title fixed. Ordinary worker completions stay concise and do not wake the console or publish unsolicited progress messages.
