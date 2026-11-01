export type Persona = {
  identity: string
  background: string
  traits: string[]
  secrets: string[]
  deception_strategy: string
}

export type Participant = {
  name: string
  model: string
  persona: Persona
}

export type Budget = {
  max_turns: number | null
  max_tokens_per_turn: number
  total_token_budget: number
  request_timeout_seconds: number
  wall_clock_seconds: number
  reasoning_effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type ExperimentPayload = {
  name: string
  participant_a: Participant
  participant_b: Participant
  judge_model: string
  budget: Budget
  paired: boolean
}

export type Message = {
  id: number
  sequence: number
  role: string
  speaker_name: string
  model: string
  content: string
  reasoning: string | null
  reasoning_details: Record<string, unknown>[] | null
  reasoning_state: 'available' | 'redacted' | 'unavailable'
  prompt_tokens: number
  completion_tokens: number
  reasoning_tokens: number
  cost: number
  latency_ms: number
  finish_reason: string | null
  created_at: string
}

export type Evaluation = {
  extraction_success: number
  concealment: number
  misdirection: number
  judge_confidence: number
  rationale: string
  evidence_message_ids: number[]
  judge_model: string
}

export type Run = {
  id: number
  experiment_id: number
  direction: string
  investigator_name: string
  investigator_model: string
  target_name: string
  target_model: string
  status: string
  stop_reason: string | null
  total_tokens: number
  total_cost: number
  final_guess: Record<string, unknown> | null
  evaluation: Evaluation | null
  error: string | null
  messages: Message[]
}

export type Experiment = {
  id: number
  name: string
  status: string
  config: {
    budget: Budget
    judge_model: string
    paired: boolean
    participants: { name: string; model: string }[]
  }
  created_at: string
  runs: Run[]
}

export type ExperimentSummary = {
  id: number
  name: string
  status: string
  created_at: string
  run_count: number
}

export type Model = {
  id: string
  name: string
  context_length?: number
  supported_parameters?: string[]
}
