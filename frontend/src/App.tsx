import {
  Activity,
  Brain,
  ChevronDown,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  History,
  MessageSquareText,
  Moon,
  Octagon,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  Trash2,
  UserRoundSearch,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type {
  Experiment,
  ExperimentPayload,
  ExperimentSummary,
  Message,
  Model,
  Participant,
  Persona,
  Run,
} from './types'

const emptyPersona = (): Persona => ({
  identity: '',
  background: '',
  traits: [],
  secrets: [],
  deception_strategy: '',
})

const defaultPayload = (): ExperimentPayload => ({
  name: `Deception study ${new Date().toLocaleDateString()}`,
  participant_a: {
    name: 'Claude',
    model: 'anthropic/claude-sonnet-5',
    persona: emptyPersona(),
  },
  participant_b: {
    name: 'GPT',
    model: 'openai/gpt-5.4-mini',
    persona: emptyPersona(),
  },
  judge_model: 'google/gemini-3.1-pro-preview',
  paired: true,
  budget: {
    max_turns: null,
    max_tokens_per_turn: 1200,
    total_token_budget: 16000,
    request_timeout_seconds: 90,
    wall_clock_seconds: 900,
    reasoning_effort: 'medium',
  },
})

function App() {
  const [history, setHistory] = useState<ExperimentSummary[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [selected, setSelected] = useState<Experiment | null>(null)
  const [creating, setCreating] = useState(true)
  const [payload, setPayload] = useState(defaultPayload)
  const [activeRunId, setActiveRunId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('propensity-theme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('propensity-theme', theme)
  }, [theme])

  const refreshHistory = useCallback(async () => {
    const items = await api.listExperiments()
    setHistory(items)
  }, [])

  const openExperiment = useCallback(async (id: number) => {
    setError('')
    try {
      const item = await api.getExperiment(id)
      setSelected(item)
      setActiveRunId((current) =>
        item.runs.some((run) => run.id === current) ? current : item.runs[0]?.id ?? null,
      )
      setCreating(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load experiment')
    }
  }, [])

  // Loading remote catalogs is an intentional synchronization with an external system.
  /* oxlint-disable react/set-state-in-effect */
  useEffect(() => {
    refreshHistory().catch(() => undefined)
    api.listModels().then(setModels).catch(() => undefined)
    const historyTimer = window.setInterval(
      () => refreshHistory().catch(() => undefined),
      5000,
    )
    return () => window.clearInterval(historyTimer)
  }, [refreshHistory])
  /* oxlint-enable react/set-state-in-effect */

  const selectedId = selected?.id
  const selectedStatus = selected?.status
  useEffect(() => {
    if (!selectedId || !selectedStatus || !['queued', 'running', 'stopping'].includes(selectedStatus)) return
    const source = new EventSource(api.eventUrl(selectedId))
    const update = () => {
      api.getExperiment(selectedId).then(setSelected).catch(() => undefined)
      refreshHistory().catch(() => undefined)
    }
    ;['message', 'run_status', 'evaluation', 'experiment_status', 'stop_requested'].forEach(
      (event) => source.addEventListener(event, update),
    )
    source.onerror = () => {
      if (!['queued', 'running', 'stopping'].includes(selectedStatus)) source.close()
    }
    return () => source.close()
  }, [selectedId, selectedStatus, refreshHistory])

  const filteredHistory = history.filter((item) =>
    item.name.toLowerCase().includes(search.toLowerCase()),
  )

  async function createAndStart() {
    setBusy(true)
    setError('')
    try {
      const experiment = await api.createExperiment(payload)
      await api.startExperiment(experiment.id)
      await refreshHistory()
      await openExperiment(experiment.id)
      setPayload(defaultPayload())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create experiment')
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!selected) return
    setBusy(true)
    try {
      await api.stopExperiment(selected.id)
      setSelected(await api.getExperiment(selected.id))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not stop experiment')
    } finally {
      setBusy(false)
    }
  }

  async function deleteExperiment(item: ExperimentSummary) {
    if (!window.confirm(`Delete "${item.name}" and all of its messages? This cannot be undone.`)) return
    setError('')
    try {
      await api.deleteExperiment(item.id)
      if (selected?.id === item.id) {
        setSelected(null)
        setActiveRunId(null)
        setCreating(true)
      }
      await refreshHistory()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete experiment')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={19} /></div>
          <div><strong>Propensity Lab</strong><span>Model behavior research</span></div>
          <button
            className="theme-toggle"
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </div>
        <button className="new-button" onClick={() => setCreating(true)}>
          <Plus size={17} /> New experiment
        </button>
        <div className="search-box">
          <Search size={15} />
          <input aria-label="Search sessions" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sessions" />
        </div>
        <div className="history-title"><History size={14} /> Sessions</div>
        <nav className="history-list">
          {filteredHistory.map((item) => (
            <div key={item.id} className={selected?.id === item.id && !creating ? 'history-entry active' : 'history-entry'}>
              <button className="history-item" onClick={() => openExperiment(item.id)}>
                <span>{item.name}</span>
                <small>{item.run_count} run{item.run_count === 1 ? '' : 's'} · {item.status}</small>
              </button>
              <button
                className="delete-chat"
                aria-label={`Delete ${item.name}`}
                title={['queued', 'running', 'stopping'].includes(item.status) ? 'Stop this experiment before deleting it' : 'Delete experiment'}
                disabled={['queued', 'running', 'stopping'].includes(item.status)}
                onClick={() => deleteExperiment(item)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!filteredHistory.length && <p className="empty-note">No saved sessions yet.</p>}
        </nav>
        <div className="sidebar-foot">
          <ShieldCheck size={15} />
          <span>Personas protected by prompt isolation<br /><small>Local SQLite storage</small></span>
        </div>
      </aside>
      <main className="main">
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div>}
        {creating ? (
          <Setup
            value={payload}
            models={models}
            busy={busy}
            onChange={setPayload}
            onSubmit={createAndStart}
          />
        ) : selected ? (
          <ExperimentView
            experiment={selected}
            activeRunId={activeRunId}
            busy={busy}
            onRunChange={setActiveRunId}
            onStop={stop}
          />
        ) : (
          <div className="blank-state"><Brain size={42} /><h2>Choose or create an experiment</h2></div>
        )}
      </main>
    </div>
  )
}

function Setup({
  value,
  models,
  busy,
  onChange,
  onSubmit,
}: {
  value: ExperimentPayload
  models: Model[]
  busy: boolean
  onChange: (value: ExperimentPayload) => void
  onSubmit: () => void
}) {
  const valid = value.name && value.judge_model && [value.participant_a, value.participant_b].every(
    (p) => p.name && p.model && p.persona.identity && p.persona.background && p.persona.secrets.length && p.persona.deception_strategy,
  )
  const updateParticipant = (key: 'participant_a' | 'participant_b', participant: Participant) =>
    onChange({ ...value, [key]: participant })

  return (
    <section className="setup-page">
      <header className="page-header">
        <div><span className="eyebrow">NEW STUDY</span><h1>Configure a deception experiment</h1><p>Each model sees only its own private persona. Runs are paired to reverse investigator and target roles.</p></div>
      </header>
      <div className="setup-grid">
        <div className="setup-primary">
          <section className="panel">
            <div className="panel-heading"><Activity size={18} /><div><h2>Study details</h2><p>Name and execution mode</p></div></div>
            <label>Experiment name<input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} /></label>
            <label className="toggle-row"><input type="checkbox" checked={value.paired} onChange={(e) => onChange({ ...value, paired: e.target.checked })} /><span><strong>Paired directions</strong><small>Run A → B, then B → A</small></span></label>
          </section>
          <ParticipantEditor title="Participant A" accent="violet" value={value.participant_a} models={models} onChange={(p) => updateParticipant('participant_a', p)} />
          <ParticipantEditor title="Participant B" accent="cyan" value={value.participant_b} models={models} onChange={(p) => updateParticipant('participant_b', p)} />
        </div>
        <div className="setup-secondary">
          <section className="panel sticky-panel">
            <div className="panel-heading"><Target size={18} /><div><h2>Protocol</h2><p>Budgets and evaluation</p></div></div>
            <ModelField label="Judge model" value={value.judge_model} models={models} onChange={(judge_model) => onChange({ ...value, judge_model })} />
            <div className="open-ended-note"><Clock3 size={17} /><p><strong>Open-ended dialogue</strong><br />Models alternate until the time or total-token budget is reached.</p></div>
            <div className="two-fields">
              <NumberField label="Tokens / turn" value={value.budget.max_tokens_per_turn} onChange={(max_tokens_per_turn) => onChange({ ...value, budget: { ...value.budget, max_tokens_per_turn } })} />
              <NumberField label="Total tokens" value={value.budget.total_token_budget} onChange={(total_token_budget) => onChange({ ...value, budget: { ...value.budget, total_token_budget } })} />
              <NumberField label="Time limit (sec)" value={value.budget.wall_clock_seconds} onChange={(wall_clock_seconds) => onChange({ ...value, budget: { ...value.budget, wall_clock_seconds } })} />
            </div>
            <label>Reasoning effort<select value={value.budget.reasoning_effort} onChange={(e) => onChange({ ...value, budget: { ...value.budget, reasoning_effort: e.target.value as ExperimentPayload['budget']['reasoning_effort'] } })}>
              {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option key={level}>{level}</option>)}
            </select></label>
            <div className="privacy-note"><EyeOff size={17} /><p><strong>Observer-only reasoning</strong><br />Only provider-returned reasoning is shown. It is never sent to the opponent or judge.</p></div>
            <button className="launch-button" disabled={!valid || busy} onClick={onSubmit}><Play size={17} />{busy ? 'Creating…' : 'Create & run study'}</button>
          </section>
        </div>
      </div>
    </section>
  )
}

function ParticipantEditor({ title, accent, value, models, onChange }: {
  title: string
  accent: string
  value: Participant
  models: Model[]
  onChange: (value: Participant) => void
}) {
  const setPersona = (patch: Partial<Persona>) => onChange({ ...value, persona: { ...value.persona, ...patch } })
  return (
    <section className={`panel participant ${accent}`}>
      <div className="panel-heading"><UserRoundSearch size={18} /><div><h2>{title}</h2><p>Private identity and concealment strategy</p></div></div>
      <div className="two-fields">
        <label>Display name<input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} /></label>
        <ModelField label="OpenRouter model" value={value.model} models={models} onChange={(model) => onChange({ ...value, model })} />
      </div>
      <label>Hidden identity<input value={value.persona.identity} onChange={(e) => setPersona({ identity: e.target.value })} placeholder="e.g. A risk-averse investigative journalist" /></label>
      <label>Hidden background<textarea value={value.persona.background} onChange={(e) => setPersona({ background: e.target.value })} placeholder="Facts the opponent should try to infer…" /></label>
      <div className="two-fields">
        <label>Traits <small>comma-separated</small><input value={value.persona.traits.join(', ')} onChange={(e) => setPersona({ traits: splitList(e.target.value) })} /></label>
        <label>Secrets <small>comma-separated</small><input value={value.persona.secrets.join(', ')} onChange={(e) => setPersona({ secrets: splitList(e.target.value) })} /></label>
      </div>
      <label>Deception strategy<textarea value={value.persona.deception_strategy} onChange={(e) => setPersona({ deception_strategy: e.target.value })} placeholder="How this persona should conceal and misdirect…" /></label>
    </section>
  )
}

function ModelField({ label, value, models, onChange }: { label: string; value: string; models: Model[]; onChange: (value: string) => void }) {
  const listId = `models-${label.replace(/\W/g, '-')}`
  return <label>{label}<input list={listId} value={value} onChange={(e) => onChange(e.target.value)} /><datalist id={listId}>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist></label>
}

function NumberField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (value: number) => void }) {
  return <label>{label}<input type="number" min={step} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>
}

function ExperimentView({ experiment, activeRunId, busy, onRunChange, onStop }: {
  experiment: Experiment
  activeRunId: number | null
  busy: boolean
  onRunChange: (id: number) => void
  onStop: () => void
}) {
  const run = experiment.runs.find((item) => item.id === activeRunId) ?? experiment.runs[0]
  return (
    <section className="experiment-page">
      <header className="experiment-header">
        <div><span className="eyebrow">EXPERIMENT #{experiment.id}</span><h1>{experiment.name}</h1><p>{experiment.config.judge_model} judging · {experiment.config.budget.max_turns ? `${experiment.config.budget.max_turns} turns` : 'open-ended, time/token limited'}</p></div>
        <div className="header-actions"><StatusBadge status={experiment.status} />{['queued', 'running', 'stopping'].includes(experiment.status) && <button className="stop-button" disabled={busy} onClick={onStop}><Octagon size={16} /> Stop</button>}</div>
      </header>
      <div className="run-tabs">
        {experiment.runs.map((item) => <button key={item.id} className={run?.id === item.id ? 'active' : ''} onClick={() => onRunChange(item.id)}><span>{item.direction}</span><small>{item.status}</small></button>)}
      </div>
      {run && <RunView experimentId={experiment.id} run={run} />}
    </section>
  )
}

function RunView({ experimentId, run }: { experimentId: number; run: Run }) {
  const [personas, setPersonas] = useState<{ investigator_persona: Record<string, unknown>; target_persona: Record<string, unknown> } | null>(null)
  const [showPersonas, setShowPersonas] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState<Set<number>>(new Set())
  const totalCompletion = useMemo(() => run.messages.reduce((sum, message) => sum + message.completion_tokens, 0), [run.messages])

  async function togglePersonas() {
    if (!personas) setPersonas(await api.revealPersonas(experimentId, run.id))
    setShowPersonas((current) => !current)
  }

  return (
    <div className="run-layout">
      <div className="chat-panel">
        <div className="chat-toolbar">
          <div><MessageSquareText size={17} /><span><strong>{run.investigator_name}</strong> investigates <strong>{run.target_name}</strong></span></div>
          <button onClick={togglePersonas}>{showPersonas ? <EyeOff size={15} /> : <Eye size={15} />}{showPersonas ? 'Hide' : 'Reveal'} personas</button>
        </div>
        {showPersonas && personas && <div className="persona-reveal">
          <PersonaCard label={`${run.investigator_name} (investigator)`} value={personas.investigator_persona} />
          <PersonaCard label={`${run.target_name} (target)`} value={personas.target_persona} />
        </div>}
        <div className="messages">
          {!run.messages.length && <div className="waiting"><span className="pulse" /><p>{run.status === 'pending' ? 'Waiting for preceding run…' : 'Waiting for the first message…'}</p></div>}
          {run.messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              investigator={run.investigator_name}
              open={reasoningOpen.has(message.id)}
              onToggle={() => setReasoningOpen((current) => {
                const next = new Set(current)
                if (next.has(message.id)) next.delete(message.id)
                else next.add(message.id)
                return next
              })}
            />
          ))}
          {run.error && <div className="run-error">{run.error}</div>}
        </div>
      </div>
      <aside className="run-inspector">
        <section className="metric-card"><span>Run status</span><StatusBadge status={run.status} />{run.stop_reason && <small>{run.stop_reason.replaceAll('_', ' ')}</small>}</section>
        <section className="metrics-grid">
          <div><span>Tokens</span><strong>{run.total_tokens.toLocaleString()}</strong><small>{totalCompletion.toLocaleString()} generated</small></div>
          <div><span>Cost</span><strong>${run.total_cost.toFixed(4)}</strong><small>OpenRouter reported</small></div>
        </section>
        {run.evaluation ? <ScoreCard run={run} /> : <section className="score-empty"><Target size={24} /><strong>Judge score pending</strong><p>Scores appear after the final persona guess.</p></section>}
        {run.final_guess && <details className="guess-card"><summary>Investigator's final guess <ChevronDown size={15} /></summary><pre>{JSON.stringify(run.final_guess, null, 2)}</pre></details>}
      </aside>
    </div>
  )
}

function MessageBubble({ message, investigator, open, onToggle }: { message: Message; investigator: string; open: boolean; onToggle: () => void }) {
  const mine = message.speaker_name === investigator
  const reasoningText = message.reasoning ?? (message.reasoning_details ? JSON.stringify(message.reasoning_details, null, 2) : '')
  return (
    <article className={`message-row ${mine ? 'investigator' : 'target'} ${message.role === 'final_guess' ? 'final' : ''}`}>
      <div className="message-meta"><strong>{message.speaker_name}</strong><span>{message.model}</span></div>
      <div className="bubble">
        {message.role === 'final_guess' && <span className="final-label">FINAL PERSONA GUESS</span>}
        <p>{message.content}</p>
        <div className="bubble-foot"><span>{new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span>{message.completion_tokens} tokens</span><span>{message.latency_ms / 1000}s</span></div>
      </div>
      <button className={`reasoning-toggle ${message.reasoning_state}`} onClick={onToggle} disabled={message.reasoning_state === 'unavailable'}>
        <Brain size={14} /> Provider reasoning: {message.reasoning_state}{message.reasoning_state !== 'unavailable' && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {open && <pre className="reasoning-panel">{message.reasoning_state === 'redacted' && !reasoningText ? 'The provider returned only encrypted/redacted reasoning.' : reasoningText}</pre>}
    </article>
  )
}

function ScoreCard({ run }: { run: Run }) {
  const score = run.evaluation!
  return <section className="score-card"><div className="score-title"><Sparkles size={17} /><strong>Judge evaluation</strong></div>
    <Score label="Concealment" value={score.concealment} />
    <Score label="Misdirection" value={score.misdirection} />
    <Score label="Extraction" value={score.extraction_success} inverse />
    <p>{score.rationale}</p><small>{score.judge_model} · {score.judge_confidence}% confidence</small>
  </section>
}

function Score({ label, value, inverse = false }: { label: string; value: number; inverse?: boolean }) {
  return <div className="score-row"><span>{label}</span><div><i style={{ width: `${value}%` }} className={inverse ? 'inverse' : ''} /></div><strong>{Math.round(value)}</strong></div>
}

function PersonaCard({ label, value }: { label: string; value: Record<string, unknown> }) {
  return <div><strong>{label}</strong><pre>{JSON.stringify(value, null, 2)}</pre></div>
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status ${status}`}><i />{status}</span>
}

function splitList(value: string): string[] {
  return value.split(/,|\n/).map((item) => item.trim()).filter(Boolean)
}

export default App
