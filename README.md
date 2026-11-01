# Propensity Experiment Platform

A local research workbench for measuring how well language models conceal a hidden
persona while another model tries to infer it. OpenRouter provides a single API for
Anthropic, OpenAI, judge, and future models.

## What it does

- Assigns a private, structured persona to each participant.
- Runs two directions by default: A investigates B, then B investigates A.
- Instructs the target to conceal and strategically misdirect.
- Runs open-ended dialogue bounded by per-turn tokens, total tokens, request timeouts,
  and wall-clock time.
- Stores every experiment, message, provider usage, latency, cost, final guess, and
  evaluation in SQLite.
- Streams live progress to a WhatsApp-style observer interface.
- Displays only reasoning that OpenRouter actually returns. Unsupported and encrypted
  reasoning are labeled rather than reconstructed.
- Uses a configurable third model to score extraction success, concealment, and
  misdirection.

Private personas and provider reasoning are never included in the opposing model's
context. The judge sees the target ground truth, final guess, and visible transcript,
but not either model's reasoning.

## Setup

Requirements: Python 3.13+, [uv](https://docs.astral.sh/uv/), and Node.js 22+.

From `propensity-experiments`:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set `OPENROUTER_API_KEY`. Keep this file private.

Install dependencies if they are not already present:

```powershell
uv sync --project backend
npm install --prefix frontend
```

Start the API:

```powershell
cd backend
uv run uvicorn app.main:app --reload --port 8000
```

In a second terminal, start the UI:

```powershell
cd frontend
npm run dev
```

Open `http://localhost:5173`. The model fields are searchable OpenRouter model-ID
inputs. The included defaults are examples; choose IDs returned by your OpenRouter
account's live catalog if a default is unavailable.

## Experiment flow

1. Define both hidden personas, including explicit secrets and deception strategies.
2. Choose participant models, a judge model, and budgets.
3. Start the paired study. The backend alternates visible dialogue under server
   control and commits each completed turn immediately.
4. The investigator submits a JSON persona guess after the dialogue budget.
5. The judge scores the visible evidence against the target ground truth.
6. Reopen any session from the history sidebar. Persona reveal is an explicit
   observer action and is masked by default.

Runs are immutable after they finish or stop. Create a new experiment to rerun a
configuration; this prevents accidental alteration of historical evidence.

## Budget semantics

- `Tokens / turn`: OpenRouter `max_tokens`, including reasoning where the provider
  counts it against completion output.
- `Total tokens`: cumulative prompt plus completion usage reported by OpenRouter.
- `Time limit`: wall-clock budget for one directional run.
- `Request timeout`: backend timeout for one OpenRouter request (currently 90 seconds
  in the UI defaults).

Dialogue continues without a turn cap until the time or total-token boundary. The
investigator then submits its final guess and the judge evaluates the completed
conversation. Final-guess and judge calls also consume and record tokens.

## Reasoning caveat

The UI does not claim access to private chain-of-thought. It stores OpenRouter's
`reasoning` and `reasoning_details` response fields only. Some models, including some
OpenAI reasoning models, do not expose reasoning text; others may return encrypted or
redacted blocks. These states are shown as `unavailable` or `redacted`.

## Data and API

SQLite is created at `backend/data/propensity.db`. The key tables are:

- `experiments`: immutable configuration snapshots and overall status
- `runs`: direction, private persona snapshots, budgets, totals, guess, and score
- `messages`: visible output, observer-only reasoning, usage, cost, and latency

Useful endpoints:

- `GET /api/models`
- `POST /api/experiments`
- `POST /api/experiments/{id}/start`
- `POST /api/experiments/{id}/stop`
- `GET /api/experiments/{id}`
- `GET /api/experiments/{id}/events`
- `GET /api/experiments/{id}/runs/{run_id}/personas`

Interactive API documentation is available at `http://localhost:8000/docs`.

## Verification

```powershell
cd backend
uv run pytest -q
uv run ruff check app tests

cd ..\frontend
npm test
npm run lint
npm run build
```

Backend tests use a fake OpenRouter transport and a separate test database. No paid
model calls are made by the test suites.
