export type TaskState = "PLANNING" | "QUEUED" | "RUNNING" | "REVIEW" | "APPROVED" | "PAUSED" | "DONE" | "BLOCKED" | "CANCELED";
export type EventKind = "PLANNING_REQUESTED" | "ENQUEUE_REQUESTED" | "RUN_NOW_REQUESTED" | "RUN_ISOLATED_NOW_REQUESTED" | "MOVE_REQUESTED" | "DEPENDENCY_ADD_REQUESTED" | "DEPENDENCY_REMOVE_REQUESTED" | "USER_INPUT_REQUESTED" | "USER_INPUT_RECEIVED" | "DECISION_RECORDED" | "REVIEW_REQUESTED" | "REWORK_REQUESTED" | "APPROVAL_REQUESTED" | "CANCEL_REQUESTED" | "BLOCKED_REPORTED";
export type WorkspaceMode = "shared" | "isolated";
export type ApprovalTarget = "DONE" | "PAUSED";
export type DecisionConfidence = "low" | "medium" | "high";
export type DecisionImpact = "low" | "medium" | "high";
export type DecisionInputStatus = "active" | "unresolved";
export type DecisionStatus = DecisionInputStatus | "superseded";

export interface IControlRoomOptions {
    projectRoot: string;
    stateRoot?: string;
}

export interface IStoreLocation {
    projectKey: string;
    projectRoot: string;
    databasePath: string;
}

export interface IUnavailableState {
    initialized: false;
    reason: "NOT_INITIALIZED" | "MIGRATION_REQUIRED";
    projectRoot: string;
    schemaVersion?: number;
    expectedSchemaVersion?: number;
}

export interface IEventPayload {
    afterTaskId?: string;
    approvalTarget?: ApprovalTarget;
    alternatives?: string;
    beforeTaskId?: string;
    cancelSource?: "cancel" | "exclude";
    commitMessage?: string;
    confidence?: DecisionConfidence;
    decision?: string;
    dependencyTaskId?: string;
    evidence?: string;
    exclusionReason?: string;
    impact?: DecisionImpact;
    handoffTaskId?: string;
    position?: number;
    reason?: string;
    rationale?: string;
    status?: DecisionInputStatus;
    summary?: string;
    supersedesDecisionId?: string;
    uncertainty?: string;
    userRequestId?: string;
}

export interface IEventPayloadByKind {
    PLANNING_REQUESTED: Record<string, never>;
    ENQUEUE_REQUESTED: Pick<IEventPayload, "afterTaskId" | "userRequestId">;
    RUN_NOW_REQUESTED: Pick<IEventPayload, "userRequestId">;
    RUN_ISOLATED_NOW_REQUESTED: Pick<IEventPayload, "userRequestId">;
    MOVE_REQUESTED: Pick<IEventPayload, "beforeTaskId" | "afterTaskId" | "position">;
    DEPENDENCY_ADD_REQUESTED: Required<Pick<IEventPayload, "dependencyTaskId">>;
    DEPENDENCY_REMOVE_REQUESTED: Required<Pick<IEventPayload, "dependencyTaskId">>;
    USER_INPUT_REQUESTED: Pick<IEventPayload, "handoffTaskId">;
    USER_INPUT_RECEIVED: Pick<IEventPayload, "handoffTaskId">;
    DECISION_RECORDED: Required<Pick<IEventPayload, "decision" | "rationale" | "confidence" | "impact" | "evidence" | "status">> & Pick<IEventPayload, "alternatives" | "uncertainty" | "supersedesDecisionId">;
    REVIEW_REQUESTED: Pick<IEventPayload, "summary">;
    REWORK_REQUESTED: Pick<IEventPayload, "summary">;
    APPROVAL_REQUESTED: Required<Pick<IEventPayload, "commitMessage" | "userRequestId">> & Pick<IEventPayload, "approvalTarget">;
    CANCEL_REQUESTED: Required<Pick<IEventPayload, "userRequestId">> & Pick<IEventPayload, "cancelSource" | "exclusionReason">;
    BLOCKED_REPORTED: Required<Pick<IEventPayload, "reason">>;
}

export interface IDecision {
    decisionId: string;
    decision: string;
    rationale: string;
    confidence: DecisionConfidence;
    impact: DecisionImpact;
    evidence: string;
    alternatives: string | null;
    uncertainty: string | null;
    supersedesDecisionId: string | null;
    supersededByDecisionId: string | null;
    status: DecisionStatus;
}

export interface IReviewPacket {
    taskId: string;
    decisionCount: number;
    unresolvedDecisionIds: string[];
    decisions: IDecision[];
}

export interface IStore {
    database: import("node:sqlite").DatabaseSync;
    databasePath: string;
    projectKey: string;
    projectRoot: string;
}

export interface IProjectRow {
    project_key: string;
    project_root: string;
    coordinator_thread_id: string;
    base_branch: string;
    git_mode: string;
    next_task_number: number;
    integration_task_id: string | null;
    integration_started_at: string | null;
}

export interface ITaskRow {
    task_id: string;
    task_number: number;
    semantic_name: string;
    thread_id: string;
    state: TaskState;
    blocked_from_state: TaskState | null;
    awaiting_user: number;
    handoff_sender_task_id?: string | null;
    pending_handoff_task_ids?: string;
    queue_position: number | null;
    queued_display_position?: number | null;
    base_commit: string | null;
    branch_name: string | null;
    workspace_mode: WorkspaceMode;
    worktree_path: string | null;
    reviewed_commit: string | null;
    approved_commit: string | null;
    approval_event_key: string | null;
    approval_target: ApprovalTarget;
    integrated_commit: string | null;
    cleanup_pending: number;
    created_at: string;
    updated_at: string;
}

export interface ITaskExclusionRow {
    thread_id: string;
    reason: string;
    created_at: string;
}

export interface IEventRow {
    sequence: number;
    event_key: string;
    task_id: string;
    kind: EventKind;
    payload_json: string;
}

export interface IGitResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

export interface ITitleUpdate {
    taskId: string;
    threadId: string;
    title: string;
}

export interface IActivationRequest {
    eventKey: string;
    eventKind: EventKind;
    userRequestId: string | null;
    requestedAt: string;
}

export interface IExecutionBrief {
    activationKey: string;
    taskId: string;
    threadId: string;
    semanticName: string;
    projectRoot: string;
    workspacePath: string;
    activationRequest: IActivationRequest | null;
    baseCommit: string | null;
    baseBranch: string;
    workerBranch: string;
    dependencies: string[];
    reviewPacket: IReviewPacket;
    instruction: string;
}

export interface IActivationDelivery {
    activationKey: string;
    state: "PENDING" | "CLAIMED";
    claimToken: string | null;
    executionBrief: IExecutionBrief;
}

export interface IDeliveryRow {
    activation_key: string;
    task_id: string;
    brief_json: string;
    state: "PENDING" | "CLAIMED" | "DELIVERED" | "CANCELED";
    claim_token: string | null;
    retry_request_id: string | null;
    receipt: string | null;
}

export interface IDoctorCheck {
    code: string;
    level: "ok" | "warning" | "error";
    message: string;
    taskId?: string;
    activationKey?: string;
    nextAction?: string;
}

export interface IDoctorResult {
    healthy: boolean;
    projectRoot: string;
    checks: IDoctorCheck[];
}

export interface IActivationResult {
    activated: boolean;
    controlRoomTitle: string;
    task?: ISerializedTask;
    taskId?: string;
    state?: TaskState;
    reason?: string;
    alreadyActive?: boolean;
    isolated?: boolean;
    recoveredActivation?: boolean;
    titleUpdates?: ITitleUpdate[];
    executionBrief?: IExecutionBrief;
}

export type LinearIntegrationResult = { integrated: true; commitId: string } | { integrated: false; details: string };

export interface IApprovalResult {
    committed: boolean;
    task: ISerializedTask;
    controlRoomTitle: string;
    gitMode: string;
    approvalTarget?: ApprovalTarget;
    titleUpdates?: ITitleUpdate[];
    integrated?: boolean;
    integrationConflict?: boolean;
    conflictDetails?: string;
    instruction?: string;
    merged?: boolean;
    branchDeleted?: boolean;
    dequeued?: boolean;
    noUncommittedChanges?: boolean;
    alreadyFinalized?: boolean;
    alreadyCompleted?: boolean;
    alreadyCommitted?: boolean;
}

export interface IRecoveryResult extends Partial<IApprovalResult> {
    task: ISerializedTask;
    controlRoomTitle: string;
    recovered: boolean;
    finalized?: boolean;
    retryCommit?: boolean;
}

export interface ISerializedTask {
    taskId: string;
    number: number;
    semanticName: string;
    threadId: string;
    state: TaskState;
    blockedFromState: TaskState | null;
    awaitingUser: boolean;
    handoffSenderTaskId: string | null;
    pendingHandoffTaskIds: string[];
    title: string;
    queuePosition: number | null;
    queuedPosition: number | null;
    baseCommit: string | null;
    branchName: string | null;
    workspaceMode: WorkspaceMode;
    worktreePath: string | null;
    approvedCommit: string | null;
    approvalTarget: ApprovalTarget;
    committedCommit: string | null;
}
