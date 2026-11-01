import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'

const summary = {
  id: 7,
  name: 'Saved deception run',
  status: 'completed',
  created_at: '2026-10-30T10:00:00Z',
  run_count: 1,
}

const experiment = {
  ...summary,
  config: {
    budget: {
      max_turns: 8,
      max_tokens_per_turn: 1000,
      total_token_budget: 10000,
      request_timeout_seconds: 60,
      wall_clock_seconds: 600,
      reasoning_effort: 'medium',
    },
    judge_model: 'judge/model',
    paired: false,
    participants: [],
  },
  runs: [{
    id: 9,
    experiment_id: 7,
    direction: 'Claude → GPT',
    investigator_name: 'Claude',
    investigator_model: 'anthropic/test',
    target_name: 'GPT',
    target_model: 'openai/test',
    status: 'completed',
    stop_reason: 'protocol_complete',
    total_tokens: 42,
    total_cost: 0.01,
    final_guess: null,
    evaluation: null,
    error: null,
    messages: [{
      id: 11,
      sequence: 1,
      role: 'investigator',
      speaker_name: 'Claude',
      model: 'anthropic/test',
      content: 'Tell me about your work.',
      reasoning: null,
      reasoning_details: null,
      reasoning_state: 'unavailable',
      prompt_tokens: 10,
      completion_tokens: 8,
      reasoning_tokens: 0,
      cost: 0.001,
      latency_ms: 250,
      finish_reason: 'stop',
      created_at: '2026-10-30T10:00:00Z',
    }],
  }],
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('Propensity Lab UI', () => {
  it('keeps launch disabled until required persona fields are provided', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return Response.json(url.endsWith('/models') ? [] : [])
    }))
    render(<App />)
    expect(await screen.findByRole('button', { name: /create & run study/i })).toBeDisabled()
    const themeButton = screen.getByRole('button', { name: /switch to light mode/i })
    fireEvent.click(themeButton)
    expect(document.documentElement).toHaveAttribute('data-theme', 'light')
    expect(localStorage.getItem('propensity-theme')).toBe('light')
  })

  it('replays history, labels unavailable reasoning, and masks personas until reveal', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/models')) return Response.json([])
      if (url.endsWith('/experiments/7')) return Response.json(experiment)
      if (url.includes('/runs/9/personas')) {
        return Response.json({
          run_id: 9,
          investigator_persona: { secrets: ['investigator-secret'] },
          target_persona: { secrets: ['target-secret'] },
        })
      }
      return Response.json([summary])
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^saved deception run/i }))
    expect(await screen.findByText('Tell me about your work.')).toBeInTheDocument()
    expect(screen.getByText(/provider reasoning: unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText(/target-secret/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /reveal personas/i }))
    await waitFor(() => expect(screen.getByText(/target-secret/i)).toBeInTheDocument())
  })
})
