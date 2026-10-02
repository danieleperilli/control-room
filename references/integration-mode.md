# Integration mode

## Select or inspect a mode

Recognize direct, case-insensitive `PR mode`, `merge mode`, `commit mode`, and `current mode`, with an optional `$control-room` prefix or clear language equivalent. Discussion and quoted examples never execute a command. Resolve one canonical initialized project from the current chat, its parent or an explicitly named project; ask only when that project is ambiguous. The commands work from the console, workers, excluded or unregistered chats and side chats without allocating a task ID or changing the caller's title. Subagents cannot select a mode on their own authority.

Read project status first. `NOT_INITIALIZED` requires initialization; a mode command does not create a console. Before a requested mutation with `MIGRATION_REQUIRED`, run `install-routing` and read status again. Projects without a recorded mode migrate to `merge`; existing selections, approvals and task history remain intact.

For a change, resolve the actual direct-user message and thread IDs using [review.md](review.md#resolve-the-approval-message-id). Use one stable command key across retries:

```bash
node <skill-dir>/scripts/control-room.ts mode --project-root <root> --mode <pr|merge|commit> \
    --event-key <stable-key> --user-request-id <actual-message-id> --thread-id <originating-thread-id>
```

For `current mode`, use the read-only command:

```bash
node <skill-dir>/scripts/control-room.ts mode --project-root <root> --mode status
```

Report the returned `integrationMode` and, when useful, the separate autopilot setting. Mode selection does not start, approve, commit or publish work. It persists until explicitly changed. Repeating an older command key returns the current selection without restoring its historical value.

## Approval behavior

The engine captures `integrationMode` when an approval event is submitted. Processing, settlement and recovery retain that snapshot even if the project mode changes meanwhile. Ordinary `Approve`, `Approve and pause`, and authorized autopilot approvals use the same selection; no second commit, push or PR confirmation is needed.

- `commit`: on shared activation, keep the current branch unless it is `main`. In that case create `control-room/codex`, or check out that existing branch without resetting its commits. Capture its current HEAD as the task baseline. Approval commits only there and reaches `DONE` or `PAUSED` immediately, preserving the branch and checkout. Never merge, push, publish a PR, or create/update main. A clean task with no new commits completes without a commit and retains the checkout. Detached HEAD and isolated activation are rejected before Git changes; use merge or PR mode for isolated work. Never stage or commit during implementation or review.
- `merge`: preserve the existing local commit, linear base integration, cleanup and `DONE` or `PAUSED` completion. No push or PR is created.
- `pr`: require the authenticated provider CLI selected from `origin`, an existing base commit, a separate worker branch, and one matching fetch/push destination. Commit only the assigned worker, push that exact approved commit to its worker branch without force, then create a repository PR against the configured base. Never push or advance the local base during publication and never merge the PR remotely.
- An unchanged approval with no task-local commits finishes without a commit or PR, following the existing cleanup behavior.

Before review, pass a concise English problem/behavior and actual verification summary through `request-review --summary`; the latest recorded summary becomes the PR body alongside the approval subject. Keep credentials, raw diffs and transcripts out of it. Publication explicitly fixes repository, base and head and never creates a fork.

The provider is derived from the clone URL; there is no provider setting:

- GitHub and GitHub Enterprise use `gh`, including authenticated enterprise hosts and HTTPS or Git SSH clone URLs identifying `owner/repository`.
- Azure DevOps Services uses `az` with the already installed Azure DevOps extension. Supported origins include `https://dev.azure.com/organization/project/_git/repository`, the same URL with its organization clone username, `git@ssh.dev.azure.com:v3/organization/project/repository`, the equivalent `ssh://git@ssh.dev.azure.com/v3/...` URL, and legacy `organization.visualstudio.com` / `vs-ssh.visualstudio.com` clone URLs. Legacy SSH also permits the organization clone username; legacy HTTPS may include `DefaultCollection`, case-insensitively. Hostnames are normalized case-insensitively. These normalize to one credential-free `dev.azure.com` repository URL. Passwords, token usernames, query parameters, custom ports and invalid repository coordinates are rejected.

Azure DevOps preflight reads the explicitly selected repository to verify authentication and destination before committing. Every PR operation specifies the organization; list/create also specify the project, repository and branches, with local detection disabled. Dynamic extension installation is disabled. Creation leaves auto-complete off and preserves the multiline review description. Provider responses must identify the recorded repository, exact source commit and target branch; forks are rejected. PR IDs are taken only from a validated repository-bound response, and persisted URLs are checked before requesting a PR. CLI diagnostics are sanitized to avoid leaking credentials. Azure DevOps Server and other PR providers are not currently implemented; preserve the task and report an unsupported origin rather than falling back to local merge.

After publication, the task enters `PR_OPEN` with 🔵. Its worker branch and isolated worktree remain; the shared checkout returns to the base. All subsequent shared and isolated activation waits while any task remains `PR_OPEN`, including independent queued tasks and after a mode change. Settlement verifies the remote merge and safely synchronizes the local base before creating the next task branch from that base. It never starts the next task from an open PR branch. Dependencies remain unsatisfied. `Approve and pause` stores a `PAUSED` target that is reached only after the PR merges and the base synchronizes.

After successfully creating or recovering a PR in this turn, always call the app's `attach_artifact` tool with its `pullRequestUrl`. Attach every created PR when settlement publishes several tasks. The tool attaches to the calling chat; the task's own status also retains its PR URL. Include the PR link and current state in the completion message and apply all returned title updates and activation deliveries.

The app may reject a provider URL that its attachment UI does not support, including Azure DevOps. Report the attachment limitation and provide the ordinary PR link while preserving the successful publication and `PR_OPEN` state. An attachment error is not a publication failure: never create a replacement PR, repeat approval or fall back to local merge to work around it.

Settlement can synchronize earlier PRs and approve the current worker in the same call. Find the current task by `taskId` in `completions`; the singular `completion` is the first result and may belong to another task.

## Synchronize remote completion

Settlement checks persisted open PRs. For a direct request to check or finalize a particular PR task, run:

```bash
node <skill-dir>/scripts/control-room.ts sync-prs --project-root <root> --task <T_ID>
node <skill-dir>/scripts/control-room.ts settle --project-root <root>
```

`sync-prs` reads provider state and fetches the base; it does not change the remote PR. Verify the returned outcome. An open PR remains `PR_OPEN`. A merged PR must still match the recorded repository, base, worker branch and approved head; its merge commit must exist in the fetched base. Fast-forward the local base, or retain a local base already ahead of the fetched head, before reaching `DONE` or the recorded `PAUSED` target. Squash and rebase merges are recognized through the provider's merge commit, without requiring the original worker commit to be an ancestor of the base. Azure DevOps `active`, `completed` and `abandoned` map to `OPEN`, `MERGED` and `CLOSED`; `lastMergeSourceCommit` and `lastMergeCommit` supply the approved source and merge commits.

Cleanup removes only unchanged task-owned local worker refs and clean isolated worktrees. Branches adopted in commit mode are retained even if a later approval selects merge or PR mode. A different active shared worker keeps its checkout, HEAD and dirty files while the base ref advances. A dirty base checkout, changed published worker, divergent local base, closed unmerged PR, origin mismatch or network failure preserves work and returns a warning. Surface the concrete reason and leave the prerequisite unsatisfied. Failed synchronization keeps the PR open and prevents subsequent activation; do not bypass it with Run now, isolated execution, or a mode change. No background polling or automation is created by selecting PR mode; read-only status shows persisted state.

Canceling a `PR_OPEN` task cancels local orchestration and preserves its changed branch/worktree and PR metadata. It never closes or deletes the remote PR. Changes to a published PR require a separate explicit implementation request; PR mode itself grants no approval of later remote commits.

## Branch continuity and recovery

PR and merge activation keep the per-task branch names `control-room/<T_ID>`; commit mode creates only `control-room/codex` and otherwise keeps an existing non-main branch name. The shared commit branch survives no-change completion, cancellation, checkpoint, resume and reopen. A later commit-mode task starts from its latest approved HEAD. Switching back to merge or PR mode after completion returns a clean checkout to the configured base for new task branches while retaining the commit branch; its unmerged changes are not implicitly included in the base. Git ref-name collisions or a branch held by another worktree are reported without deleting or renaming existing branches.

Commit-mode recovery recognizes the exact approved commit through the same persisted lease and parent/subject anchors. It finalizes without merging or creating another commit, and preserves changed history or dirty workspaces for review.

## Publication recovery

The existing approval lease covers local commit and publication. After confirming the prior process ended, use `recover-commit` and then settle, as described in [recovery.md](recovery.md). Recovery validates the worker commit, reuses its approval mode and publication destination, and looks up an existing matching PR before retrying creation. A persisted URL is validated before it is used. Lost push or creation responses must not produce replacement commits, duplicate PRs, force pushes or a fallback local merge.

Missing provider CLI or extension, authentication, origin or worker prerequisites fail before the first commit. A later push, creation, receipt or checkout failure preserves the approval lease and committed worker for recovery. Respect the tool's permission timeout and retry limits; an approval never overrides sandbox policy.
