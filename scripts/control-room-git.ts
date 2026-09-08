import type { LinearIntegrationResult, IGitResult } from "./control-room-types.ts";
const childProcess: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");
const { validateTaskId, validateCommitId, validateBranchName }: import("./control-room-validation.ts").IValidationApi = require("./control-room-validation.ts");
const assertCondition: (condition: unknown, message: string) => asserts condition = require("./control-room-validation.ts").assertCondition;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * Resolve and validate the canonical project directory.
 * @param projectRoot Repository root supplied by the caller.
 */
function canonicalizeProjectRoot(projectRoot: string): string {
    assertCondition(typeof projectRoot === "string" && projectRoot.trim().length > 0, "A project root is required.");
    const resolvedRoot = path.resolve(projectRoot);
    assertCondition(fs.existsSync(resolvedRoot), `Project root does not exist: ${resolvedRoot}`);
    assertCondition(fs.statSync(resolvedRoot).isDirectory(), `Project root is not a directory: ${resolvedRoot}`);
    const requestedRoot = fs.realpathSync(resolvedRoot);
    const gitRootResult = runGit(requestedRoot, ["rev-parse", "--show-toplevel"]);
    assertCondition(gitRootResult.status === 0, `Project root is not a Git repository: ${requestedRoot}`);
    assertCondition(fs.realpathSync(gitRootResult.stdout) === requestedRoot, `Project root must be the Git working tree root: ${gitRootResult.stdout}`);
    const commonDirectoryResult = runGit(requestedRoot, ["rev-parse", "--git-common-dir"]);
    assertCondition(commonDirectoryResult.status === 0, `Cannot resolve the common Git directory: ${requestedRoot}`);
    const commonDirectory = fs.realpathSync(path.resolve(requestedRoot, commonDirectoryResult.stdout));
    assertCondition(path.basename(commonDirectory) === ".git", `Unsupported common Git directory: ${commonDirectory}`);
    const canonicalRoot = fs.realpathSync(path.dirname(commonDirectory));
    const canonicalGitRoot = runGit(canonicalRoot, ["rev-parse", "--show-toplevel"]);
    assertCondition(canonicalGitRoot.status === 0 && fs.realpathSync(canonicalGitRoot.stdout) === canonicalRoot, `Cannot resolve the primary Local checkout: ${canonicalRoot}`);
    assertCondition(requestedRoot === canonicalRoot, "ControlRoom requires the primary Local checkout. Use Hand off > Local before continuing.");
    return canonicalRoot;
}

/**
 * Run a Git command with fixed executable and argument boundaries.
 * @param projectRoot Canonical repository root used as working directory.
 * @param argumentsList Git arguments passed without a shell.
 */
function runGit(projectRoot: string, argumentsList: string[]): IGitResult {
    const result = childProcess.spawnSync("git", argumentsList, {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        shell: false
    });
    return {
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
        stderr: typeof result.stderr === "string" ? result.stderr.trim() : ""
    };
}

/**
 * Require a successful Git command and return its standard output.
 * @param projectRoot Canonical repository root used as working directory.
 * @param argumentsList Git arguments passed without a shell.
 * @param operation Human-readable operation used in failures.
 */
function requireGit(projectRoot: string, argumentsList: string[], operation: string): string {
    const result = runGit(projectRoot, argumentsList);
    assertCondition(result.status === 0, `${operation} failed: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`);
    return result.stdout;
}

/**
 * Require a named branch to be the current checkout and return HEAD.
 * @param projectRoot Canonical repository root used as working directory.
 * @param branchName Expected current branch.
 */
function requireBranchCheckout(projectRoot: string, branchName: string): string {
    const validBranchName = validateBranchName(branchName);
    const repositoryRoot = requireGit(projectRoot, ["rev-parse", "--show-toplevel"], "Resolve Git repository");
    assertCondition(fs.realpathSync(repositoryRoot) === projectRoot, "Git repository root does not match the Control Room project root.");
    const currentBranch = requireGit(projectRoot, ["branch", "--show-current"], "Resolve current branch");
    assertCondition(currentBranch === validBranchName, `ControlRoom requires branch ${validBranchName}; found ${currentBranch || "detached HEAD"}.`);
    return validateCommitId(requireGit(projectRoot, ["rev-parse", "HEAD"], "Resolve current head"));
}

/**
 * Require the configured base branch to be the current checkout and return HEAD.
 * @param projectRoot Canonical repository root used as working directory.
 * @param baseBranch Configured shared base branch.
 */
function requireBaseCheckout(projectRoot: string, baseBranch: string): string {
    return requireBranchCheckout(projectRoot, baseBranch);
}

/**
 * Read staged, unstaged, and untracked working-tree changes.
 * @param projectRoot Canonical repository root used as working directory.
 */
function readWorkingTreeStatus(projectRoot: string): string {
    return requireGit(projectRoot, ["status", "--porcelain", "--untracked-files=all"], "Inspect working tree");
}

/**
 * Resolve the current commit or return null when HEAD is unborn.
 * @param projectRoot Canonical repository root used as working directory.
 */
function resolveCurrentHeadIfExists(projectRoot: string): string | null {
    const result = runGit(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    assertCondition(result.status === 0 || result.status === 1, `Resolve current head failed: ${result.stderr || result.stdout || `exit ${String(result.status)}`}`);
    return result.status === 0 ? validateCommitId(result.stdout) : null;
}

/**
 * Resolve a local branch commit or return null when the branch is unborn or absent.
 * @param projectRoot Canonical repository root used as working directory.
 * @param branchName Local branch name without a refs prefix.
 */
function resolveLocalBranchHeadIfExists(projectRoot: string, branchName: string): string | null {
    const validBranchName = validateBranchName(branchName);
    const branchResult = runGit(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${validBranchName}`]);
    assertCondition(branchResult.status === 0 || branchResult.status === 1, `Inspect local branch ${validBranchName} failed: ${branchResult.stderr || branchResult.stdout || `exit ${String(branchResult.status)}`}`);
    return branchResult.status === 0 ? resolveLocalBranchHead(projectRoot, validBranchName) : null;
}

/**
 * Resolve an unambiguous local branch head commit.
 * @param projectRoot Canonical repository root used as working directory.
 * @param branchName Local branch name without a refs prefix.
 */
function resolveLocalBranchHead(projectRoot: string, branchName: string): string {
    const validBranchName = validateBranchName(branchName);
    const branchReference = `refs/heads/${validBranchName}^{commit}`;
    return validateCommitId(requireGit(projectRoot, ["rev-parse", "--verify", branchReference], `Resolve local branch ${validBranchName}`));
}

/**
 * Determine whether a commit has exactly the expected parent, including a root commit.
 * @param projectRoot Canonical repository root used as working directory.
 * @param commitId Commit whose parent list should be inspected.
 * @param expectedParentCommit Expected sole parent, or null for a root commit.
 */
function commitHasExpectedParent(projectRoot: string, commitId: string, expectedParentCommit: string | null): boolean {
    const validCommitId = validateCommitId(commitId);
    const parentsResult = runGit(projectRoot, ["rev-list", "--parents", "--max-count=1", validCommitId]);
    if (parentsResult.status !== 0) {
        return false;
    }
    const commitParts = parentsResult.stdout.split(/\s+/u);
    if (commitParts[0] !== validCommitId) {
        return false;
    }
    if (expectedParentCommit === null) {
        return commitParts.length === 1;
    }
    return commitParts.length === 2 && commitParts[1] === validateCommitId(expectedParentCommit);
}

/**
 * Determine whether a commit is the single approval commit expected after a recorded parent.
 * @param projectRoot Canonical repository root used as working directory.
 * @param commitId Candidate approval commit.
 * @param parentCommitId Recorded pre-approval parent commit, or null for an unborn repository.
 * @param expectedSubject Expected approval commit subject.
 */
function commitMatchesApproval(projectRoot: string, commitId: string, parentCommitId: string | null, expectedSubject: string): boolean {
    if (parentCommitId && commitId === parentCommitId) {
        return false;
    }
    if (!commitHasExpectedParent(projectRoot, commitId, parentCommitId)) {
        return false;
    }
    const subjectResult = runGit(projectRoot, ["log", "-1", "--format=%s", commitId]);
    return subjectResult.status === 0 && subjectResult.stdout === expectedSubject;
}

/**
 * Create the first base branch ref at an approved commit.
 * @param projectRoot Canonical repository root used as working directory.
 * @param baseBranch Configured base branch.
 * @param commitId Approved commit used as the initial base tip.
 */
function createInitialBaseBranch(projectRoot: string, baseBranch: string, commitId: string): void {
    const validBaseBranch = validateBranchName(baseBranch);
    const validCommitId = validateCommitId(commitId);
    assertCondition(resolveLocalBranchHeadIfExists(projectRoot, validBaseBranch) === null, `Base branch ${validBaseBranch} was created concurrently.`);
    requireGit(projectRoot, ["branch", validBaseBranch, validCommitId], `Create initial base branch ${validBaseBranch}`);
}

/**
 * Create a linear integration commit on the latest base without changing a working tree.
 * @param projectRoot Canonical project root.
 * @param baseCommit Latest base branch commit.
 * @param approvedCommit Approved worker branch commit.
 * @param commitMessage Approved commit subject.
 */
function buildLinearIntegrationCommit(projectRoot: string, baseCommit: string, approvedCommit: string, commitMessage: string): LinearIntegrationResult {
    const ancestorResult = runGit(projectRoot, ["merge-base", "--is-ancestor", baseCommit, approvedCommit]);
    assertCondition(ancestorResult.status === 0 || ancestorResult.status === 1, `Inspect integration ancestry failed: ${ancestorResult.stderr || ancestorResult.stdout}`);
    if (ancestorResult.status === 0) {
        return { integrated: true, commitId: approvedCommit };
    }
    const mergeResult = runGit(projectRoot, ["merge-tree", "--write-tree", "--messages", baseCommit, approvedCommit]);
    if (mergeResult.status === 1) {
        return { integrated: false, details: mergeResult.stdout || mergeResult.stderr || "Git reported an integration conflict." };
    }
    assertCondition(mergeResult.status === 0, `Build integration tree failed: ${mergeResult.stderr || mergeResult.stdout}`);
    const treeId = mergeResult.stdout.split(/\r?\n/u)[0];
    assertCondition(COMMIT_PATTERN.test(treeId), `Git returned an invalid integration tree: ${treeId}`);
    const integratedCommit = validateCommitId(requireGit(projectRoot, ["commit-tree", treeId, "-p", baseCommit, "-m", commitMessage], "Create linear integration commit"));
    return { integrated: true, commitId: integratedCommit };
}

/**
 * Resolve the deterministic repository-local worktree path for one task.
 * @param projectRoot Canonical project root.
 * @param taskId Control Room task identifier.
 */
function isolatedWorktreePathForTask(projectRoot: string, taskId: string): string {
    return path.join(projectRoot, ".control-room", "worktrees", validateTaskId(taskId));
}

const api = { isolatedWorktreePathForTask, canonicalizeProjectRoot, runGit, requireGit, requireBranchCheckout, requireBaseCheckout, readWorkingTreeStatus, resolveCurrentHeadIfExists, resolveLocalBranchHeadIfExists, resolveLocalBranchHead, commitHasExpectedParent, commitMatchesApproval, createInitialBaseBranch, buildLinearIntegrationCommit };
module.exports = api;
export interface IGitApi extends Readonly<typeof api> {}
