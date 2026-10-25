import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ASSET_TYPES,
  CONDITIONS,
  OUTSIDE_ORGANIZATIONS,
  PROPERTY_ROLES,
  canConfirm,
  createWorkflow,
  formatTime,
  markWorkflowEdited,
  validateWorkflow,
  type ApprovalRule,
  type Participant,
  type Participation,
  type Stage,
  type TimeLimit,
  type Workflow,
  type WorkflowSummary,
} from '../domain/workflow';
import {
  ApiError,
  confirmWorkflow as confirmWorkflowApi,
  createWorkflow as createWorkflowApi,
  downloadWorkflow,
  getExample,
  getWorkflow,
  getWorkflows,
  sendMessage,
  updateWorkflow,
} from '../api/client';
import '../style.css';

const WORKFLOW_ID_KEY = 'approval-lab.workflow-id.v1';
const roleOptions = [...PROPERTY_ROLES, ...OUTSIDE_ORGANIZATIONS];

function upsertWorkflowSummary(
  workflows: WorkflowSummary[],
  workflow: Workflow,
): WorkflowSummary[] {
  return [
    {
      id: workflow.id,
      name: workflow.name,
      assetType: workflow.assetType,
      status: workflow.status,
      updatedAt: workflow.updatedAt,
    },
    ...workflows.filter(item => item.id !== workflow.id),
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function formatClarification(question: string): string {
  if (question.startsWith('Approval rule:') || question.startsWith('Approval conflict:')) {
    return `Should ${question.split(':')[1].replaceAll(',', ', ')} all approve, or is any one sufficient?`;
  }
  if (question.startsWith('Time limit conflict|')) {
    const [, scope, , oldAmount, oldUnit, newAmount, newUnit] = question.split('|');
    const label = scope === 'intake' ? 'Intake' : scope === 'final' ? 'Final decision' : scope === 'total' ? 'Total workflow' : 'Stage';
    const format = (amount: string, unit: string) => `${amount} ${unit === 'hours' ? 'hours' : 'business days'}`;
    return `${label} time changed from ${format(oldAmount, oldUnit)} to ${format(newAmount, newUnit)}. Which value should be kept? Reply “keep the existing value” or “use the new value”.`;
  }
  return question;
}

function TimeLimitEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: TimeLimit;
  onChange: (value?: TimeLimit) => void;
}) {
  return (
    <label className="time-editor">
      <span>{label}</span>
      <div>
        <input
          aria-label={`${label} amount`}
          type="number"
          min="0.25"
          step="0.25"
          value={value?.amount ?? ''}
          placeholder="Not set"
          onChange={event => {
            const amount = Number(event.target.value);
            onChange(Number.isFinite(amount) && amount > 0
              ? { amount, unit: value?.unit ?? 'business-days' }
              : undefined);
          }}
        />
        <select
          aria-label={`${label} unit`}
          disabled={!value}
          value={value?.unit ?? 'business-days'}
          onChange={event => onChange({
            amount: value?.amount ?? 1,
            unit: event.target.value as TimeLimit['unit'],
          })}
        >
          <option value="hours">hours</option>
          <option value="business-days">business days</option>
        </select>
      </div>
    </label>
  );
}

function defaultRule(type: 'all' | 'any' | 'n_of_m' | 'role', roles: string[]): ApprovalRule {
  if (type === 'n_of_m') return { type, n: 1, m: Math.max(roles.length, 1) };
  if (type === 'role') return { type, role: roles[0] ?? '' };
  return { type, rules: roles.map(role => ({ type: 'role', role })) };
}

function RuleEditor({
  rule,
  roles,
  onChange,
}: {
  rule: ApprovalRule;
  roles: string[];
  onChange: (rule: ApprovalRule) => void;
}) {
  return (
    <div className="rule-editor">
      <select
        aria-label="Approval rule type"
        value={rule.type}
        onChange={event => onChange(defaultRule(
          event.target.value as 'all' | 'any' | 'n_of_m' | 'role',
          roles,
        ))}
      >
        <option value="all">All child rules</option>
        <option value="any">Any child rule</option>
        <option value="n_of_m">N of M approvers</option>
        <option value="role">One role</option>
      </select>
      {rule.type === 'role' && (
        <input
          aria-label="Required approver role"
          list="roles"
          value={rule.role}
          onChange={event => onChange({ ...rule, role: event.target.value })}
        />
      )}
      {rule.type === 'n_of_m' && (
        <div className="threshold-editor">
          <label>N <input type="number" min="1" value={rule.n} onChange={event => onChange({ ...rule, n: Number(event.target.value) })}/></label>
          <label>M <input type="number" min="1" value={rule.m} onChange={event => onChange({ ...rule, m: Number(event.target.value) })}/></label>
        </div>
      )}
      {(rule.type === 'all' || rule.type === 'any') && (
        <div className="rule-children">
          {rule.rules.map((child, index) => (
            <div className="rule-child" key={index}>
              <RuleEditor
                rule={child}
                roles={roles}
                onChange={next => onChange({
                  ...rule,
                  rules: rule.rules.map((item, childIndex) => childIndex === index ? next : item),
                })}
              />
              <button
                className="icon-button"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => onChange({ ...rule, rules: rule.rules.filter((_, childIndex) => childIndex !== index) })}
              >×</button>
            </div>
          ))}
          <button className="text-button" onClick={() => onChange({
            ...rule,
            rules: [...rule.rules, { type: 'role', role: roles[0] ?? '' }],
          })}>＋ Add role rule</button>
        </div>
      )}
    </div>
  );
}

function WorkflowBuilder() {
  const [workflow, setWorkflow] = useState<Workflow>(() => createWorkflow());
  const [savedWorkflows, setSavedWorkflows] = useState<WorkflowSummary[]>([]);
  const [storageError, setStorageError] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [active, setActive] = useState<'workflow' | 'runs'>('workflow');
  const [storageSaved, setStorageSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadPromise = useRef<Promise<{ workflow: Workflow; workflows: WorkflowSummary[] }> | undefined>(undefined);
  const errors = useMemo(() => validateWorkflow(workflow), [workflow]);
  const confirmed = workflow.status === 'confirmed' && Boolean(workflow.confirmedAt);

  useEffect(() => {
    let cancelled = false;
    if (!loadPromise.current) {
      loadPromise.current = (async () => {
        const workflows = await getWorkflows();
        const savedId = localStorage.getItem(WORKFLOW_ID_KEY);
        const workflowId = workflows.some(item => item.id === savedId)
          ? savedId
          : workflows[0]?.id;
        if (workflowId) {
          try {
            return { workflow: await getWorkflow(workflowId), workflows };
          } catch (error) {
            if (!(error instanceof ApiError) || error.status !== 404) throw error;
          }
        }
        const draft = await createWorkflowApi();
        return { workflow: draft, workflows: upsertWorkflowSummary(workflows, draft) };
      })();
    }
    void loadPromise.current
      .then(({ workflow: draft, workflows }) => {
        if (cancelled) return;
        localStorage.setItem(WORKFLOW_ID_KEY, draft.id);
        setWorkflow(draft);
        setSavedWorkflows(workflows);
        setStorageSaved(true);
        setStorageError(undefined);
        setLoaded(true);
      })
      .catch(error => {
        loadPromise.current = undefined;
        if (!cancelled) setStorageError(error instanceof Error ? error.message : 'Unable to connect to the workflow API.');
      });
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!loaded || confirmed) return;
    setStorageSaved(false);
    const timer = window.setTimeout(() => {
      void updateWorkflow(workflow)
        .then(saved => {
          setSavedWorkflows(current => upsertWorkflowSummary(current, saved));
          setStorageSaved(true);
          setStorageError(undefined);
        })
        .catch(error => {
          setStorageSaved(false);
          setStorageError(error instanceof Error ? error.message : 'Unable to save workflow changes.');
        });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [confirmed, loaded, workflow]);

  const patch = (updates: Partial<Workflow>) => {
    setWorkflow(current => markWorkflowEdited(current, updates));
  };

  const updateStage = (id: string, transform: (stage: Stage) => Stage) => {
    patch({ stages: workflow.stages.map(stage => stage.id === id ? transform(stage) : stage) });
  };

  const handleMessage = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    try {
      const updated = await sendMessage(workflow.id, prompt);
      setWorkflow(updated);
      setSavedWorkflows(current => upsertWorkflowSummary(current, updated));
      setStorageError(undefined);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to process this message.');
    }
    setPrompt('');
  };

  const exportWorkflow = async (format: 'json' | 'pdf') => {
    if (!confirmed) return;
    try {
      await downloadWorkflow(workflow.id, format);
      setStorageError(undefined);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : `Unable to export ${format.toUpperCase()}.`);
    }
  };

  const confirm = async () => {
    try {
      const updated = await confirmWorkflowApi(workflow.id);
      setWorkflow(updated);
      setSavedWorkflows(current => upsertWorkflowSummary(current, updated));
      setStorageError(undefined);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to confirm this workflow.');
    }
  };

  const selectWorkflow = async (workflowId: string) => {
    if (workflowId === workflow.id) return;
    try {
      if (!confirmed) {
        const saved = await updateWorkflow(workflow);
        setSavedWorkflows(current => upsertWorkflowSummary(current, saved));
      }
      const selected = await getWorkflow(workflowId);
      localStorage.setItem(WORKFLOW_ID_KEY, selected.id);
      setWorkflow(selected);
      setSavedWorkflows(current => upsertWorkflowSummary(current, selected));
      setStorageSaved(true);
      setStorageError(undefined);
      setPrompt('');
      setActive('workflow');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to open this workflow.');
    }
  };

  const loadExample = async (exampleId: 'experience_promos' | 'social_digital') => {
    try {
      if (!confirmed) {
        const saved = await updateWorkflow(workflow);
        setSavedWorkflows(current => upsertWorkflowSummary(current, saved));
      }
      const example = await getExample(exampleId);
      const draft = await createWorkflowApi(example);
      localStorage.setItem(WORKFLOW_ID_KEY, draft.id);
      setWorkflow(draft);
      setSavedWorkflows(current => upsertWorkflowSummary(current, draft));
      setStorageSaved(true);
      setStorageError(undefined);
      setActive('workflow');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to load this example.');
    }
  };

  const startNewDraft = async () => {
    try {
      if (!confirmed) {
        const saved = await updateWorkflow(workflow);
        setSavedWorkflows(current => upsertWorkflowSummary(current, saved));
      }
      const draft = await createWorkflowApi();
      localStorage.setItem(WORKFLOW_ID_KEY, draft.id);
      setWorkflow(draft);
      setSavedWorkflows(current => upsertWorkflowSummary(current, draft));
      setStorageSaved(true);
      setStorageError(undefined);
      setActive('workflow');
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'Unable to create a draft.');
    }
  };

  const addStage = () => {
    const stage: Stage = {
      id: crypto.randomUUID(),
      position: workflow.stages.length + 1,
      name: `Review stage ${workflow.stages.length + 1}`,
      participants: [{ role: 'Marketing', participation: 'approver', organizationType: 'Property' }],
      approvalRule: { type: 'role', role: 'Marketing' },
    };
    patch({ stages: [...workflow.stages, stage] });
  };

  if (!loaded) {
    return (
      <main className="api-loading">
        <h1>ApprovalLab Workflow Builder</h1>
        <p>{storageError ?? 'Connecting to the workflow API…'}</p>
        {storageError && <button className="primary" onClick={() => {
          setStorageError(undefined);
          setLoadAttempt(attempt => attempt + 1);
        }}>Retry connection</button>}
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><span className="brand-mark">A</span><span>APPROVALLAB<small>PROPERTY WORKFLOWS</small></span></div>
        <div className="rail-label">WORKSPACE</div>
        <button className={`nav ${active === 'workflow' ? 'selected' : ''}`} onClick={() => setActive('workflow')}><span>▦</span> Workflow builder</button>
        <button className={`nav ${active === 'runs' ? 'selected' : ''}`} onClick={() => setActive('runs')}><span>◷</span> Challenge runs <i>2</i></button>
        <div className="saved-workflows">
          <div className="saved-workflows-heading">MY WORKFLOWS</div>
          {savedWorkflows.length === 0
            ? <p className="workflow-list-empty">No saved workflows</p>
            : savedWorkflows.map(item => (
              <button
                className={`workflow-list-item ${item.id === workflow.id ? 'selected' : ''}`}
                key={item.id}
                title={`${item.name} · ${item.status.replaceAll('_', ' ')}`}
                aria-current={item.id === workflow.id ? 'page' : undefined}
                onClick={() => void selectWorkflow(item.id)}
              >
                <span className="workflow-list-name">{item.name}</span>
                <span className={`workflow-list-status ${item.status}`}>{item.status.replaceAll('_', ' ')}</span>
              </button>
            ))}
        </div>
        <div className="rail-bottom"><div className="avatar">HH</div><span>Harborview Hawks<small>Property workspace</small></span></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="crumb">Workflows <span>/</span> <b>{workflow.assetType}</b></div>
          <div className="top-actions">
            <span className="saved"><span className={storageSaved ? '' : 'dot-error'}></span>{storageSaved ? 'Saved to SQLite' : 'Not saved'}</span>
            <button className="quiet" disabled={!confirmed} onClick={() => void exportWorkflow('json')}>↓ Export JSON</button>
            <button className="primary" disabled={!confirmed} onClick={() => void exportWorkflow('pdf')}>Export workflow PDF <span>↗</span></button>
          </div>
        </header>

        <div className="page">
          {active === 'runs' ? (
            <section className="runs-page">
              <div className="eyebrow">CHALLENGE RUNS</div>
              <h1>Explore the sample workflows</h1>
              <p>Load a challenge example to review its stages, conditional routing, and documented assumptions.</p>
              <div className="run-cards">
                <button className="run-card card" onClick={() => void loadExample('experience_promos')}>
                  <span className="eyebrow">EXPERIENCE & PROMOS</span><b>Harborview Hawks — Activations & promotions</b>
                  <span>Conditional legal, player, venue, and league reviews</span>
                </button>
                <button className="run-card card" onClick={() => void loadExample('social_digital')}>
                  <span className="eyebrow">SOCIAL & DIGITAL</span><b>Harborview Hawks — Social & digital</b>
                  <span>Alternative Social/Digital or Marketing approval</span>
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="page-head">
                <div>
                  <div className="eyebrow">PROPERTY SETUP <span>•</span> {workflow.status.replaceAll('_', ' ').toUpperCase()}</div>
                  <h1>Workflow builder</h1>
                  <p>Describe the process, review what was captured, then confirm the exact version before exporting.</p>
                  {workflow.confirmedAt && <p className="confirmation-meta">Version {workflow.version} confirmed {new Date(workflow.confirmedAt).toLocaleString()}</p>}
                </div>
                <button className="outline" onClick={() => void startNewDraft()}>＋ New draft</button>
              </div>

              <div className="stepper">
                <div className="step current"><span>1</span><div><b>Describe</b><small>Add facts and clarify</small></div></div>
                <div className="step-line"></div>
                <div className={`step ${errors.length === 0 && workflow.unresolvedQuestions.length === 0 ? 'current' : ''}`}><span>2</span><div><b>Review workflow</b><small>Check and make changes</small></div></div>
                <div className="step-line"></div>
                <div className={`step ${confirmed ? 'current' : ''}`}><span>3</span><div><b>Export</b><small>Confirmed snapshot only</small></div></div>
              </div>

              <section className="describe card">
                <div className="section-title">
                  <div><span className="section-icon">✳</span><div><h2>Describe your approval process</h2><p>Send multiple messages; clear facts are merged into this draft.</p></div></div>
                  <span className="ai-tag">RULE-BASED EXTRACTION</span>
                </div>
                <div className="conversation" aria-live="polite">
                  {workflow.conversation.length === 0
                    ? <p className="conversation-empty">Try an example, or add a description below. Extraction is deterministic and will ask when approval language is ambiguous.</p>
                    : workflow.conversation.map((message, index) => (
                      <div className={`message ${message.role}`} key={`${message.createdAt}-${index}`}>
                        <b>{message.role === 'user' ? 'You' : 'ApprovalLab'}</b><span>{message.content}</span>
                      </div>
                    ))}
                </div>
                <form onSubmit={handleMessage}>
                  <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="For example: Either Social/Digital or Marketing may approve; the total workflow limit is three business days." aria-label="Describe your approval process"/>
                  <div className="describe-footer">
                    <span>Messages are processed by the backend workflow service.</span>
                    <button className="primary" type="submit" disabled={!prompt.trim()}>Add message <span>→</span></button>
                  </div>
                </form>
                <div className="examples"><span>Load challenge:</span><button onClick={() => void loadExample('experience_promos')}>Experience & Promos</button><button onClick={() => void loadExample('social_digital')}>Social & Digital</button></div>
              </section>

              {workflow.unresolvedQuestions.length > 0 && (
                <section className="clarifications card" aria-live="polite">
                  <h2>Clarification needed</h2>
                  {workflow.unresolvedQuestions.map(question => (
                    <p key={question}>{formatClarification(question)}</p>
                  ))}
                  <small>Reply in the conversation above; exports stay locked until every question is resolved.</small>
                </section>
              )}

              <div className="review-head">
                <div><div className="eyebrow">CANONICAL WORKFLOW · VERSION {workflow.version}</div><h2>Review and refine</h2><p>JSON and PDF exports will use this same confirmed snapshot.</p></div>
                <button className="outline" onClick={addStage}>＋ Add stage</button>
              </div>

              <div className="workspace">
                <div className="workflow-column">
                  <section className="summary-card card">
                    <div className="summary-title">
                      <div><small>WORKFLOW FOR</small><input className="asset-input" list="asset-types" value={workflow.assetType} onChange={event => patch({ assetType: event.target.value })}/></div>
                      <span className={`status-chip ${confirmed ? 'confirmed' : ''}`}>● {workflow.status.replaceAll('_', ' ')}</span>
                    </div>
                    <datalist id="asset-types">{ASSET_TYPES.map(value => <option key={value} value={value}/>)}</datalist>
                    <div className="meta-row">
                      <label>Workflow name<input value={workflow.name} onChange={event => patch({ name: event.target.value })}/></label>
                      <label>Workflow owner<input list="roles" value={workflow.owner} onChange={event => patch({ owner: event.target.value })}/></label>
                    </div>
                    <datalist id="roles">{roleOptions.map(value => <option key={value} value={value}/>)}</datalist>
                    <div className="time-limits">
                      <TimeLimitEditor label="Intake" value={workflow.intakeTimeLimit} onChange={value => patch({ intakeTimeLimit: value })}/>
                      <TimeLimitEditor label="Final decision" value={workflow.finalDecisionTimeLimit} onChange={value => patch({ finalDecisionTimeLimit: value })}/>
                      <TimeLimitEditor label="Total workflow" value={workflow.totalTimeLimit} onChange={value => patch({ totalTimeLimit: value })}/>
                    </div>
                    <label className="list-editor">People in the know (viewers)
                      <input value={workflow.viewers.join(', ')} placeholder="Comma-separated roles" onChange={event => patch({ viewers: event.target.value.split(',').map(item => item.trim()).filter(Boolean) })}/>
                    </label>
                  </section>

                  {workflow.stages.map((stage, index) => {
                    const approverRoles = stage.participants
                      .filter(person => person.participation === 'approver')
                      .map(person => person.role);
                    workflow.conditions.filter(condition => condition.stageId === stage.id && condition.participation === 'approver')
                      .forEach(condition => approverRoles.push(condition.role));
                    return (
                      <div className="stage-wrap" key={stage.id}>
                        <div className="stage-number">{String(index + 1).padStart(2, '0')}</div>
                        <section className="stage-card card">
                          <div className="stage-top">
                            <input aria-label="Stage name" className="stage-name" value={stage.name} onChange={event => updateStage(stage.id, current => ({ ...current, name: event.target.value }))}/>
                            <button className="icon-button" aria-label="Move stage up" disabled={index === 0} onClick={() => {
                              const stages = [...workflow.stages];
                              [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]];
                              patch({ stages: stages.map((item, position) => ({ ...item, position: position + 1 })) });
                            }}>↑</button>
                            <button className="icon-button" aria-label="Move stage down" disabled={index === workflow.stages.length - 1} onClick={() => {
                              const stages = [...workflow.stages];
                              [stages[index + 1], stages[index]] = [stages[index], stages[index + 1]];
                              patch({ stages: stages.map((item, position) => ({ ...item, position: position + 1 })) });
                            }}>↓</button>
                            <button className="icon-button" aria-label="Remove stage" onClick={() => patch({
                              stages: workflow.stages.filter(item => item.id !== stage.id).map((item, position) => ({ ...item, position: position + 1 })),
                              conditions: workflow.conditions.filter(condition => condition.stageId !== stage.id),
                            })}>×</button>
                          </div>
                          <TimeLimitEditor label="Stage time limit" value={stage.timeLimit} onChange={value => updateStage(stage.id, current => ({ ...current, timeLimit: value }))}/>
                          <div className="people-heading">PARTICIPANTS <span>Approvers contribute to the rule; consultative participants do not block progress.</span></div>
                          <div className="people">
                            {stage.participants.map((person, personIndex) => (
                              <div className="person" key={`${stage.id}-${personIndex}`}>
                                <input aria-label="Participant role" list="roles" value={person.role} onChange={event => updateStage(stage.id, current => ({
                                  ...current,
                                  participants: current.participants.map((item, itemIndex) => itemIndex === personIndex ? { ...item, role: event.target.value } : item),
                                }))}/>
                                <select aria-label="Participation" value={person.participation} onChange={event => updateStage(stage.id, current => ({
                                  ...current,
                                  participants: current.participants.map((item, itemIndex) => itemIndex === personIndex ? { ...item, participation: event.target.value as Participation } : item),
                                }))}>
                                  <option value="approver">Approver</option><option value="consultative">Consultative</option><option value="viewer">Viewer</option>
                                </select>
                                <select aria-label="Organization type" value={person.organizationType ?? 'custom'} onChange={event => updateStage(stage.id, current => ({
                                  ...current,
                                  participants: current.participants.map((item, itemIndex) => itemIndex === personIndex ? { ...item, organizationType: event.target.value as Participant['organizationType'] } : item),
                                }))}>
                                  <option value="Property">Property</option><option value="outside organization">Outside organization</option><option value="custom">Custom</option>
                                </select>
                                <button className="icon-button" aria-label="Remove participant" onClick={() => updateStage(stage.id, current => ({ ...current, participants: current.participants.filter((_, itemIndex) => itemIndex !== personIndex) }))}>×</button>
                              </div>
                            ))}
                            <button className="text-button" onClick={() => updateStage(stage.id, current => ({
                              ...current,
                              participants: [...current.participants, { role: '', participation: 'approver' }],
                            }))}>＋ Add participant</button>
                          </div>
                          <div className="approval-block"><b>Approval rule</b><RuleEditor rule={stage.approvalRule} roles={approverRoles} onChange={approvalRule => updateStage(stage.id, current => ({ ...current, approvalRule }))}/></div>
                          <label className="list-editor">Stage applies when (optional conditions)
                            <input value={(stage.appliesWhen ?? []).join(', ')} placeholder="Comma-separated condition names" onChange={event => updateStage(stage.id, current => ({
                              ...current,
                              appliesWhen: event.target.value.split(',').map(item => item.trim()).filter(Boolean),
                            }))}/>
                          </label>
                        </section>
                      </div>
                    );
                  })}

                  <section className="conditions-card card">
                    <div className="conditions-heading">
                      <div><span className="section-icon amber">◇</span><div><h3>Conditional routing</h3><p>Keep custom conditions and their effects explicit.</p></div></div>
                      <button className="text-button" disabled={workflow.stages.length === 0} onClick={() => patch({
                        conditions: [...workflow.conditions, {
                          id: crypto.randomUUID(),
                          condition: '',
                          effect: 'add-participant',
                          role: '',
                          participation: 'approver',
                          stageId: workflow.stages[0].id,
                        }],
                      })}>＋ Add condition</button>
                    </div>
                    {workflow.conditions.length === 0
                      ? <div className="empty-condition">No conditional reviewers yet</div>
                      : workflow.conditions.map((condition, index) => (
                        <div className="condition-row" key={condition.id}>
                          <span className="if-label">IF</span>
                          <input aria-label="Condition" list="conditions" value={condition.condition} onChange={event => patch({ conditions: workflow.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, condition: event.target.value } : item) })}/>
                          <span className="then-label">THEN</span>
                          <select aria-label="Condition effect" value={condition.effect} onChange={event => patch({ conditions: workflow.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, effect: event.target.value as typeof condition.effect } : item) })}>
                            <option value="add-participant">Add participant</option><option value="change-participation">Change participation</option>
                          </select>
                          <input aria-label="Conditional role" list="roles" value={condition.role} onChange={event => patch({ conditions: workflow.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, role: event.target.value } : item) })}/>
                          <select aria-label="Conditional participation" value={condition.participation} onChange={event => patch({ conditions: workflow.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, participation: event.target.value as Participation } : item) })}>
                            <option value="approver">Approver</option><option value="consultative">Consultative</option><option value="viewer">Viewer</option>
                          </select>
                          <select aria-label="Condition stage" value={condition.stageId} onChange={event => patch({ conditions: workflow.conditions.map((item, itemIndex) => itemIndex === index ? { ...item, stageId: event.target.value } : item) })}>
                            {workflow.stages.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                          </select>
                          <button className="icon-button" aria-label="Remove condition" onClick={() => patch({ conditions: workflow.conditions.filter((_, itemIndex) => itemIndex !== index) })}>×</button>
                        </div>
                      ))}
                    <datalist id="conditions">{CONDITIONS.map(value => <option key={value} value={value}/>)}</datalist>
                  </section>

                  <section className="notes-card card">
                    <label>Assumptions<textarea value={workflow.assumptions.join('\n')} onChange={event => patch({ assumptions: event.target.value.split('\n').filter(Boolean) })}/></label>
                    <label>Notes<textarea value={workflow.notes.join('\n')} onChange={event => patch({ notes: event.target.value.split('\n').filter(Boolean) })}/></label>
                  </section>
                </div>

                <aside className="side-column">
                  <section className="side-card card">
                    <div className="side-title"><span className="section-icon">⌘</span><div><h3>Workflow overview</h3><p>Ordered review path</p></div></div>
                    <div className="mini-flow">
                      <div className="mini-node">Intake<span>{workflow.owner} · {formatTime(workflow.intakeTimeLimit)}</span></div>
                      {workflow.stages.map(stage => <div className="mini-node" key={stage.id}>{stage.name}<span>{stage.participants.length + workflow.conditions.filter(condition => condition.stageId === stage.id).length} participant(s) · {formatTime(stage.timeLimit)}</span></div>)}
                      <div className="mini-node decision">Final decision<span>{workflow.owner} · {formatTime(workflow.finalDecisionTimeLimit)}</span></div>
                    </div>
                    <div className="total-chip">Complete within <b>{formatTime(workflow.totalTimeLimit)}</b></div>
                  </section>
                  <section className="side-card card">
                    <div className="side-title"><span className="section-icon green">✓</span><div><h3>Confirmation checks</h3><p>Version {workflow.version}</p></div></div>
                    {errors.map(error => <div className="check-row warn" key={error}>! &nbsp;{error}</div>)}
                    {workflow.unresolvedQuestions.map(question => <div className="check-row warn" key={question}>? &nbsp;Clarification unresolved</div>)}
                    {!errors.length && !workflow.unresolvedQuestions.length && <div className="check-row">✓ &nbsp;Workflow is ready for review</div>}
                    {confirmed && <div className="check-row">✓ &nbsp;Confirmed {new Date(workflow.confirmedAt!).toLocaleString()}</div>}
                  </section>
                  <section className="side-card note-card"><b>Persistence and exports</b><p>The draft and conversation are saved by the backend. PDF and JSON downloads are enabled only for a confirmed version.</p></section>
                </aside>
              </div>

              <div className="bottom-bar">
                <span><span className={storageSaved ? 'green-dot' : 'red-dot'}></span>{storageSaved ? 'Changes saved to backend' : 'Backend save failed'}</span>
                <div>
                  <button className="quiet" onClick={() => void startNewDraft()}>Reset draft</button>
                  <button className="primary" disabled={!canConfirm(workflow)} onClick={confirm}>{confirmed ? 'Confirm revised version' : 'Confirm workflow'} <span>→</span></button>
                </div>
              </div>
            </>
          )}
          {storageError && <div role="alert" className="storage-error">{storageError}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setStorageError(undefined)}>×</button></div>}
        </div>
      </main>
    </div>
  );
}

export default WorkflowBuilder;
