import type { EventKind, IEventPayload, ITaskRow } from "./control-room-types.ts";
const TASK_ID_PATTERN = /^T\d{4}$/;
const DECISION_ID_PATTERN = /^D(?:00[1-9]|0[1-9]\d|[1-9]\d{2})$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/**
 * Reject an invalid condition with a stable error message.
 * @param condition Condition that must be truthy.
 * @param message Error message used when the condition fails.
 */
function assertCondition(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

/**
 * Return the current timestamp in a SQLite-friendly format.
 */
function currentTimestamp(): string {
    return new Date().toISOString();
}

/**
 * Validate an opaque Codex thread identifier before persistence.
 * @param threadId Thread identifier supplied by Codex.
 */
function validateThreadId(threadId: string): string {
    assertCondition(typeof threadId === "string", "A thread ID is required.");
    const normalizedThreadId = threadId.trim();
    assertCondition(normalizedThreadId.length > 0 && normalizedThreadId.length <= 200, "Thread ID must contain 1 to 200 characters.");
    assertCondition(!/[\u0000-\u001f\u007f]/u.test(normalizedThreadId), "Thread ID contains control characters.");
    return normalizedThreadId;
}

/**
 * Validate and normalize a short semantic task name.
 * @param semanticName User-facing semantic task name.
 */
function validateSemanticName(semanticName: string): string {
    assertCondition(typeof semanticName === "string", "A semantic task name is required.");
    const normalizedName = semanticName.trim().replace(/^(?:⚪️|⭕️|🔴|🟡|🔵|💪|🟢|✅|❌|👉)\s*(?:(?:[⓪①-⑨]+|[❶-❾]|#\d{1,4})\s+)?/u, "");
    assertCondition(normalizedName.length > 0 && normalizedName.length <= 80, "Semantic task name must contain 1 to 80 characters.");
    assertCondition(!/[\u0000-\u001f\u007f]/u.test(normalizedName), "Semantic task name contains control characters.");
    return normalizedName;
}

/**
 * Validate a Control Room task identifier.
 * @param taskId Task identifier to validate.
 */
function validateTaskId(taskId: string): string {
    assertCondition(typeof taskId === "string" && TASK_ID_PATTERN.test(taskId), `Invalid task ID: ${String(taskId)}`);
    return taskId;
}

/**
 * Validate a full Git commit identifier.
 * @param commitId Git object identifier to validate.
 */
function validateCommitId(commitId: string): string {
    assertCondition(typeof commitId === "string" && COMMIT_PATTERN.test(commitId), "A full 40- or 64-character Git commit ID is required.");
    return commitId.toLowerCase();
}

/**
 * Validate a Git branch name without invoking a shell.
 * @param branchName Git branch name to validate.
 */
function validateBranchName(branchName: string): string {
    assertCondition(typeof branchName === "string", "A Git branch name is required.");
    const normalizedBranch = branchName.trim();
    assertCondition(normalizedBranch.length > 0 && normalizedBranch.length <= 240, "Git branch name must contain 1 to 240 characters.");
    assertCondition(!normalizedBranch.startsWith("-"), "Git branch names cannot start with a hyphen.");
    assertCondition(!normalizedBranch.startsWith("refs/") && normalizedBranch !== "HEAD", "Use a local branch name without a refs/ prefix.");
    assertCondition(!/[\u0000-\u0020\u007f~^:?*[\\]/u.test(normalizedBranch), "Git branch name contains forbidden characters.");
    assertCondition(!normalizedBranch.includes("..") && !normalizedBranch.includes("@{") && !normalizedBranch.includes("//"), "Git branch name contains a forbidden sequence.");
    assertCondition(!normalizedBranch.endsWith(".") && !normalizedBranch.endsWith("/") && !normalizedBranch.endsWith(".lock"), "Git branch name has a forbidden suffix.");
    return normalizedBranch;
}

/**
 * Build the deterministic worker branch name created when a task starts.
 * @param taskId Control Room task identifier.
 */
function workerBranchForTask(taskId: string): string {
    return validateBranchName(`control-room/${validateTaskId(taskId)}`);
}

/**
 * Validate an idempotency key.
 * @param eventKey Caller-stable event identifier.
 */
function validateEventKey(eventKey: string): string {
    assertCondition(typeof eventKey === "string", "An event key is required.");
    const normalizedKey = eventKey.trim();
    assertCondition(normalizedKey.length > 0 && normalizedKey.length <= 200, "Event key must contain 1 to 200 characters.");
    assertCondition(!/[\u0000-\u001f\u007f]/u.test(normalizedKey), "Event key contains control characters.");
    return normalizedKey;
}

/**
 * Validate compact persisted event text.
 * @param value Text supplied in an event payload.
 * @param fieldName Human-readable field name used in failures.
 * @param maximumLength Maximum accepted character count.
 * @param required Whether empty text is invalid.
 */
function validateCompactText(value: string | undefined, fieldName: string, maximumLength: number, required: boolean): string | undefined {
    if (value === undefined) {
        assertCondition(!required, `${fieldName} is required.`);
        return undefined;
    }
    assertCondition(typeof value === "string", `${fieldName} must be text.`);
    const normalizedValue = value.trim();
    assertCondition(!required || normalizedValue.length > 0, `${fieldName} is required.`);
    assertCondition(normalizedValue.length <= maximumLength, `${fieldName} must not exceed ${maximumLength} characters.`);
    assertCondition(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalizedValue), `${fieldName} contains control characters.`);
    return normalizedValue;
}

/**
 * Validate a stable task-local decision identifier.
 * @param decisionId Decision identifier supplied by the caller.
 */
function validateDecisionId(decisionId: string): string {
    assertCondition(typeof decisionId === "string" && DECISION_ID_PATTERN.test(decisionId), `Invalid decision ID: ${String(decisionId)}`);
    return decisionId;
}

/**
 * Validate and normalize one task-local macro decision.
 * @param payload Caller-supplied event payload.
 */
function validateDecisionPayload(payload: IEventPayload): IEventPayload {
    assertCondition(payload.confidence === "low" || payload.confidence === "medium" || payload.confidence === "high", "Decision confidence must be low, medium, or high.");
    assertCondition(payload.impact === "low" || payload.impact === "medium" || payload.impact === "high", "Decision impact must be low, medium, or high.");
    assertCondition(payload.status === "active" || payload.status === "unresolved", "Decision status must be active or unresolved.");
    return {
        decision: validateCompactText(payload.decision, "Decision", 2000, true),
        rationale: validateCompactText(payload.rationale, "Decision rationale", 2000, true),
        confidence: payload.confidence,
        impact: payload.impact,
        evidence: validateCompactText(payload.evidence, "Decision evidence", 2000, true),
        alternatives: validateCompactText(payload.alternatives, "Decision alternatives", 2000, false),
        uncertainty: validateCompactText(payload.uncertainty, "Decision uncertainty", 2000, false),
        supersedesDecisionId: payload.supersedesDecisionId ? validateDecisionId(payload.supersedesDecisionId) : undefined,
        status: payload.status
    };
}

/**
 * Validate a concise one-line Git commit subject.
 * @param commitMessage Commit subject supplied with direct approval.
 */
function validateCommitMessage(commitMessage: string | undefined): string {
    const normalizedMessage = validateCompactText(commitMessage, "Commit message", 72, true);
    assertCondition(normalizedMessage && normalizedMessage.length >= 8, "Commit message must contain at least 8 characters.");
    assertCondition(!/[\t\r\n]/u.test(normalizedMessage), "Commit message must be a single line.");
    assertCondition(/[A-Za-z]/u.test(normalizedMessage), "Commit message must contain Latin letters.");
    return normalizedMessage;
}

/**
 * Reject a commit subject copied from the task identifier or semantic title.
 * @param task Task receiving direct approval.
 * @param commitMessage Proposed commit subject.
 */
function validateApprovalCommitMessage(task: ITaskRow, commitMessage: string | undefined): string {
    const normalizedMessage = validateCommitMessage(commitMessage);
    const normalizedComparison = normalizedMessage.toLocaleLowerCase("en-US");
    const semanticComparison = task.semantic_name.trim().toLocaleLowerCase("en-US");
    assertCondition(normalizedComparison !== semanticComparison, "Commit message must describe the implemented change rather than copy the task name.");
    assertCondition(!normalizedComparison.startsWith(`${task.task_id.toLocaleLowerCase("en-US")} -`), "Commit message must not use the task title format.");
    return normalizedMessage;
}

/**
 * Validate a one-based position in the waiting queue.
 * @param position Queue position supplied by the caller.
 */
function validateQueuePosition(position: number | undefined): number {
    assertCondition(Number.isSafeInteger(position) && Number(position) >= 1 && Number(position) <= 9999, "Queue position must be an integer between 1 and 9999.");
    return Number(position);
}

/**
 * Validate and canonicalize an event payload before persistence.
 * @param kind Requested event kind.
 * @param payload Caller-supplied event payload.
 */
function validateEventPayload(kind: EventKind, payload: IEventPayload): IEventPayload {
    if (kind === "PLANNING_REQUESTED") {
        return {};
    }
    if (kind === "USER_INPUT_REQUESTED" || kind === "USER_INPUT_RECEIVED") {
        return { handoffTaskId: payload.handoffTaskId !== undefined ? validateTaskId(payload.handoffTaskId) : undefined };
    }
    if (kind === "ENQUEUE_REQUESTED") {
        return {
            afterTaskId: payload.afterTaskId ? validateTaskId(payload.afterTaskId) : undefined,
            userRequestId: payload.userRequestId !== undefined ? validateCompactText(payload.userRequestId, "Direct user request ID", 200, true) : undefined
        };
    }
    if (kind === "RUN_NOW_REQUESTED" || kind === "RUN_ISOLATED_NOW_REQUESTED") {
        return {
            userRequestId: payload.userRequestId !== undefined ? validateCompactText(payload.userRequestId, "Direct user request ID", 200, true) : undefined
        };
    }
    if (kind === "MOVE_REQUESTED") {
        const selectorCount = Number(Boolean(payload.beforeTaskId)) + Number(Boolean(payload.afterTaskId)) + Number(payload.position !== undefined);
        assertCondition(selectorCount === 1, "Move requires exactly one destination: before, after, or position.");
        return {
            afterTaskId: payload.afterTaskId ? validateTaskId(payload.afterTaskId) : undefined,
            beforeTaskId: payload.beforeTaskId ? validateTaskId(payload.beforeTaskId) : undefined,
            position: payload.position !== undefined ? validateQueuePosition(payload.position) : undefined
        };
    }
    if (kind === "DEPENDENCY_ADD_REQUESTED" || kind === "DEPENDENCY_REMOVE_REQUESTED") {
        return {
            dependencyTaskId: validateTaskId(String(payload.dependencyTaskId || ""))
        };
    }
    if (kind === "DECISION_RECORDED") {
        return validateDecisionPayload(payload);
    }
    if (kind === "REVIEW_REQUESTED" || kind === "REWORK_REQUESTED") {
        return {
            summary: validateCompactText(payload.summary, kind === "REVIEW_REQUESTED" ? "Review summary" : "Rework summary", 2000, false)
        };
    }
    if (kind === "APPROVAL_REQUESTED") {
        const approvalTarget = payload.approvalTarget || "DONE";
        assertCondition(approvalTarget === "DONE" || approvalTarget === "PAUSED", "Approval target must be DONE or PAUSED.");
        return {
            approvalTarget,
            commitMessage: validateCommitMessage(payload.commitMessage),
            userRequestId: validateCompactText(payload.userRequestId, "Direct user request ID", 200, true)
        };
    }
    if (kind === "CANCEL_REQUESTED") {
        const cancelSource = payload.cancelSource || "cancel";
        assertCondition(cancelSource === "cancel" || cancelSource === "exclude", "Cancellation source must be cancel or exclude.");
        return {
            cancelSource,
            exclusionReason: cancelSource === "exclude" ? validateCompactText(payload.exclusionReason, "Exclusion reason", 200, true) : undefined,
            userRequestId: validateCompactText(payload.userRequestId, "Direct user request ID", 200, true)
        };
    }
    assertCondition(kind === "BLOCKED_REPORTED", `Unsupported event kind: ${kind}`);
    return {
        reason: validateCompactText(payload.reason, "Blocked reason", 1000, true)
    };
}

const api = { assertCondition, currentTimestamp, validateThreadId, validateSemanticName, validateTaskId, validateCommitId, validateBranchName, workerBranchForTask, validateEventKey, validateCompactText, validateDecisionId, validateDecisionPayload, validateCommitMessage, validateApprovalCommitMessage, validateQueuePosition, validateEventPayload };
module.exports = api;
export interface IValidationApi extends Readonly<typeof api> {}
