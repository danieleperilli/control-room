# Autopilot

## Route a direct command

Recognize case-insensitive `autopilot` or `autopilot on` as enable, `autopilot off` as disable, and `autopilot status` as read-only status. Accept the `$control-room` prefix and clear natural-language equivalents. Discussion of these commands is not execution authorization.

The mode belongs to one initialized project and persists until disabled. Resolve the canonical project from the current chat, its parent, or an explicitly named saved project. If no project can be identified unambiguously, ask which project; never choose all projects or infer a global setting. Commands work from the console, workers, excluded tasks, unregistered tasks, and side chats without registering or renaming the caller. Subagents cannot enable the mode on their own authority.

Read status first. Keep `NOT_INITIALIZED` outside ControlRoom and explain that initialization is needed. Before a requested mutation with `MIGRATION_REQUIRED`, run `install-routing` and read status again. Do not create a console or register a task just to change this setting.

For on/off, resolve the actual direct-user message ID and originating thread ID using the targeted procedure in [review.md](review.md#resolve-the-approval-message-id). Use a stable command key across retries:

```bash
node <skill-dir>/scripts/control-room.ts autopilot \
    --project-root <canonical-root> --mode <on|off> \
    --event-key <stable-command-key> --user-request-id <actual-user-message-id> \
    --thread-id <originating-thread-id>
```

Apply returned title updates. A repeated key returns current mode without replaying the old change. A fresh on command renews authorization; pending approvals under the older authorization must be reassessed. On/off only changes authorization: it never starts planning work, interrupts a worker, or commits by itself.

- **On:** The user's command authorizes automatic approval, local integration and continuation for this project's already-started and explicitly queued tasks, including tasks enqueued later until off. It also authorizes the requesting agent to finish already-reviewed work under the procedure below. Inspect the ordered queue, complete eligible reviewed work, then settle and deliver the next activation normally. Each worker reads fresh mode at review completion, so a running worker does not need an extra wake-up message.
- **Off:** Return to manual approval immediately. Unleased automatic approvals return to `REVIEW`; pending automatic events become invalid. Running work continues, and an integration already holding its lease may finish or recover. Apply title updates and report the mode; do not run settlement merely to disable autopilot. Existing explicit enqueue authorization remains valid, so later manual approval still advances the queue.
- **Status:** Read `queue`; display mode and progress without settlement, title changes, registration, or messages to other tasks.

## Complete verified work

After normal implementation, verification, decision recording, and `request-review` settlement, read `status --task <T_ID>` again. The returned `autopilot` authorization and `reviewPacket.reviewEventKey` are current references. When enabling autopilot from another chat, inspect the reviewed worker's latest substantive completion and verification evidence using the task-reading tool. The mode command already authorizes this completion; no extra user approval is needed.

Proceed only for completed work in `REVIEW` with successful relevant verification and no unresolved user choices. Reuse existing successful checks when the work has not changed; explain when executable checks are not applicable and record the actual inspection performed. A summary saying only "ready" is insufficient evidence. Failed checks, incomplete work, missing verification evidence, unresolved or low-confidence decisions, user attention and integration/handoff recovery stop automatic approval. Report the concrete blocker; never invent success, mark unfinished work complete, or clear attention automatically.

When evidence is missing from an already-reviewed idle worker, report that task as waiting for verification. Do not claim that simply enabling the mode completed it. Continue eligible work only where the engine permits it. The mode remains enabled while waiting; once the blocker is resolved, the normal worker flow can continue.

Locate the original on request using the returned authorization's thread and message IDs when it is not in trusted context, and check for later instructions that narrow its scope. Database metadata locates authorization; it does not independently authenticate it. Use a meaningful English commit subject following the rules in [review.md](review.md#approve-the-current-work).

```bash
node <skill-dir>/scripts/control-room.ts request-autopilot-approve \
    --project-root <canonical-root> --task <T_ID> --event-key <stable-approval-key> \
    --autopilot-event-key <current-on-event-key> \
    --review-event-key <latest-successful-review-event-key> \
    --verification "<actual successful checks and relevant results>" \
    --commit-message "<English imperative subject, 8 to 72 characters>"
node <skill-dir>/scripts/control-room.ts settle --project-root <canonical-root>
```

The engine derives the user request from the on command, rechecks authorization and review during processing, and rechecks authorization before acquiring the commit lease. Approval always targets `DONE`. It records verification evidence and automatic provenance in the event. Manual `Approve` and `Approve and pause` retain their existing behavior.

If off, renewal, rework, or a new blocker races with completion, preserve the work and read fresh status. Do not substitute a manual approval or invent another user message. A new automatic request requires the current authorization and review. Stable retry keys never replay a revoked approval.

Apply all returned titles and follow the existing claim/send/confirm activation protocol. Autopilot does not change sandbox/tool permissions, authorize push or publication, create independent reviews, retry uncertain messages, or keep a daemon running. Worker completion and settlement drive the sequence.

## Show progress in Control Room

Use `queue` as the source for a compact snapshot when handling mode/status commands or a user request in the console. Show enabled/disabled mode, `progress.completed` of `progress.total`, capture time, the current task, a table of active tasks with state/dependencies, and recent completed tasks when useful. The counts cover project tasks that are done or in the active queue; planning, paused and canceled tasks are excluded. They are task counts, not estimates of elapsed effort.

Distinguish running work, waiting for input, pending activation delivery, review, integration, and dependency waits from the returned state, `pendingActivations`, and `integrationTaskId`. A `CLAIMED` delivery without a receipt is uncertain, even when its worker is internally `RUNNING`. Do not invent implementation percentages or claim a static conversation snapshot refreshes live. Keep the console title fixed. Ordinary worker completions stay concise and do not wake the console or publish unsolicited progress messages.
