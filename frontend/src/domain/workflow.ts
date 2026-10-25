export const ASSET_TYPES = [
  'Legacy Advertising',
  'Signage & Venue',
  'Team & Uniform',
  'Social & Digital',
  'Athlete & Talent',
  'Experience & Promos',
  'Merch & Retail',
] as const;

export const PROPERTY_ROLES = [
  'Partnership Lead',
  'Legal',
  'Outside Counsel',
  'Marketing',
  'Activation',
  'Sales',
  'Executive Leadership',
  'Ownership',
  'Game-Day Operations',
  'Venue Operations',
  'Player Personnel',
  'Talent Relations',
  'Communications/PR',
  'Social/Digital',
  'Partnership Services',
] as const;

export const OUTSIDE_ORGANIZATIONS = [
  'League Office',
  'Player Agent',
  'Venue Owner',
  'Rights Holder',
] as const;

export const ROLES = [...PROPERTY_ROLES, ...OUTSIDE_ORGANIZATIONS] as const;

export const CONDITIONS = [
  'Uses a player’s likeness',
  'Uses league marks',
  'Involves the venue or game day',
  'Includes legal, contest or sweepstakes language',
  'Will run on social media',
  'Will run in paid or broadcast media',
  'Is sensitive to ownership',
  'Is sensitive for executives',
] as const;

export type AssetType = (typeof ASSET_TYPES)[number] | (string & {});
export type Participation = 'approver' | 'consultative' | 'viewer';
export type OrganizationType = 'Property' | 'outside organization' | 'custom';
export type TimeLimit = { amount: number; unit: 'hours' | 'business-days' };

export type Participant = {
  role: string;
  participation: Participation;
  organizationType?: OrganizationType;
  notes?: string;
  sourceEvidence?: string;
};

export type ApprovalRule =
  | { type: 'all' | 'any'; rules: ApprovalRule[] }
  | { type: 'n_of_m'; n: number; m: number }
  | { type: 'role'; role: string };

export type Stage = {
  id: string;
  position: number;
  name: string;
  timeLimit?: TimeLimit;
  participants: Participant[];
  approvalRule: ApprovalRule;
  appliesWhen?: string[];
};

export type WorkflowCondition = {
  id: string;
  condition: string;
  effect: 'add-participant' | 'change-participation';
  role: string;
  participation: Participation;
  stageId: string;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type WorkflowStatus =
  | 'draft'
  | 'needs_clarification'
  | 'ready_for_review'
  | 'confirmed';

export type Workflow = {
  id: string;
  name: string;
  assetType: AssetType;
  owner: string;
  intakeTimeLimit?: TimeLimit;
  stages: Stage[];
  finalDecisionTimeLimit?: TimeLimit;
  totalTimeLimit?: TimeLimit;
  viewers: string[];
  conditions: WorkflowCondition[];
  notes: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  conversation: ConversationMessage[];
  status: WorkflowStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

export type WorkflowSummary = Pick<Workflow, 'id' | 'name' | 'assetType' | 'status' | 'updatedAt'>;

const now = () => new Date().toISOString();

export function createWorkflow(assetType: AssetType = 'Experience & Promos'): Workflow {
  const timestamp = now();
  return {
    id: crypto.randomUUID(),
    name: 'New approval workflow',
    assetType,
    owner: 'Partnership Lead',
    intakeTimeLimit: undefined,
    stages: [],
    finalDecisionTimeLimit: undefined,
    totalTimeLimit: undefined,
    viewers: [],
    conditions: [],
    notes: [],
    assumptions: [],
    unresolvedQuestions: [],
    conversation: [],
    status: 'draft',
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function markWorkflowEdited(workflow: Workflow, updates: Partial<Workflow>): Workflow {
  const wasConfirmed = workflow.status === 'confirmed';
  return {
    ...workflow,
    ...updates,
    status: updates.status ?? (
      wasConfirmed || workflow.status !== 'needs_clarification'
        ? 'ready_for_review'
        : workflow.status
    ),
    version: wasConfirmed ? workflow.version + 1 : workflow.version,
    confirmedAt: undefined,
    updatedAt: now(),
  };
}

function validateApprovalRule(
  rule: ApprovalRule,
  approverRoles: Set<string>,
  path: string,
  errors: string[],
): void {
  if (rule.type === 'role') {
    if (!approverRoles.has(rule.role)) errors.push(`${path} references non-approver “${rule.role}”.`);
    return;
  }
  if (rule.type === 'n_of_m') {
    if (!Number.isInteger(rule.n) || !Number.isInteger(rule.m) || rule.n < 1 || rule.m < rule.n) {
      errors.push(`${path} has an invalid N-of-M threshold.`);
    }
    if (rule.m > approverRoles.size) errors.push(`${path} requires more approvers than the stage contains.`);
    return;
  }
  if (rule.rules.length < 1) errors.push(`${path} must contain at least one child rule.`);
  rule.rules.forEach((child, index) =>
    validateApprovalRule(child, approverRoles, `${path}, rule ${index + 1}`, errors),
  );
}

export function validateWorkflow(workflow: Workflow): string[] {
  const errors: string[] = [];
  if (!workflow.name.trim()) errors.push('A workflow name is required.');
  if (!workflow.assetType.trim()) errors.push('An asset type is required.');
  if (!workflow.owner.trim()) errors.push('A workflow owner is required.');
  if (workflow.stages.length === 0) errors.push('Add at least one review stage.');

  const stageIds = new Set<string>();
  workflow.stages.forEach((stage, index) => {
    const label = `Stage ${index + 1}`;
    if (!stage.id.trim()) errors.push(`${label} needs an id.`);
    if (stageIds.has(stage.id)) errors.push(`${label} has a duplicate id.`);
    stageIds.add(stage.id);
    if (stage.position !== index + 1) errors.push('Stage positions must be unique and ordered.');
    if (!stage.name.trim()) errors.push(`${label} needs a name.`);
    const timeLimitQuestionExists = workflow.unresolvedQuestions.some(question =>
      question.toLowerCase().includes(stage.name.toLowerCase()) && /\b(time|deadline|limit)\b/i.test(question),
    );
    if (!stage.timeLimit && !timeLimitQuestionExists) {
      errors.push(`${label} needs a time limit or a recorded unresolved question.`);
    }
    if (stage.timeLimit && (!Number.isFinite(stage.timeLimit.amount) || stage.timeLimit.amount <= 0)) {
      errors.push(`${label} needs a positive time limit.`);
    }

    const roles = stage.participants
      .filter(participant => participant.participation === 'approver')
      .map(participant => participant.role);
    workflow.conditions
      .filter(condition => condition.stageId === stage.id && condition.participation === 'approver')
      .forEach(condition => roles.push(condition.role));
    const approverRoles = new Set(roles);
    if (approverRoles.size === 0) errors.push(`${label} needs at least one approver or conditional approver.`);
    if (roles.length !== approverRoles.size) errors.push(`${label} has duplicate approver roles.`);
    stage.participants.forEach(participant => {
      if (!participant.role.trim()) errors.push(`${label} has a participant without a role.`);
    });
    validateApprovalRule(stage.approvalRule, approverRoles, `${label} approval rule`, errors);
  });

  workflow.conditions.forEach(condition => {
    if (!condition.condition.trim()) errors.push('Every condition needs a description.');
    if (!condition.role.trim()) errors.push('Every condition needs a participant role.');
    if (!stageIds.has(condition.stageId)) errors.push(`Condition “${condition.condition}” references a missing stage.`);
    if (condition.effect === 'change-participation') {
      const stage = workflow.stages.find(item => item.id === condition.stageId);
      if (!stage?.participants.some(participant => participant.role === condition.role)) {
        errors.push(`Condition “${condition.condition}” changes participation for a missing participant.`);
      }
    }
  });
  workflow.stages.forEach(stage => {
    stage.appliesWhen?.forEach(conditionName => {
      if (!workflow.conditions.some(condition => condition.condition === conditionName)) {
        errors.push(`Stage “${stage.name}” references an unknown apply condition.`);
      }
    });
  });
  for (const [label, timeLimit] of [
    ['Intake', workflow.intakeTimeLimit],
    ['Final decision', workflow.finalDecisionTimeLimit],
    ['Total workflow', workflow.totalTimeLimit],
  ] as const) {
    if (timeLimit && (!Number.isFinite(timeLimit.amount) || timeLimit.amount <= 0)) {
      errors.push(`${label} needs a positive time limit.`);
    }
  }

  return errors;
}

export function canConfirm(workflow: Workflow): boolean {
  return validateWorkflow(workflow).length === 0 && workflow.unresolvedQuestions.length === 0;
}

export function confirmWorkflow(workflow: Workflow): Workflow {
  if (!canConfirm(workflow)) throw new Error('Resolve all validation errors and questions before confirming.');
  return {
    ...workflow,
    status: 'confirmed',
    confirmedAt: now(),
    updatedAt: now(),
  };
}

export function formatTime(timeLimit?: TimeLimit): string {
  if (!timeLimit) return 'Not set';
  return `${timeLimit.amount} ${timeLimit.unit === 'hours' ? 'hours' : 'business days'}`;
}
