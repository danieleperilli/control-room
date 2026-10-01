import type { IApprovalResult, IControlRoomOptions, IStore, ITaskRow, ITitleUpdate } from "./control-room-types.ts";
const childProcess: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const { currentTimestamp, validateCommitId }: import("./control-room-validation.ts").IValidationApi = require("./control-room-validation.ts");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;
const { requireGit, runGit, readWorkingTreeStatus, resolveLocalBranchHeadIfExists }: import("./control-room-git.ts").IGitApi = require("./control-room-git.ts");
const { requireProject, requireTask, serializeTask, titleForControlRoom, compactActiveQueue }: import("./control-room-state.ts").IStateApi = require("./control-room-state.ts");
const { openStore, beginTransaction, commitTransaction, rollbackTransaction }: import("./control-room-storage.ts").IStorageApi = require("./control-room-storage.ts");
const PR_FIELDS = "number,url,state,headRefName,headRefOid,baseRefName,isCrossRepository,mergeCommit";

interface IPullRequest {
    number: number;
    url: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    headRefName: string;
    headRefOid: string;
    baseRefName: string;
    isCrossRepository: boolean;
    mergeCommit: { oid: string } | null;
}

interface IAzureRepository {
    organization: string;
    project: string;
    repository: string;
}

interface IAzurePullRequest {
    pullRequestId: number;
    status: string;
    sourceRefName: string;
    targetRefName: string;
    repository: { remoteUrl: string };
    forkSource?: unknown;
    lastMergeSourceCommit: { commitId: string } | null;
    lastMergeCommit: { commitId: string } | null;
}

/**
 * Reject a PR receipt outside the recorded repository before invoking a provider CLI.
 * @param value Untrusted PR URL or stored receipt.
 * @param repository Recorded publication destination.
 */
function validatePullRequestUrl(value: unknown, repository: string): string {
    const suffix = azureRepository(repository) ? /^\/pullrequest\/[1-9]\d*$/u : /^\/pull\/[1-9]\d*$/u;
    assertCondition(typeof value === "string" && value.slice(0, repository.length).toLowerCase() === repository.toLowerCase() && suffix.test(value.slice(repository.length)), "Pull request URL does not identify the recorded repository.");
    return value;
}

/**
 * Normalize GitHub and Azure DevOps clone URLs without carrying authentication data.
 * @param remote Configured origin URL.
 */
function repositoryUrlFromRemote(remote: string): string {
    const sshRemote = /^([A-Za-z0-9-]+)@([A-Za-z0-9.-]+):([^\s]+)$/u.exec(remote);
    let url: URL;
    try {
        url = new URL(sshRemote ? `ssh://${sshRemote[1]}@${sshRemote[2]}/${sshRemote[3]}` : remote);
    } catch {
        throw new Error("PR mode origin must be a valid HTTPS or SSH repository URL.");
    }
    url.hostname = url.hostname.toLowerCase();
    assertCondition(!url.password && !url.search && !url.hash && !url.port, "PR mode origin cannot contain credentials, query parameters or a custom port.");
    assertCondition(url.protocol === "https:" || url.protocol === "ssh:", "PR mode requires an HTTPS or Git SSH origin.");
    const azureHost = url.hostname === "dev.azure.com" || url.hostname.endsWith(".visualstudio.com") || url.hostname === "ssh.dev.azure.com";
    if (azureHost) {
        let organization: string;
        let project: string;
        let repository: string;
        let segments: string[];
        try {
            segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
        } catch {
            throw new Error("Azure DevOps origin contains invalid path encoding.");
        }
        if (url.protocol === "ssh:") {
            assertCondition(["ssh.dev.azure.com", "vs-ssh.visualstudio.com"].includes(url.hostname) && segments.length === 4 && segments[0] === "v3", "Azure DevOps SSH origin must identify v3/organization/project/repository.");
            [organization, project, repository] = segments.slice(1);
        } else if (url.hostname === "dev.azure.com") {
            assertCondition(segments.length === 4 && segments[2] === "_git", "Azure DevOps origin must identify organization/project/_git/repository.");
            [organization, project, , repository] = segments;
        } else {
            assertCondition(url.hostname.endsWith(".visualstudio.com") && url.hostname !== "vs-ssh.visualstudio.com", "Unsupported Azure DevOps HTTPS host.");
            organization = url.hostname.slice(0, -".visualstudio.com".length);
            if (segments[0]?.toLowerCase() === "defaultcollection") segments.shift();
            assertCondition(segments.length === 3 && segments[1] === "_git", "Azure DevOps origin must identify project/_git/repository.");
            [project, , repository] = segments;
        }
        assertCondition(/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(organization) && [project, repository].every((segment) => /^[\p{L}\p{N}_][\p{L}\p{N}_. -]*$/u.test(segment)), "Azure DevOps origin contains invalid organization, project or repository names.");
        const username = decodeURIComponent(url.username).toLowerCase();
        assertCondition(url.protocol === "ssh:" ? username === "git" || (url.hostname === "vs-ssh.visualstudio.com" && username === organization.toLowerCase()) : !username || username === organization.toLowerCase(), "Azure DevOps origin may contain only a supported clone username, never authentication credentials.");
        return `https://dev.azure.com/${organization.toLowerCase()}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
    }
    assertCondition((url.protocol === "https:" && !url.username) || (url.protocol === "ssh:" && url.username === "git"), "GitHub origin cannot contain embedded credentials.");
    const segments = url.pathname.replace(/\.git$/u, "").split("/").filter(Boolean);
    assertCondition(segments.length === 2 && segments.every((segment) => /^[A-Za-z0-9_.-]+$/u.test(segment) && segment !== "." && segment !== ".."), "PR mode origin must identify one GitHub owner and repository.");
    return `https://${url.hostname}/${segments.join("/")}`;
}

/**
 * Read explicit Azure DevOps coordinates from an already normalized repository URL.
 * @param repository Normalized publication destination.
 */
function azureRepository(repository: string): IAzureRepository | undefined {
    const url = new URL(repository);
    if (url.hostname !== "dev.azure.com") return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    return { organization: `https://dev.azure.com/${segments[0]}`, project: decodeURIComponent(segments[1]), repository: decodeURIComponent(segments[3]) };
}

/**
 * Run the selected provider CLI without a shell or leaking remote diagnostics.
 * @param projectRoot Repository working directory.
 * @param executable Provider CLI executable.
 * @param argumentsList Fixed command arguments.
 */
function requireProviderCli(projectRoot: string, executable: "gh" | "az", argumentsList: string[]): string {
    const provider = executable === "gh" ? "GitHub CLI (gh)" : "Azure CLI (az) with its Azure DevOps extension";
    const result = childProcess.spawnSync(executable, argumentsList, { cwd: projectRoot, encoding: "utf8", shell: false, maxBuffer: 1024 * 1024, timeout: 60000, env: { ...process.env, GH_PROMPT_DISABLED: "1", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" } });
    assertCondition(!result.error || !("code" in result.error) || result.error.code !== "ENOENT", `PR mode requires ${provider} installed and authenticated.`);
    assertCondition(result.status === 0, `${provider} ${argumentsList.slice(0, 2).join(" ")} failed. Check installation, authentication, permissions and network access before retrying.`);
    return result.stdout.trim();
}

/**
 * Parse provider JSON without exposing malformed output in diagnostics.
 * @param projectRoot Repository working directory.
 * @param executable Provider CLI executable.
 * @param argumentsList Fixed command arguments.
 */
function requireProviderJson(projectRoot: string, executable: "gh" | "az", argumentsList: string[]): unknown {
    const output = requireProviderCli(projectRoot, executable, argumentsList);
    try {
        return JSON.parse(output);
    } catch {
        throw new Error("The PR provider returned invalid JSON. Check the CLI installation and retry without exposing its raw output.");
    }
}

/**
 * Validate the publication destination before creating a local approval commit.
 * @param store Open project store.
 * @param task Task whose approval selects PR mode.
 */
function validatePullRequestEnvironment(store: IStore, task: ITaskRow): string {
    const project = requireProject(store);
    assertCondition(task.branch_name && task.branch_name !== project.base_branch && task.base_commit, "PR mode requires an existing base commit and a separate worker branch.");
    const origin = repositoryUrlFromRemote(requireGit(store.projectRoot, ["remote", "get-url", "origin"], "Resolve PR origin"));
    const pushOrigins = requireGit(store.projectRoot, ["remote", "get-url", "--push", "--all", "origin"], "Resolve PR push origin").split(/\r?\n/u);
    assertCondition(pushOrigins.length === 1 && repositoryUrlFromRemote(pushOrigins[0]) === origin, "PR mode requires the same single origin for fetch and push.");
    assertCondition(!task.pr_repository || task.pr_repository === origin, "Origin changed after PR publication began; preserve the task and restore its recorded destination.");
    const azure = azureRepository(origin);
    if (azure) {
        const metadata = requireProviderJson(store.projectRoot, "az", ["repos", "show", "--organization", azure.organization, "--project", azure.project, "--repository", azure.repository, "--detect", "false", "--output", "json", "--only-show-errors"]) as { remoteUrl?: unknown } | null;
        assertCondition(metadata && typeof metadata.remoteUrl === "string" && repositoryUrlFromRemote(metadata.remoteUrl) === origin, "Azure DevOps returned a different repository than the configured origin.");
    } else {
        requireProviderCli(store.projectRoot, "gh", ["auth", "status", "--hostname", new URL(origin).hostname]);
    }
    return origin;
}

/**
 * Normalize Azure DevOps PR metadata while retaining exact source and merge commits.
 * @param value Untrusted Azure DevOps CLI response.
 * @param repository Recorded publication destination.
 */
function normalizeAzurePullRequest(value: unknown, repository: string): IPullRequest {
    assertCondition(value && typeof value === "object", "Azure DevOps returned invalid pull request data.");
    const pr = value as IAzurePullRequest;
    assertCondition(Number.isSafeInteger(pr.pullRequestId) && pr.pullRequestId > 0 && pr.repository && typeof pr.repository.remoteUrl === "string" && repositoryUrlFromRemote(pr.repository.remoteUrl) === repository, "Azure DevOps returned a pull request from a different repository.");
    assertCondition(typeof pr.sourceRefName === "string" && pr.sourceRefName.startsWith("refs/heads/") && typeof pr.targetRefName === "string" && pr.targetRefName.startsWith("refs/heads/"), "Azure DevOps returned invalid pull request branches.");
    assertCondition(["active", "completed", "abandoned"].includes(pr.status), "Azure DevOps returned an invalid pull request state.");
    assertCondition(pr.lastMergeSourceCommit && typeof pr.lastMergeSourceCommit.commitId === "string", "Azure DevOps returned no source commit for the pull request.");
    return { number: pr.pullRequestId, url: `${repository}/pullrequest/${pr.pullRequestId}`, state: pr.status === "active" ? "OPEN" : pr.status === "completed" ? "MERGED" : "CLOSED", headRefName: pr.sourceRefName.slice("refs/heads/".length), headRefOid: pr.lastMergeSourceCommit.commitId, baseRefName: pr.targetRefName.slice("refs/heads/".length), isCrossRepository: Boolean(pr.forkSource), mergeCommit: pr.lastMergeCommit ? { oid: pr.lastMergeCommit.commitId } : null };
}

/**
 * Read one persisted PR receipt through its selected provider.
 * @param projectRoot Repository working directory.
 * @param repository Recorded publication destination.
 * @param url Validated PR receipt.
 */
function readPullRequest(projectRoot: string, repository: string, url: string): unknown {
    validatePullRequestUrl(url, repository);
    const azure = azureRepository(repository);
    if (azure) return normalizeAzurePullRequest(requireProviderJson(projectRoot, "az", ["repos", "pr", "show", "--id", url.slice(url.lastIndexOf("/") + 1), "--organization", azure.organization, "--detect", "false", "--output", "json", "--only-show-errors"]), repository);
    return requireProviderJson(projectRoot, "gh", ["pr", "view", url, "--repo", repository.slice("https://".length), "--json", PR_FIELDS]);
}

/**
 * Find prior publication attempts before pushing or creating another PR.
 * @param projectRoot Repository working directory.
 * @param repository Recorded publication destination.
 * @param branch Approved worker branch.
 * @param baseBranch Configured PR target.
 */
function listPullRequests(projectRoot: string, repository: string, branch: string, baseBranch: string): unknown[] {
    const azure = azureRepository(repository);
    const value = azure ? requireProviderJson(projectRoot, "az", ["repos", "pr", "list", "--organization", azure.organization, "--project", azure.project, "--repository", azure.repository, "--source-branch", branch, "--target-branch", baseBranch, "--status", "all", "--top", "100", "--detect", "false", "--output", "json", "--only-show-errors"]) : requireProviderJson(projectRoot, "gh", ["pr", "list", "--repo", repository.slice("https://".length), "--head", branch, "--base", baseBranch, "--state", "all", "--limit", "100", "--json", PR_FIELDS]);
    assertCondition(Array.isArray(value), "The provider returned an invalid pull request list.");
    return azure ? value.map((pr) => normalizeAzurePullRequest(pr, repository)) : value;
}

/**
 * Create one provider PR and return its repository-bound receipt before another call.
 * @param projectRoot Repository working directory.
 * @param repository Recorded publication destination.
 * @param branch Approved worker branch.
 * @param baseBranch Configured PR target.
 * @param title Approved English commit subject.
 * @param bodyPath Protected file containing the review description.
 */
function createPullRequest(projectRoot: string, repository: string, branch: string, baseBranch: string, title: string, bodyPath: string): string {
    const azure = azureRepository(repository);
    if (!azure) return requireProviderCli(projectRoot, "gh", ["pr", "create", "--repo", repository.slice("https://".length), "--base", baseBranch, "--head", branch, "--title", title, "--body-file", bodyPath]);
    const value = requireProviderJson(projectRoot, "az", ["repos", "pr", "create", "--organization", azure.organization, "--project", azure.project, "--repository", azure.repository, "--source-branch", branch, "--target-branch", baseBranch, "--title", title, "--description", fs.readFileSync(bodyPath, "utf8"), "--auto-complete", "false", "--detect", "false", "--output", "json", "--only-show-errors"]) as IAzurePullRequest;
    assertCondition(value && Number.isSafeInteger(value.pullRequestId) && value.pullRequestId > 0 && value.repository && typeof value.repository.remoteUrl === "string" && repositoryUrlFromRemote(value.repository.remoteUrl) === repository, "Azure DevOps returned an invalid pull request creation receipt.");
    return `${repository}/pullrequest/${value.pullRequestId}`;
}

/**
 * Verify remote PR identity and the exact commit covered by approval.
 * @param value Untrusted normalized provider JSON object.
 * @param repository Recorded repository URL.
 * @param baseBranch Configured PR target.
 * @param task Task retaining its worker branch and approved commit.
 */
function validatePullRequest(value: unknown, repository: string, baseBranch: string, task: ITaskRow): IPullRequest {
    assertCondition(value && typeof value === "object", "The provider returned invalid pull request data.");
    const pr = value as IPullRequest;
    assertCondition(Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.url === "string", "The provider returned an invalid pull request identity.");
    validatePullRequestUrl(pr.url, repository);
    const route = azureRepository(repository) ? "pullrequest" : "pull";
    assertCondition(pr.url.toLowerCase() === `${repository}/${route}/${pr.number}`.toLowerCase(), "Pull request belongs to a different repository.");
    assertCondition(pr.state === "OPEN" || pr.state === "CLOSED" || pr.state === "MERGED", "The provider returned an invalid pull request state.");
    assertCondition(pr.isCrossRepository === false && pr.baseRefName === baseBranch && pr.headRefName === task.branch_name, "Pull request branches do not match the approved task.");
    assertCondition(pr.headRefOid === task.approved_commit, "Pull request head changed after approval; review the new commits before completing the task.");
    if (pr.state === "MERGED") {
        assertCondition(pr.mergeCommit && typeof pr.mergeCommit.oid === "string", "Merged pull request has no merge commit.");
        validateCommitId(pr.mergeCommit.oid);
    }
    return pr;
}

/**
 * Publish one approved worker and release execution without advancing the base.
 * @param store Open project store holding the approval lease.
 * @param task Approved task with its persisted commit.
 * @param commitMessage English approval subject used for the PR title.
 */
function publishApprovedPullRequest(store: IStore, task: ITaskRow, commitMessage: string): IApprovalResult {
    const project = requireProject(store);
    assertCondition(project.integration_task_id === task.task_id && task.approved_commit && task.branch_name, "PR publication requires the task's approval lease and commit.");
    assertCondition(resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name) === task.approved_commit, "Worker branch changed after approval; preserve it for review.");
    const repository = validatePullRequestEnvironment(store, task);
    beginTransaction(store.database);
    store.database.prepare("UPDATE tasks SET pr_repository = ?, updated_at = ? WHERE task_id = ?").run(repository, currentTimestamp(), task.task_id);
    commitTransaction(store.database);
    let pr: IPullRequest;
    if (task.pr_url) {
        validatePullRequestUrl(task.pr_url, repository);
        pr = validatePullRequest(readPullRequest(store.projectRoot, repository, task.pr_url), repository, project.base_branch, task);
    } else {
        const candidates = listPullRequests(store.projectRoot, repository, task.branch_name, project.base_branch);
        assertCondition(candidates.every((candidate) => candidate && typeof candidate === "object"), "The provider returned malformed pull request entries.");
        const matching = (candidates as IPullRequest[]).filter((candidate) => candidate.isCrossRepository === false && candidate.headRefName === task.branch_name && (candidate.headRefOid === task.approved_commit || candidate.state === "OPEN"));
        assertCondition(matching.length <= 1, "Multiple pull requests match this approval; resolve the ambiguity before recovery.");
        if (matching.length === 1) {
            pr = validatePullRequest(matching[0], repository, project.base_branch, task);
        } else {
            const push = runGit(store.projectRoot, ["push", "--porcelain", "--", "origin", `${task.approved_commit}:refs/heads/${task.branch_name}`]);
            assertCondition(push.status === 0, "Push of the approved worker branch failed; preserve the commit and retry recovery after checking origin access.");
            const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "control-room-pr-"));
            try {
                fs.chmodSync(temporaryDirectory, 0o700);
                const bodyPath = path.join(temporaryDirectory, "body.md");
                const review = store.database.prepare("SELECT payload_json FROM events WHERE task_id = ? AND kind = 'REVIEW_REQUESTED' AND processed_at IS NOT NULL ORDER BY sequence DESC LIMIT 1").get(task.task_id) as { payload_json: string } | undefined;
                const summary = review ? (JSON.parse(review.payload_json) as { summary?: string }).summary : undefined;
                const body = `${commitMessage}\n\n${summary || "Approved changes are ready for repository review."}\n`;
                fs.writeFileSync(bodyPath, body, { mode: 0o600 });
                const createdUrl = createPullRequest(store.projectRoot, repository, task.branch_name, project.base_branch, commitMessage, bodyPath);
                validatePullRequestUrl(createdUrl, repository);
                // Persist the receipt before another network call or checkout can fail.
                beginTransaction(store.database);
                store.database.prepare("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE task_id = ?").run(createdUrl, currentTimestamp(), task.task_id);
                commitTransaction(store.database);
                pr = validatePullRequest(readPullRequest(store.projectRoot, repository, createdUrl), repository, project.base_branch, task);
            } finally {
                fs.rmSync(temporaryDirectory, { recursive: true, force: true });
            }
        }
    }
    assertCondition(pr.state !== "CLOSED", "The approved pull request was closed without merging; preserve the branch and resolve it before recovery.");
    beginTransaction(store.database);
    store.database.prepare("UPDATE tasks SET pr_url = ?, updated_at = ? WHERE task_id = ?").run(pr.url, currentTimestamp(), task.task_id);
    commitTransaction(store.database);
    if (task.workspace_mode === "shared") {
        const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Resolve PR checkout");
        assertCondition(currentBranch === task.branch_name || currentBranch === project.base_branch, "PR publication found an unrelated primary checkout.");
        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "PR checkout changed; preserve its work before releasing it.");
        if (currentBranch === task.branch_name) {
            requireGit(store.projectRoot, ["checkout", project.base_branch], "Release published worker checkout");
        }
    } else {
        assertCondition(task.worktree_path && readWorkingTreeStatus(task.worktree_path).length === 0, "PR worktree changed; preserve its work before releasing execution.");
    }
    beginTransaction(store.database);
    assertCondition(requireProject(store).integration_task_id === task.task_id, "Approval lease changed during PR publication.");
    store.database.prepare("UPDATE tasks SET state = 'PR_OPEN', awaiting_user = 0, queue_position = NULL, updated_at = ? WHERE task_id = ?").run(currentTimestamp(), task.task_id);
    store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL, updated_at = ? WHERE project_key = ?").run(currentTimestamp(), store.projectKey);
    const titleUpdates = compactActiveQueue(store);
    const publishedTask = requireTask(store, task.task_id);
    commitTransaction(store.database);
    return { committed: true, merged: false, branchDeleted: false, integrationMode: "pr", pullRequestUrl: pr.url, approvalTarget: task.approval_target, controlRoomTitle: titleForControlRoom(), gitMode: "pull-request", task: serializeTask(publishedTask), titleUpdates };
}

/**
 * Reconcile remote PR completion, preserving changed work and divergent local bases.
 * @param options Project and optional state-root settings.
 * @param taskId Optional PR task to reconcile.
 */
function syncPullRequests(options: IControlRoomOptions, taskId?: string): { tasks: IApprovalResult[]; warnings: Array<{ taskId: string; reason: string }>; titleUpdates: ITitleUpdate[] } {
    const store = openStore(options);
    const results: IApprovalResult[] = [];
    const warnings: Array<{ taskId: string; reason: string }> = [];
    const titleUpdates: ITitleUpdate[] = [];
    try {
        const project = requireProject(store);
        if (taskId) {
            assertCondition(requireTask(store, taskId).state === "PR_OPEN", "PR synchronization requires a PR_OPEN task.");
        }
        if (project.integration_task_id) {
            return { tasks: [], warnings: [{ taskId: project.integration_task_id, reason: "Finish approval recovery before synchronizing pull requests." }], titleUpdates: [] };
        }
        const tasks = store.database.prepare("SELECT * FROM tasks WHERE state = 'PR_OPEN' AND (? IS NULL OR task_id = ?) ORDER BY task_number").all(taskId || null, taskId || null) as unknown as ITaskRow[];
        for (const task of tasks) {
            try {
                assertCondition(task.pr_repository && task.pr_url && task.approved_commit && task.branch_name, "PR task has incomplete publication metadata.");
                const repository = validatePullRequestEnvironment(store, task);
                validatePullRequestUrl(task.pr_url, repository);
                const pr = validatePullRequest(readPullRequest(store.projectRoot, repository, task.pr_url), repository, project.base_branch, task);
                assertCondition(pr.state !== "CLOSED", "Pull request was closed without merging; reopen it or resolve the task explicitly.");
                if (pr.state === "OPEN") {
                    store.database.prepare("UPDATE tasks SET awaiting_user = 0 WHERE task_id = ?").run(task.task_id);
                    continue;
                }
                const mergeCommit = validateCommitId(pr.mergeCommit!.oid);
                beginTransaction(store.database);
                assertCondition(!requireProject(store).integration_task_id, "Another approval acquired the project lease.");
                assertCondition(requireTask(store, task.task_id).state === "PR_OPEN", "PR task changed while its remote state was being read.");
                store.database.prepare("UPDATE projects SET integration_task_id = ?, integration_started_at = ? WHERE project_key = ?").run(task.task_id, currentTimestamp(), store.projectKey);
                // Keep the transaction open until local synchronization and cleanup finish.
                const worktrees = requireGit(store.projectRoot, ["worktree", "list", "--porcelain", "-z"], "Inspect published worker ownership").split("\0\0");
                const workerWorktrees = worktrees.filter((record) => record.split("\0").includes(`branch refs/heads/${task.branch_name}`));
                const expectedWorkspace = task.workspace_mode === "isolated" ? task.worktree_path : store.projectRoot;
                assertCondition(workerWorktrees.every((record) => record.split("\0")[0] === `worktree ${expectedWorkspace}`), "Published worker is checked out in another worktree; preserve it before cleanup.");
                const fetch = runGit(store.projectRoot, ["fetch", "--no-tags", "--", "origin", `refs/heads/${project.base_branch}`]);
                assertCondition(fetch.status === 0, "Fetch of the PR base failed; keep the task open until synchronization succeeds.");
                const remoteHead = validateCommitId(requireGit(store.projectRoot, ["rev-parse", "FETCH_HEAD"], "Read fetched PR base"));
                assertCondition(runGit(store.projectRoot, ["merge-base", "--is-ancestor", mergeCommit, remoteHead]).status === 0, "PR merge commit is absent from the remote base; preserve the task.");
                const baseHead = resolveLocalBranchHeadIfExists(store.projectRoot, project.base_branch);
                assertCondition(baseHead, "Local PR base disappeared.");
                const localAhead = runGit(store.projectRoot, ["merge-base", "--is-ancestor", remoteHead, baseHead]).status === 0;
                const remoteAhead = runGit(store.projectRoot, ["merge-base", "--is-ancestor", baseHead, remoteHead]).status === 0;
                assertCondition(localAhead || remoteAhead, "Local base diverged from the merged PR base; reconcile it without rewriting history before retrying.");
                const { advanceBaseBranch, resolveTaskWorkspace, removeIsolatedWorkspace }: import("./control-room-integration.ts").IIntegrationApi = require("./control-room-integration.ts");
                const checkout = requireGit(store.projectRoot, ["branch", "--show-current"], "Read checkout before PR synchronization");
                if (checkout === task.branch_name) {
                    assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "Published worker checkout changed; preserve it before synchronization.");
                    requireGit(store.projectRoot, ["checkout", project.base_branch], "Release merged PR checkout");
                }
                if (!localAhead) {
                    if (checkout === project.base_branch || checkout === task.branch_name) {
                        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "Local base checkout changed; preserve it before synchronization.");
                    }
                    advanceBaseBranch(store, project, baseHead, remoteHead);
                }
                const workerHead = resolveLocalBranchHeadIfExists(store.projectRoot, task.branch_name);
                assertCondition(workerHead === null || workerHead === task.approved_commit, "Worker branch changed after PR publication; preserve it before cleanup.");
                if (task.workspace_mode === "isolated" && task.worktree_path && fs.existsSync(task.worktree_path)) {
                    resolveTaskWorkspace(store, task);
                    removeIsolatedWorkspace(store, task, task.approved_commit);
                } else if (workerHead) {
                    const currentBranch = requireGit(store.projectRoot, ["branch", "--show-current"], "Read checkout before PR cleanup");
                    if (currentBranch === task.branch_name) {
                        assertCondition(readWorkingTreeStatus(store.projectRoot).length === 0, "Published worker checkout changed; preserve it before cleanup.");
                        requireGit(store.projectRoot, ["checkout", project.base_branch], "Release merged PR checkout");
                    }
                    requireGit(store.projectRoot, ["update-ref", "-d", `refs/heads/${task.branch_name}`, workerHead], "Delete merged PR worker branch");
                }
                store.database.prepare("UPDATE tasks SET state = ?, integrated_commit = ?, branch_name = NULL, worktree_path = NULL, awaiting_user = 0, updated_at = ? WHERE task_id = ?").run(task.approval_target, mergeCommit, currentTimestamp(), task.task_id);
                store.database.prepare("UPDATE projects SET integration_task_id = NULL, integration_started_at = NULL WHERE project_key = ?").run(store.projectKey);
                const completedTask = requireTask(store, task.task_id);
                commitTransaction(store.database);
                titleUpdates.push({ taskId: task.task_id, threadId: task.thread_id, title: serializeTask(completedTask).title });
                results.push({ committed: true, merged: true, branchDeleted: true, integrationMode: "pr", pullRequestUrl: pr.url, approvalTarget: task.approval_target, controlRoomTitle: titleForControlRoom(), gitMode: "pull-request", task: serializeTask(completedTask) });
            } catch (error) {
                rollbackTransaction(store.database);
                const reason = error instanceof Error ? error.message : "Pull request synchronization failed.";
                store.database.prepare("UPDATE tasks SET awaiting_user = 1 WHERE task_id = ? AND state = 'PR_OPEN'").run(task.task_id);
                warnings.push({ taskId: task.task_id, reason });
            }
        }
        return { tasks: results, warnings, titleUpdates };
    } finally {
        store.database.close();
    }
}

const api = { validatePullRequestEnvironment, publishApprovedPullRequest, syncPullRequests };
module.exports = api;
export interface IPullRequestApi extends Readonly<typeof api> {}
