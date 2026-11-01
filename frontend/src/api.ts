import type { Experiment, ExperimentPayload, ExperimentSummary, Model } from './types'

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: response.statusText }))
    throw new Error(body.detail ?? `Request failed: ${response.status}`)
  }
  if (response.status === 204) return undefined as T
  return response.json()
}

export const api = {
  listModels: () => request<Model[]>('/models'),
  listExperiments: () => request<ExperimentSummary[]>('/experiments'),
  getExperiment: (id: number) => request<Experiment>(`/experiments/${id}`),
  createExperiment: (payload: ExperimentPayload) =>
    request<Experiment>('/experiments', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteExperiment: (id: number) =>
    request<void>(`/experiments/${id}`, { method: 'DELETE' }),
  startExperiment: (id: number) =>
    request<{ status: string }>(`/experiments/${id}/start`, { method: 'POST' }),
  stopExperiment: (id: number) =>
    request<{ status: string }>(`/experiments/${id}/stop`, { method: 'POST' }),
  revealPersonas: (experimentId: number, runId: number) =>
    request<{
      run_id: number
      investigator_persona: Record<string, unknown>
      target_persona: Record<string, unknown>
    }>(`/experiments/${experimentId}/runs/${runId}/personas`),
  eventUrl: (id: number) => `${API}/experiments/${id}/events`,
}
