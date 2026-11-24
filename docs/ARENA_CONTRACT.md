# Arena contract

The shared agreement between the four games, their viewers, the server and the dashboard: the
exact names, shapes and file layout. When code and this file disagree, one of them is a bug.

## 1. Layout

```
backend/
  arena/            shared core: agent.py, decide.py, events.py, run.py, mockgame.py
  senate/           Senate engine (game.py exposes the game module interface, §2)
  poker/            heads-up Hold'em engine (game.py, evaluator.py, ...)
  configurations/
    senate/*.json   Senate table configs        poker/*.json   Poker table configs
    <game>/dashboard/<timestamp>.json   tables saved by the dashboard on launch
    arena/mock.json  the mock game's table (arena.mockgame)
    models.json     the models offered in the dashboard's seat dropdowns
    *.json          Mafia's existing tables (variant "misinformation" or none)
  autonomous_games/ Mafia + Misinformation Mafia data ($LLMAFIA_GAMES_DIR)
  senate_games/     Senate data   ($SENATE_GAMES_DIR)
  poker_games/      Poker data    ($POKER_GAMES_DIR)
  launches/         the dashboard's launch records and launcher logs ($ARENA_LAUNCHES_DIR)
  server.py         viewer pages, game data, the API
frontend/
  index.html        the dashboard
  common/           arena.css (tokens, base, replay controls), replay.js
  mafia/            the 3D village viewer; the server also serves its index.html at /misinformation/,
                    where main.js sets data-variant="misinformation" from the URL path
  senate/  poker/   the 2D viewers
```

All Python runs from `backend/` with `backend/.venv/bin/python` (3.14). Data dirs given by
environment variables are relative to `backend/` (`arena.run.data_dir(game)` resolves them for
senate, poker and mock). Every test run points them at a scratch directory.

## 2. Game module interface (`backend/<game>/game.py`)

```python
def validate(table: dict) -> list[str]           # problems, [] when the table is fine
def make_configs(table: dict, n: int) -> list[dict]  # n games (poker duplicate: 2n, pairs adjacent)
def play(config: dict, game_dir: Path, log: EventLog) -> str   # plays one game, returns the index winner
```

`python -m arena.run <senate|poker|mock> <table.json> [--games N] [--parallel P] [--check]`
validates, refuses real models without `OPENROUTER_API_KEY`, allocates ids, writes `config.json`
as `{"game": <game>, **config, "table_config_path": ...}`, calls `play`, and keeps `index.json`.
An exception in `play` aborts that game (traceback in `<id>/console.txt`). SIGTERM stops the
launcher: `arena.agent.STOP` is set and every game raises `Stopped` at its next model call.

Core helpers (`backend/arena/`):
- `Agent(name, llm_config, game_dir)`; `agent.ask(system, prompt, kind, mock) -> str`. `mock` is a
  no-argument function returning what a mock seat answers; it runs only when the model is `"mock"`.
  Real models go through `OpenRouterLLM` (`llm_players/openrouter_llm.py`), which collapses all
  whitespace of the answer to single spaces. Every call is logged to `<Name>_log.txt` and
  `<Name>_reasoning.jsonl` (with `usage.cost`). `llm_config["mock_latency_seconds"]` slows mocks.
- `choose(agent, system, prompt, options, kind) -> (option, full_answer)`: the model answers in
  `<choice>…</choice>`; exact match first, else the only option named as a whole word; one re-ask;
  then a random option, logged as kind `invalid:<kind>` in the reasoning file.
- `tag(text, name)`: the last `<name>…</name>` content, or None. Use it for `<say>` and `<action>`.
- `llm_config_for(seat, table)`: `{"model_name": seat.model, **table.llm_defaults, **other seat keys}`.
- `model_problem(seat, i)`: None, or the problem with seat i's model.
- `EventLog(path).emit(type, **fields)`: appends `{"ts": time.time(), "type": type, **fields}`.
- Code names: `game_constants.OPTIONAL_CODE_NAMES`. Each game draws fresh random names.

## 3. Data on disk

```
<data dir>/index.json         [{"id": "0001", "started": <unix s>, "models": [sorted unique model ids],
                                "seats": {"<name>": "<model>"}, "winner": null | <winner> | "aborted"}]
<data dir>/<id>/config.json   the game's config (§4, §5), written before the first event
<data dir>/<id>/events.jsonl  one event per line, appended while the game runs
<data dir>/<id>/<Name>_log.txt, <Name>_reasoning.jsonl, console.txt (errors only)
```

`winner` is null while the game runs. Mafia's index has no `seats`; everything else is the same.

Events: every event has `ts` (unix seconds, float) and `type`. **An event that holds secret
information has `"spoiler": true` and holds nothing public**: town view skips it entirely, so a
public fact never lives in a spoiler event and a secret never lives in a public one. The last event
of a finished game is always `game_over`. Viewers ignore event types they do not know.

## 4. Senate

An original hidden-role game (Secret Hitler's mechanics, our own names and theme). Terms used
everywhere: Loyalists / Conspiracy (sides), loyalist / conspirator / usurper (roles), Consul and
Prefect (the two offices), Reform and Decree (laws), tracker (failed elections).

**Table config** (`configurations/senate/*.json`):
```json
{"players": [{"role": "usurper", "model": "anthropic/claude-sonnet-5.5"},
             {"role": "conspirator", "model": "openai/gpt-5-mini"},
             {"role": "loyalist", "model": "openai/gpt-5-mini"}, ...],
 "shuffle_roles": false, "discussion_rounds": 1,
 "llm_defaults": {"reasoning": {"effort": "low"}}}
```
5–10 players with exactly these role counts (loyalists/conspirators/usurper): 5: 3/1/1, 6: 4/1/1,
7: 4/2/1, 8: 5/2/1, 9: 5/3/1, 10: 6/3/1. Other seat keys go to that seat's llm_config.

**config.json**: `{"players": [{"name", "model", "role", "llm_config"}] in seat order,
"discussion_rounds", "seed", "first_consul": <name>}`. Each game shuffles the seat order and
draws new names; `shuffle_roles` also reassigns roles among the seats.

**Rules** (fixed here so the engine and viewer agree):
- Knowledge: with 5–6 players the conspirators and the usurper all know each other. With 7+ the
  conspirators know each other and the usurper; the usurper knows no one.
- Deck: 6 reform + 11 decree. Before any draw or peek, if fewer than 3 laws are in the draw
  pile, the discards are shuffled back in (`reshuffle`). Draw + discard + enacted = 17, always.
- Round: the Consul passes to the next living player in seat order (the first is random). The
  Consul nominates a Prefect among the other living players, except the last *elected* Prefect,
  and the last elected Consul when more than 5 players are alive. Failed votes do not change
  these term limits; a chaos law clears them.
- Debate: every living player speaks `discussion_rounds` times, in a new random order each time.
- Vote: all living players vote Aye/Nay at once; strict majority of Ayes passes.
- Failed vote: tracker +1. At 3: the top law is enacted (`by: "chaos"`), no power, tracker back
  to 0, term limits cleared.
- Passed vote: the tracker stays as it is (only an enacted law resets it). If 3+ decrees are
  enacted and the Prefect is the usurper, the Conspiracy wins at once (`usurper_elected`), before
  any draw. Otherwise the Consul draws 3, discards 1; the Prefect gets the other 2. With 5 decrees
  enacted the Prefect may propose a veto; if the Consul accepts, both laws are discarded (no
  `discard` events: the `veto` event says so) and tracker +1 (3 → chaos); if not, the Prefect
  must enact. The Prefect discards 1 and enacts the other. Any enacted law, chaos included, sets
  the tracker back to 0.
- Powers come only from a law the government enacted, by the decree count reached:
  5–6 players: peek (3), execution (4), execution (5);
  7–8: investigate (2), special election (3), execution (4, 5);
  9–10: investigate (1, 2), special election (3), execution (4, 5).
  The Consul uses it. Peek: sees the top 3 laws, unchanged. Investigate: another living player
  never investigated before; learns their side ("loyalist" or "conspiracy", the usurper shows
  as "conspiracy"). Special election: names any other living player as the next Consul; after
  that round the Consul passes on from the one who called it. Execution: kills another living
  player; their role is not revealed; executing the usurper ends the game (`usurper_executed`).
- After an enacted law (not chaos) and its power, a report discussion: everyone speaks again
  (the Consul and Prefect may claim what they saw, truthfully or not).
- Wins: Loyalists at 5 reforms or when the usurper is executed; Conspiracy at 6 decrees or when
  the usurper is elected Prefect with 3+ decrees enacted.
- Every model call gets the rules, its role and private knowledge, the public transcript, its own
  private notes (draws, peeks, investigations) and the decision with its legal options; it answers
  in `<choice>` (and `<say>` when it speaks). The executed never speak or vote.

**Events** (spoilers marked S):
| type | fields |
|---|---|
| `round` | n, consul, tracker, draw_pile, discard_pile |
| `nominate` | consul, prefect |
| `message` | name, text, stage: `"debate"` (before the vote) \| `"report"` (after a law) |
| `vote` | voter, aye (bool); one per living voter, all written after everyone voted |
| `vote_result` | passed, ayes, nays, tracker (after this vote: unchanged when passed, 3 on the failure that brings chaos) |
| `draw` S | consul, laws: 3 × `"reform"`\|`"decree"` |
| `discard` S | by, law (the Consul's, then the Prefect's; none for laws an accepted veto discards) |
| `veto` | prefect, consul, accepted (bool), tracker; only when the Prefect proposes one |
| `enact` | law, by: Prefect name \| `"chaos"`, reforms, decrees, tracker (all after enacting) |
| `reshuffle` | draw_pile |
| `power` | kind: `"peek"`\|`"investigate"`\|`"special_election"`\|`"execution"`, by, target (not for peek) |
| `power_result` S | kind: `"peek"`\|`"investigate"`, by, target (investigate), result: [3 laws] \| `"loyalist"`\|`"conspiracy"` |
| `executed` | name |
| `game_over` | winner: `"loyalists"`\|`"conspiracy"`, reason: `"reforms"`\|`"decrees"`\|`"usurper_executed"`\|`"usurper_elected"`, roles: {name: role} |

Index `winner`: `"loyalists"` or `"conspiracy"`.

## 5. Poker (heads-up no-limit Hold'em)

**Table config** (`configurations/poker/*.json`):
```json
{"players": [{"model": "anthropic/claude-sonnet-5.5"}, {"model": "openai/gpt-5-mini"}],
 "hands": 50, "duplicate": true, "table_talk": true,
 "llm_defaults": {"reasoning": {"effort": "low"}}}
```
Exactly 2 players. Blinds 1/2, every hand starts with 200 chips each (hands are independent).

**config.json**: `{"players": [{"name", "model", "llm_config"}] (seat 0, seat 1), "hands",
"blinds": [1, 2], "stack": 200, "seed", "pair": <int shared by both games of a pair, unique across launches (the seed)> | null,
"mirror": <bool, true for the second game of a pair>, "table_talk"}`.

- The button is seat 0 in hand 1 and alternates. The button posts the small blind, acts first
  preflop and last after. Min bet 2; a raise is at least the size of the last bet or raise; all-in
  is always allowed; an uncalled bet is returned (`refund`).
- Each hand's deck comes from `(seed, hand)` alone and is dealt by seat. Duplicate: the second game
  of a pair has the same seed with the two models swapped between the seats (and new names), so
  each model gets the cards and positions the other had.
- The model answers `<action>fold|check|call|bet N|raise N</action>`, where N is the total it
  puts in on this street after the action ("raise to N"), and may add `<say>…</say>` (at most 200
  characters, shown to the opponent) when `table_talk` is on. The prompt gives hole cards, board,
  pot, stacks, amount to call, the legal actions with min and max, and the last 10 hands, one line
  each.

Cards are 2-character strings: rank `23456789TJQKA` + suit `shdc` (e.g. `"As"`, `"Td"`).

**Events** (S = spoiler):
| type | fields |
|---|---|
| `hand_start` | hand (1-based), button, seed, stacks: {name: 200} |
| `deal` S | player, cards: [2 cards] |
| `action` | player, action: `"blind"`\|`"fold"`\|`"check"`\|`"call"`\|`"bet"`\|`"raise"`, amount (chips this action added), to (player's street total after it), pot (after it), stack (player's, after it), all_in (bool), say? |
| `street` | name: `"flop"`\|`"turn"`\|`"river"`, board (all board cards so far) |
| `refund` | player, amount, pot (after it) |
| `showdown` | player, cards, hand_name (e.g. "two pair, kings and nines"), best: [5 cards] |
| `hand_end` | hand, winners: [names] (both on a split), pot, deltas: {name: ±chips}, totals: {name: ±chips so far}, board |
| `game_over` | winner: name \| `"draw"`, reason: `"hands_played"`, hands, totals: {name: ±chips} |

Order in a hand: `hand_start`, 2 × blind `action`, 2 × `deal`, betting `action`s, `street`s, …,
then either a fold (and `refund`) or the remaining streets and 2 × `showdown`, then `hand_end`.
Index `winner`: the player name with the higher total, or `"draw"`.

## 6. Viewers

- A viewer is opened as `/<game>/?game=<id>` and reads `games/index.json`, `games/<id>/config.json`
  and `games/<id>/events.jsonl` relative to its page (the server maps `/<game>/games/`).
- The 2D viewers use `frontend/common/replay.js` (`loadGame`, `startReplay`; API in its header)
  and `frontend/common/arena.css` (tokens: `--bg --panel --panel-solid --line --line-strong --text
  --muted --gold --night --bad --good --radius --head --body --mono`, `.glass`, `.sr`; dark by
  default, light under `prefers-color-scheme: light`).
- The reducer (`state.js`) is pure JS without DOM, so `node frontend/<game>/state.check.mjs` can
  replay `frontend/<game>/fixtures/demo/{config.json,events.jsonl}` and assert the state.
- Names only: no model names anywhere in a viewer. Works at 360 px wide, dark and light.
- Senate: town view by default (`godLabel: "God view"`); roles show in god view and after
  `game_over`. Its stage is a 3D chamber (frontend/senate/scene.js, chamber.js, stage.js) built on
  the Mafia viewer's scene modules and CC0 characters (frontend/mafia/scene/*.js and assets), so
  their exports are shared API; `?scene=off`, or a failed WebGL/CDN load, falls back to the 2D board. Poker: `godLabel: "Broadcast view"`, `godDefault: true` (hole cards shown).
- A link back to the dashboard (`/`) on every viewer page.

## 7. Server and API (`backend/server.py`, 127.0.0.1 only)

| route | serves |
|---|---|
| `/` | `frontend/index.html` (dashboard); other paths under `frontend/` as files |
| `/<game>/games/<path>` | that game's data dir; mafia and misinformation share `autonomous_games` |
| `/mafia/games/index.json`, `/misinformation/games/index.json` | `autonomous_games/index.json` filtered by each game's `config.json` `variant` (none → mafia, `"misinformation"` → misinformation), cached by mtime |
| `GET /api/games` | per game key: title, description, sides, roles (for the seat editor), default_moderator (Mafia games), runs, live, wins (per side; poker: per model), avg_cost (mean USD of finished runs with a real model, or null), list (the index entries) |
| `GET /api/tables?game=` | saved tables (Mafia's own by variant) |
| `GET /api/models` | `configurations/models.json` |
| `GET /api/budget` | OpenRouter `GET /api/v1/key` (limit, usage, remaining); notes the workspace budget can't be read |
| `GET /api/launches` | recorded launches: pid, game, started, running, exit code (null while running, a number, or "unknown" if it ended while the server was down), last log lines |
| `POST /api/launch` | `{game, table, games, parallel}`: validate, save the table, spawn the launcher |
| `POST /api/stop` | `{pid}`: SIGTERM a recorded launcher that is still running |

Launchers (cwd `backend/`, the server's own environment, output to `backend/launches/<ts>_<game>.log`):
mafia / misinformation → `python run_autonomous.py <table> --games N --parallel P`;
senate / poker → `python -m arena.run <game> <table> --games N --parallel P`.
At most one running launcher per data dir (mafia and misinformation count as one). A table that
sets "model_name", "use_openrouter" or "use_mock" in llm_defaults or a seat is refused (only a
seat's "model" picks its model). Launchers run in their own session and each launch is recorded
in `backend/launches/`; a recorded launch counts as running while its pid lives and
/proc/<pid>/cmdline still matches its argv, so a restarted server (a deploy) still lists, refuses
duplicates of and stops runs started before the restart. Ctrl-C on the server leaves them running.

Every request: the `Host` must be 127.0.0.1, localhost, ::1 or the `--host` name (against DNS
rebinding). POST safety: only `Content-Type: application/json`, header `X-Arena: 1`, and an
`Origin` equal to `http://` + the request's `Host`; no CORS headers, ever. The key comes only from the server's
environment and never reaches a page.
