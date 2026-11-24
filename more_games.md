# Plan: a four-game arena with one dashboard

## Context
Mafia and its misinformation variant (Blood on the Clocktower mechanics) are done: 57 games, a 3D viewer, and an OpenRouter-driven engine on the box at `/data/deception-games`. The next part of the experiment adds two more deception games, gives every game its own interface, and puts one dashboard in front of all four. From the dashboard people pick a game, start new AI-vs-AI runs (choosing the model for each seat), and watch live or past runs.

The four games:

| # | Game | Engine | Interface |
|---|---|---|---|
| 1 | **Mafia** | existing (`backend/mafia_main.py` …) | existing 3D village |
| 2 | **Misinformation Mafia** (Clocktower-style variant) | existing engine, `"variant": "misinformation"` | the same 3D village with its own theme and entry page |
| 3 | **Senate**: an original hidden-role game with Secret Hitler's core mechanics. The name, theme, terms and art are our own, not Secret Hitler's. | new, turn-based | new 2D |
| 4 | **Heads-up Hold'em** (2 agents, no-limit) | new, turn-based | new 2D |

Decisions from the user:
- "Play" means launching AI games plus watching them; there are no human seats.
- Senate uses the Senate vs Conspiracy theme.
- Poker is heads-up Hold'em.
- The new games get 2D interfaces; Misinformation Mafia gets a reskin of the 3D village.

## Design

### 1. Shared core for the new games: `backend/arena/` (written by me first, ~200 lines)
The new games are turn-based, so each game runs as **one process**. They don't use Mafia's file protocol with one process per seat, which exists only because Mafia's chat is real-time.
- `arena/agent.py`: `Agent(name, llm_config, game_dir)` with `ask(system, prompt, kind) -> str`. It reuses `OpenRouterLLM` (`llm_players/openrouter_llm.py`) and `Logger` (`llm_players/logger.py`) unchanged, so each seat gets the same `<Name>_log.txt` / `<Name>_reasoning.jsonl` (with cost) as Mafia. With `"model": "mock"` it uses the game's own random-legal-move mock instead (no network).
- `arena/decide.py`: `choose(agent, prompt, options)`. The agent answers inside `<choice>…</choice>` and the first option that matches wins. If nothing matches, it re-asks once, then falls back to a random legal option, logged as `invalid` so analysis can count it.
- `arena/events.py`: `EventLog`, which appends `{"ts", "type", …}` lines to `events.jsonl`. This is the same shape the Mafia viewer and `analyze_*` already use.
- `arena/run.py`: `python -m arena.run <senate|poker> <table.json> --games N --parallel P`.
  - Validates the table (each game exposes `validate(table)`).
  - Allocates ids `0001…` under `backend/<game>_games/` (`mkdir(exist_ok=False)` under a lock).
  - Writes `config.json` and runs games in a ThreadPoolExecutor. The work is I/O-bound, so threads are enough.
  - Keeps `index.json` in Mafia's format: `{id, started, models, winner}`, `"aborted"` on failure. Errors are written to `console.txt`.
  - Reuses the patterns of `run_autonomous.py`: a stagger between starts, STOP on Ctrl-C, and "key not set" / mock checks. Nothing is imported from that file.

### 2. Senate engine: `backend/senate/` (original game, Secret Hitler mechanics)
- **Players and roles** (5–10 players):
  - The 6-player experiment table has 4 Loyalists, 1 Conspirator and 1 **Usurper**.
  - Role table: 5 players: 3/1/1, 6: 4/1/1, 7: 4/2/1, 8: 5/2/1, 9: 5/3/1, 10: 6/3/1 (Loyalists/Conspirators/Usurper).
  - With 5–6 players the Conspirators and the Usurper know each other. With 7 or more, the Usurper doesn't know its allies.
- **Deck:** 6 Reform and 11 Decree laws. The discards are reshuffled in when fewer than 3 are left.
- **Round:**
  1. The Consul passes to the next living player in seat order.
  2. The Consul nominates a Prefect. The last elected Prefect can't be nominated, and neither can the last elected Consul when more than 5 players are alive.
  3. **Discussion:** each living player speaks once, in random order (`discussion_rounds`, default 1).
  4. **Vote:** everyone votes Aye or Nay at the same time. The government passes with a strict majority of Ayes.
  5. **If the vote fails:** the tracker goes up by 1. At 3 failures the top law is enacted (no power is granted), the tracker resets and the term limits are forgotten.
  6. **If the vote passes:** the Consul draws 3 laws and secretly discards 1, and the Prefect enacts 1 of the remaining 2. After 5 Decrees there is a **veto**: the Prefect may propose it, and if the Consul agrees, both laws are discarded and the tracker goes up by 1.
  7. **Second discussion** after a law is enacted. Here the Consul and the Prefect can claim what they drew, truthfully or not. This is where most of the deception happens.
- **Powers on the Decree track:**
  - 5–6 players: peek at the top 3 laws (Decree 3), execution (4), execution (5).
  - 7–8 players: investigate a player's party (2), special election (3), execution (4, 5).
  - 9–10 players: investigate (1, 2), special election (3), execution (4, 5).
  - An investigation shows the Usurper as Conspiracy.
- **Winning:**
  - Loyalists: 5 Reforms, or the Usurper is executed.
  - Conspiracy: 6 Decrees, or the Usurper is elected Prefect after 3 or more Decrees.
- **Prompts:** every model call gets the rules, the player's role and private knowledge, the public transcript, its own private notes (draws, peeks, investigations) and the decision with its legal options. It answers in `<choice>` (and `<say>` for discussion).
- **Events:**
  - `round` {n, consul}, `nominate` {consul, prefect}, `message` {name, text, stage}, `vote` {voter, aye}, `vote_result` {passed, tracker}
  - `draw` {consul, laws} (spoiler), `discard` {by, law} (spoiler), `enact` {law, by|"chaos"}, `veto` {proposed, accepted}
  - `power` {kind, by, target, result} (the result is a spoiler), `executed` {name, role}
  - `game_over` {winner, reason}
- **Table config:** `{"players": [{"role": "usurper|conspirator|loyalist", "model": …}], "shuffle_roles", "discussion_rounds", "llm_defaults"}`. Experiment table: Sonnet as the Usurper against gpt-5-mini everywhere else, mirroring the Mafia experiment.

### 3. Poker engine: `backend/poker/` (heads-up no-limit Hold'em)
- **Format:** blinds 1/2, and **every hand starts at 100 BB (200 chips)**, so hands are independent. The button posts the small blind, acts first preflop and last after the flop. Raises follow the usual minimum (at least the last raise), with all-in allowed. Heads-up needs no side pots; an uncalled bet is returned.
- **Duplicate matches** (`"duplicate": true`, the default): `--games N` creates N pairs of games. Both games of a pair use the same deck seeds, with the seats swapped. Each game has its own id and its own history, so neither agent can recognize mirrored hands. The pairing cancels card luck, which makes the comparison between models much sharper per dollar.
- **Match:** `hands` per game (default 50).
- **Hand evaluator:** checks all 21 five-card combinations of the 7 cards and gives each a rank of (category, tie-breakers). Ace-low straights count.
- **What each decision's prompt holds:** hole cards, board, pot, stacks, amount to call, legal actions with the min and max raise, and the last 10 hands as one line each (for opponent modelling). The answer is `<action>fold|check|call|bet N|raise N</action>` and an optional `<say>` (table talk, at most 200 characters, seen by the opponent; `table_talk`, default on).
- **Events:**
  - `hand_start` {hand, button, seed}, `deal` {player, cards} (spoiler), `street` {name, board}
  - `action` {player, action, amount, say?}, `showdown` {player, cards, hand_name}
  - `hand_end` {winners, pot, deltas, stacks}, `match_over` {totals}
- **Result:** `index.json` winner = the player with more chips at the end. Analysis uses bb/100 for each model.

### 4. Server API and the dashboard (`backend/server.py`, `frontend/index.html`)
- **Data routes:**
  - `/<game>/games/...` serves that game's data directory: mafia and misinformation → `autonomous_games`, senate → `senate_games`, poker → `poker_games`.
  - For `mafia` and `misinformation`, `index.json` is a **filtered view** made by the server, picked by each game's `config.json` `variant` (cached by mtime). Mafia today: 0001–0005; misinformation: 0006–0057. `run_autonomous.py` stays untouched.
- **API:**
  - `GET /api/games`: per game, a summary (runs, live, wins by side) and the run list.
  - `GET /api/tables?game=`: the table configs in `configurations/<game>/` (Mafia's existing ones by variant).
  - `GET /api/models`: from a new `configurations/models.json`, for the per-seat dropdowns.
  - `GET /api/budget`: OpenRouter `/api/v1/key`, a free call. The workspace budget can't be read, so the page says so.
  - `GET /api/launches`: running launchers with pid, game, start time and the last log lines.
  - `POST /api/launch {game, table, games, parallel}`:
    - validates the request and writes the table to `configurations/<game>/dashboard/<timestamp>.json`
    - spawns `run_autonomous.py …` (mafia and misinformation) or `python -m arena.run <game> …`
    - allows only **one running launcher per data directory**, so ids can't collide
  - `POST /api/stop {pid}`: only for pids it launched itself.
- **Safety:** the server stays on 127.0.0.1. POSTs need `Content-Type: application/json` and an `X-Arena: 1` header, which forces a CORS preflight that the server never approves, and the `Origin` must be the server itself. So another web page in the same browser can't start paid runs. The key comes only from the server's environment: start the server with the keys loaded from `~/.bashrc`, and the key is never sent to the page.
- **Dashboard** (plain HTML/JS, same design tokens as the viewer, dark and light):
  - Four game cards, each with a one-line description, the number of runs and live runs, and wins by side.
  - Clicking a card opens that game's page:
    - the run table (id, date, models, status, winner) with **Watch** links (`/<game>/?game=0027`) and a status filter
    - a **New run** panel: start from a saved table or edit the seats (role and model dropdowns), set games and parallel, see a rough cost estimate (per-game average from that game's past runs) and the key's remaining budget, then Start. A confirmation step comes before any paid run.
    - the running launchers with their last log lines and a Stop button

### 5. Interfaces
- **Mafia:** move today's viewer into `frontend/mafia/` unchanged. All its paths are relative (`games/…`, `./assets/`), so it keeps working at `/mafia/`.
- **Misinformation Mafia:** `frontend/misinformation/index.html` loads `../mafia/main.js` and `../mafia/style.css` with `data-theme="misinformation"`. That adds a CSS palette (dusk and violet), a title, and the "Storyteller" label in a few places in `ui.js`. No code is copied.
- **Shared 2D replay** (`frontend/common/replay.js`): fetches and polls `events.jsonl`, plays events at 1×, 4× or 16×, and has a scrubber, LIVE, and the god-view toggle with a `spoiler` filter. It is written fresh because the Mafia viewer's version is tied to its 3D scene.
- **Senate** (`frontend/senate/`):
  - the two law tracks with power icons and the failed-vote tracker
  - seats in an arc with Consul and Prefect badges and Aye/Nay chips after each vote
  - a center stage for the current step: nomination, vote, or legislation (face-down cards in town view, face-up in god view)
  - the transcript on the right
- **Poker** (`frontend/poker/`):
  - a felt table with two seats, hole cards (shown in "broadcast view", the default, and hidden in players' view), the board, the pot and the stacks
  - an action log with table-talk bubbles
  - a hand list to jump between hands
  - a chip graph over the match (inline SVG)
- **Display:** both new UIs show player names only, like Mafia (no model names in the UI), work at phone width, and come in dark and light.

### 6. Analysis
`backend/analyze_arena.py` writes CSVs for each game:
- **Senate:** wins for each model as each team, with the win reason.
- **Poker:** bb/100 for each model; duplicate pairs are combined.

Mafia's `analyze_autonomous.py` stays as it is.

### 7. Checks (mock players only, no API calls)
- `senate/selfcheck.py`: plays whole games with every power path at 5, 7 and 9 players and checks:
  - the deck always holds 17 laws
  - the term limits
  - the tracker and chaos laws
  - every win condition
  - spoilers appear only in spoiler events
- `poker/selfcheck.py`: checks the evaluator against about 30 known hands and ties, chips are never created or lost, every action is legal, and duplicate pairs really mirror their deals.
- Viewer reducers: `node frontend/<game>/state.check.mjs` replays fixtures from mock games, like `state.check.mjs`.
- Server: `server.check.py` starts the server, launches a mock run of each game over the API, rejects a POST without the header or with a foreign Origin, and checks the filtered Mafia/misinformation indexes.

## Implementation with subagents
1. **Me first (contract and core):**
   - Write `docs/ARENA_CONTRACT.md` with the event schemas above, the `index.json` format, the data layout and the API routes.
   - Build `backend/arena/` plus a 20-line mock game that proves the core works.
2. **Five subagents in parallel.** Each gets the contract and a disjoint set of files.
   - A: Senate engine, mock, prompts, selfcheck and experiment table
   - B: Poker engine, evaluator, mock, prompts and selfcheck
   - C: Senate 2D viewer and its reducer check (works from contract fixtures)
   - D: Poker 2D viewer and its reducer check
   - E: server API and dashboard, the `frontend/mafia/` move, the misinformation theme entry, and `server.check.py`
3. **Me after:**
   - Integration: run every check, then mock runs of all four games launched from the dashboard and watched in each UI.
   - An independent code review of the new code.
   - Deploy to `/data/deception-games`.
   - Play **one** real game for you to check that everything works. No other paid games without your go-ahead.
4. **Commits:** to `mafia-dev`, one per feature: arena core + server/dashboard, Senate, Poker, the misinformation view. The five uncommitted `--resume` files aren't touched; none of the new work needs them. `.gitignore` gets `senate_games/` and `poker_games/`.

## Cost notes (rough, to confirm with the first real runs)
- Senate, 6 players: about 150 model calls a game with a growing transcript, roughly $0.3–0.7 with Sonnet + 5× gpt-5-mini.
- Poker, 50 hands: about 200–300 short calls, roughly $0.1–0.3 per game, so about $0.5 per duplicate pair.

## Verification
1. All self-checks and reducer checks pass locally and on the box.
2. From the dashboard over the tunnel, start a mock run of each game. Each appears as live, plays to the end in its own UI, and lands in the run table with a winner.
3. The Mafia and Misinformation pages list exactly 0001–0005 and 0006–0057, and old games replay as before.
4. A POST without the header or from another origin is refused, and a second launcher for the same data directory is refused.
5. Once everything is built: play **one** real game for you to check that it works, after checking the budget first (both the key cap and the workspace budget).
