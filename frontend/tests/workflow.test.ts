import { describe, expect, it } from 'vitest';
import {
  canConfirm,
  createWorkflow,
  markWorkflowEdited,
  validateWorkflow,
  type Workflow,
} from '../src/domain/workflow';

const socialWorkflow: Workflow = {
  ...createWorkflow('Social & Digital'),
  name: 'Social approval',
  status: 'ready_for_review',
  intakeTimeLimit: { amount: 4, unit: 'hours' },
  finalDecisionTimeLimit: { amount: 4, unit: 'hours' },
  totalTimeLimit: { amount: 3, unit: 'business-days' },
  stages: [{
    id: 'social-approval',
    position: 1,
    name: 'Social approval',
    timeLimit: { amount: 1, unit: 'business-days' },
    participants: [
      { role: 'Social/Digital', participation: 'approver' },
      { role: 'Marketing', participation: 'approver' },
    ],
    approvalRule: {
      type: 'any',
      rules: [
        { type: 'role', role: 'Social/Digital' },
        { type: 'role', role: 'Marketing' },
      ],
    },
  }],
};

describe('frontend workflow affordances', () => {
  it('uses the shared workflow shape to show a valid draft as confirmable', () => {
    expect(validateWorkflow(socialWorkflow)).toEqual([]);
    expect(canConfirm(socialWorkflow)).toBe(true);
  });

  it('does not allow confirmation when the draft is incomplete', () => {
    expect(canConfirm(createWorkflow())).toBe(false);
  });

  it('invalidates a confirmed revision after an edit', () => {
    const confirmed = { ...socialWorkflow, status: 'confirmed' as const, confirmedAt: new Date().toISOString() };
    const edited = markWorkflowEdited(confirmed, { name: 'Updated name' });
    expect(edited.status).toBe('ready_for_review');
    expect(edited.version).toBe(confirmed.version + 1);
    expect(edited.confirmedAt).toBeUndefined();
  });
});
