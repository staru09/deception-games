"""
Runs turn-based arena games, every seat a model behind OpenRouter (or "mock", offline).

    python -m arena.run senate configurations/senate/experiment_6p.json --games 10 --parallel 3
    python -m arena.run poker configurations/poker/experiment.json --games 5   # duplicate: 5 pairs
    python -m arena.run senate <table.json> --check                         # validate only

Run it from backend/. Games go to backend/<game>_games (or $<GAME>_GAMES_DIR, e.g.
SENATE_GAMES_DIR), each in a numbered directory with config.json, events.jsonl and one
<Name>_log.txt / <Name>_reasoning.jsonl per seat; index.json lists them in Mafia's format.
Run one launcher per data directory: it alone hands out the ids.

A game module (GAMES) has validate(table) -> [problems], make_configs(table, n) -> [config]
and play(config, game_dir, log) -> winner. See docs/ARENA_CONTRACT.md.
"""
import argparse
import importlib
import json
import os
import signal
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from arena.agent import STOP
from arena.events import EventLog
from llm_players.llm_constants import MOCK_MODEL_NAME, OPENROUTER_API_KEY_KEYWORD

BACKEND_DIR = Path(__file__).resolve().parent.parent
GAMES = {"senate": "senate.game", "poker": "poker.game", "mock": "arena.mockgame"}
ABORTED = "aborted"
STAGGER_SECONDS = 3  # between the starts of the first games of a parallel run
LOCK = threading.RLock()  # game ids and index.json are shared by the games running in parallel


def data_dir(game):
    return (BACKEND_DIR / os.environ.get(f"{game.upper()}_GAMES_DIR", f"{game}_games")).resolve()


def update_index(root, game_id, **fields):
    with LOCK:
        index_file = root / "index.json"
        games = json.loads(index_file.read_text()) if index_file.exists() else []
        entry = next((game for game in games if game["id"] == game_id), None)
        if entry is None:
            entry = {"id": game_id}
            games.append(entry)
        entry.update(fields)
        temporary_file = index_file.with_suffix(".tmp")  # the viewer must never read half a file
        temporary_file.write_text(json.dumps(games, indent=1))
        os.replace(temporary_file, index_file)


def mark_unfinished_aborted(root):
    # left by a launcher that was killed before it could clean up; viewers would wait forever
    index_file = root / "index.json"
    for game in json.loads(index_file.read_text()) if index_file.exists() else []:
        if game.get("winner") is None:
            update_index(root, game["id"], winner=ABORTED)


def new_game_id(root):
    with LOCK:
        while True:
            taken = [int(path.name) for path in root.iterdir() if path.name.isdigit()]
            game_id = f"{max(taken, default=0) + 1:04d}"
            try:
                (root / game_id).mkdir()
                return game_id
            except FileExistsError:  # another launcher took it between the listing and the mkdir
                continue


def run_one(game, module, root, config, table_path, start_delay):
    if STOP.wait(start_delay):
        return ABORTED  # stopped before this game began
    with LOCK:
        game_id = new_game_id(root)
        game_dir = root / game_id
        (game_dir / "config.json").write_text(json.dumps(
            {"game": game, **config, "table_config_path": str(table_path)}, indent=1))
        seats = {player["name"]: player["model"] for player in config["players"]}
        update_index(root, game_id, started=time.time(), models=sorted(set(seats.values())),
                     seats=seats, winner=None)
    print(f"{game} {game_id}: started", flush=True)
    winner = ABORTED
    try:
        winner = module.play(config, game_dir, EventLog(game_dir / "events.jsonl"))
    except Exception:
        with open(game_dir / "console.txt", "a") as f:
            f.write(traceback.format_exc())
    finally:  # also when the launcher is stopped mid-game
        update_index(root, game_id, winner=winner)
        print(f"{game} {game_id}: " + (f"winner {winner}" if winner != ABORTED else
                                       f"ABORTED, see {game_dir / 'console.txt'}"), flush=True)
    return winner


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("game", choices=sorted(GAMES))
    parser.add_argument("table_config", help="path to the table config (json)")
    parser.add_argument("-n", "--games", type=int, default=1,
                        help="games to play (poker with \"duplicate\": pairs of games)")
    parser.add_argument("-p", "--parallel", type=int, default=1, help="games at the same time")
    parser.add_argument("--check", action="store_true", help="only validate the table")
    args = parser.parse_args()
    module = importlib.import_module(GAMES[args.game])
    table_path = Path(args.table_config).resolve()
    table = json.loads(table_path.read_text())
    problems = module.validate(table)
    if problems:
        sys.exit("Invalid table config:\n" + "\n".join(f"  - {problem}" for problem in problems))
    if args.check:
        return print("Table config is valid")
    if any(seat["model"] != MOCK_MODEL_NAME for seat in table["players"]) \
            and not os.environ.get(OPENROUTER_API_KEY_KEYWORD):
        sys.exit(f"{OPENROUTER_API_KEY_KEYWORD} is not set")
    root = data_dir(args.game)
    root.mkdir(parents=True, exist_ok=True)
    mark_unfinished_aborted(root)
    configs = module.make_configs(table, max(1, args.games))
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))  # so a Stop ends the games cleanly
    parallel = max(1, min(args.parallel, len(configs)))
    pool = ThreadPoolExecutor(parallel)
    futures = [pool.submit(run_one, args.game, module, root, config, table_path,
                           STAGGER_SECONDS * i if i < parallel else 0)
               for i, config in enumerate(configs)]
    try:
        winners = [future.result() for future in futures]
    except BaseException:  # Ctrl-C or SIGTERM: every game stops at its next model call
        # ponytail: waits for calls already in flight (up to the 180 s request timeout)
        STOP.set()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    pool.shutdown()
    print("Done: " + ", ".join(f"{winners.count(w)}× {w}" for w in sorted(set(winners), key=str)))
    print(f"Games are in {root}")


if __name__ == "__main__":
    main()
