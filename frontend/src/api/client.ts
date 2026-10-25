import type { Workflow, WorkflowSummary } from '../domain/workflow';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000/api';
let mutationQueue: Promise<unknown> = Promise.resolve();

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) message = payload.detail;
    } catch {
      message = `Request failed (${response.status} ${response.statusText}).`;
    }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function createWorkflow(workflow?: Workflow): Promise<Workflow> {
  return serializeMutation(() => request('/workflows', {
      method: 'POST',
      headers: workflow ? { 'Content-Type': 'application/json' } : undefined,
      body: workflow ? JSON.stringify(workflow) : undefined,
    }));
}

export function getWorkflow(workflowId: string): Promise<Workflow> {
  return request(`/workflows/${encodeURIComponent(workflowId)}`);
}

export function getWorkflows(): Promise<WorkflowSummary[]> {
  return request('/workflows');
}

export function updateWorkflow(workflow: Workflow): Promise<Workflow> {
  return serializeMutation(() => request(`/workflows/${encodeURIComponent(workflow.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    }));
}

export function sendMessage(workflowId: string, content: string): Promise<Workflow> {
  return serializeMutation(() => request(`/workflows/${encodeURIComponent(workflowId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }));
}

export function confirmWorkflow(workflowId: string): Promise<Workflow> {
  return serializeMutation(() => request(`/workflows/${encodeURIComponent(workflowId)}/confirm`, { method: 'POST' }));
}

export function getExample(exampleId: 'experience_promos' | 'social_digital'): Promise<Workflow> {
  return request(`/examples/${exampleId}`);
}

export async function downloadWorkflow(workflowId: string, format: 'json' | 'pdf'): Promise<void> {
  const response = await fetch(`${API_BASE}/workflows/${encodeURIComponent(workflowId)}/export/${format}`);
  if (!response.ok) {
    let message = `Export failed (${response.status}).`;
    try {
      const payload = await response.json() as { detail?: string };
      if (payload.detail) message = payload.detail;
    } catch {
      message = `Export failed (${response.status} ${response.statusText}).`;
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${workflowId}.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
