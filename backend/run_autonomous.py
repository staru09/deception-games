"""
Runs fully autonomous games of Mafia: every seat is an LLM, served through OpenRouter.

    python run_autonomous.py configurations/autonomous_6p.json --games 10

The table config lists the seats, each with a role and a model:

    {"daytime_minutes": 2, "nighttime_minutes": 1, "shuffle_roles": false,
     "players": [{"role": "mafia", "model": "<openrouter id>", "reasoning": {"effort": "low"}},
                 {"role": "detective", "model": "..."}, {"role": "doctor", "model": "..."},
                 {"role": "villager", "model": "..."}, ...]}

Any other key of a seat (temperature, max_tokens, reasoning, provider, ...) goes into that
seat's llm_config, and "llm_defaults" does the same for all seats. The model "mock" plays
offline with random moves, for dry runs that make no API calls.

"moderator" is the model that narrates the game for spectators (moderator.py); the players
never see its lines. It defaults to Claude Haiku, or to "mock" when every seat is mock, and
null turns narration off. "voice" is the Deepgram voice that speaks the moderator's lines
(flux-hannah-en by default, needs DEEPGRAM_API_KEY), null for a silent moderator.

"variant": "misinformation" plays Mafia with unreliable information: anyone may bluff (see
MISINFORMATION_RULES in llm_players/llm_constants.py), each mafia player gets a cover role
to claim (llm_config "cover_role"), and one villager is secretly told it is the detective
(special_role "false_detective"; the storyteller chooses its answers). Left out, the game
is plain Mafia.

Cost: on every turn a player asks its model, with the whole chat so far, whether to speak.
"seconds_between_turns" (in "llm_defaults" or per seat) is the pause after each turn, so
it sets how many of these calls a game makes. Without it a player asks again right away.

Games are written to ./autonomous_games (or LLMAFIA_GAMES_DIR), one after the other, or with
--parallel N, N at a time (one launcher at a time: it alone hands out the game ids).

A game that stopped (say the API budget ran out) goes on from where it stopped with

    python run_autonomous.py --resume 0008 0009 ... [--parallel N]

Nothing that happened is played again: the manager rebuilds its state from events.jsonl and
the phase that was cut off goes on with the time it had left (see restore() in mafia_main.py).
The game's clock goes on from the moment it stopped, so the chat shows no gap, and a "resumed"
event in events.jsonl records the real time. A game that stopped while votes were being
counted can't be resumed.
"""
import os
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent
# has to be set before game_constants is imported, here and in the processes of the game
os.environ.setdefault("LLMAFIA_GAMES_DIR", "./autonomous_games")

import argparse
import json
import random
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from game_constants import DIRS_PREFIX, GAMES_INDEX_FILE, WHO_WINS_FILE, MAFIA_WINS_MESSAGE, \
    GAME_CONFIG_FILE, EVENTS_FILE, REMAINING_PLAYERS_FILE, PERSONAL_STATUS_FILE_FORMAT, \
    PLAYERS_KEY_IN_CONFIG, DAYTIME_MINUTES_KEY, NIGHTTIME_MINUTES_KEY, DEFAULT_DAYTIME_MINUTES, \
    DEFAULT_NIGHTTIME_MINUTES, OPTIONAL_CODE_NAMES, MAFIA_ROLE, DETECTIVE_ROLE, DOCTOR_ROLE, \
    TOWN_ROLES, MODERATOR_MODEL_KEY, NIGHT_FIRST_KEY, MODERATOR_VOICE_KEY, NIGHT_PACING_KEY, \
    VARIANT_KEY, MISINFORMATION_VARIANT, FALSE_DETECTIVE_ROLE, VILLAGER_ROLE
from llm_players.llm_constants import LLM_CONFIG_KEY, MODEL_NAME_KEY, USE_OPENROUTER_KEY, \
    USE_MOCK_KEY, MOCK_MODEL_NAME, PASS_TURN_TOKEN_KEY, USE_TURN_TOKEN_KEY, \
    DEFAULT_PASS_TURN_TOKEN, DEFAULT_USE_TURN_TOKEN, ASYNC_TYPE_KEY, SCHEDULE_THEN_GENERATE_TYPE, \
    WORDS_PER_SECOND_WAITING_KEY, LET_OTHERS_OPEN_KEY, OPENROUTER_API_KEY_KEYWORD, \
    COVER_ROLE_KEY, MAFIA_COVER_STORIES
from moderator import DEFAULT_MODERATOR_MODEL, DEFAULT_VOICE, DEEPGRAM_API_KEY_KEYWORD
from prepare_game import get_next_free_game_id, init_game

MINIMUM_NUM_PLAYERS = 4
DEFAULT_TIMEOUT_MINUTES = 60
ABORTED = "aborted"
SECONDS_FOR_PLAYERS_TO_EXIT = 10
STAGGER_SECONDS = 3  # between the starts of the first games of a parallel run
LOCK = threading.RLock()  # game ids and the index are shared by games running in parallel
STOP = threading.Event()  # set when the launcher is stopped: every game ends its processes


def validate_table(table):
    seats = table.get(PLAYERS_KEY_IN_CONFIG, [])
    roles = [seat.get("role") for seat in seats]
    num_mafia = roles.count(MAFIA_ROLE)
    problems = []
    if len(seats) < MINIMUM_NUM_PLAYERS:
        problems.append(f"a game needs at least {MINIMUM_NUM_PLAYERS} players, got {len(seats)}")
    if len(seats) > len(OPTIONAL_CODE_NAMES):
        problems.append(f"there are code names for only {len(OPTIONAL_CODE_NAMES)} players")
    for i, seat in enumerate(seats):
        if seat.get("role") not in (MAFIA_ROLE, *TOWN_ROLES):
            problems.append(f"player {i + 1} has the role {seat.get('role')!r}, "
                            f"it must be one of: {', '.join((MAFIA_ROLE, *TOWN_ROLES))}")
        model = seat.get("model")
        if not isinstance(model, str) or not model or "<" in model:
            problems.append(f"player {i + 1} has no model (got {model!r}): "
                            f"set an OpenRouter model id, or \"{MOCK_MODEL_NAME}\"")
    if num_mafia < 1:
        problems.append("there must be at least 1 mafia player")
    if num_mafia >= len(seats) - num_mafia:
        problems.append("there must be fewer mafia players than non-mafia players")
    for role in (DETECTIVE_ROLE, DOCTOR_ROLE):
        if roles.count(role) > 1:
            problems.append(f"there can be at most 1 {role}")
    moderator = table.get("moderator", "")
    if moderator is not None and (not isinstance(moderator, str) or "<" in moderator):
        problems.append(f"\"moderator\" must be an OpenRouter model id, \"{MOCK_MODEL_NAME}\" "
                        f"or null, got {moderator!r}")
    voice = table.get("voice", "")
    if voice is not None and (not isinstance(voice, str) or "<" in voice):
        problems.append(f"\"voice\" must be a Deepgram voice such as \"{DEFAULT_VOICE}\", or "
                        f"null, got {voice!r}")
    if table.get("variant") not in (None, MISINFORMATION_VARIANT):
        problems.append(f"\"variant\" must be \"{MISINFORMATION_VARIANT}\" or left out, "
                        f"got {table.get('variant')!r}")
    if table.get("variant") == MISINFORMATION_VARIANT and \
            (DETECTIVE_ROLE not in roles or VILLAGER_ROLE not in roles):
        problems.append("the misinformation variant needs a detective and at least 1 villager "
                        "(a villager is secretly told it's the detective)")
    if problems:
        sys.exit("Invalid table config:\n" + "\n".join(f"  - {problem}" for problem in problems))


def is_mock(seat):
    return seat["model"] == MOCK_MODEL_NAME


def get_moderator_model(table):
    """The table's "moderator" model; by default Haiku, or "mock" when every seat is mock (so a
    dry run makes no API call). "moderator": null plays without narration."""
    if "moderator" in table:
        return table["moderator"]
    return MOCK_MODEL_NAME if all(map(is_mock, table[PLAYERS_KEY_IN_CONFIG])) else DEFAULT_MODERATOR_MODEL


def get_voice(table):
    """The Deepgram voice that speaks the moderator's lines: "voice" in the table, by default
    Hannah when the moderator is a model (a mock moderator stays silent), null for none."""
    if get_moderator_model(table) in (MOCK_MODEL_NAME, None, ""):
        return None
    return table.get("voice", DEFAULT_VOICE)


def build_game_config(table, table_path):
    seats = table[PLAYERS_KEY_IN_CONFIG]
    roles = [seat["role"] for seat in seats]
    if table.get("shuffle_roles"):  # over many games every model plays every role
        random.shuffle(roles)
    seats = [{**seat, "role": role} for seat, role in zip(seats, roles)]
    # a new seat order and new names every game, so that neither can bias the votes
    random.shuffle(seats)
    if table.get("variant") == MISINFORMATION_VARIANT:  # a villager is told it's the detective
        false_detective = random.choice([seat for seat in seats if seat["role"] == VILLAGER_ROLE])
        false_detective["role"] = FALSE_DETECTIVE_ROLE
    names = random.sample(OPTIONAL_CODE_NAMES, len(seats))
    players = []
    for name, seat in zip(names, seats):
        llm_config = {
            MODEL_NAME_KEY: seat["model"],
            USE_OPENROUTER_KEY: not is_mock(seat),
            USE_MOCK_KEY: is_mock(seat),
            PASS_TURN_TOKEN_KEY: DEFAULT_PASS_TURN_TOKEN,
            USE_TURN_TOKEN_KEY: DEFAULT_USE_TURN_TOKEN,
            ASYNC_TYPE_KEY: SCHEDULE_THEN_GENERATE_TYPE,
            WORDS_PER_SECOND_WAITING_KEY: 3,  # pretend typing time, also slows down the chat
            LET_OTHERS_OPEN_KEY: False,  # there is no human to open the discussion
            **table.get("llm_defaults", {}),
            **{key: value for key, value in seat.items() if key not in ("role", "model")},
        }
        if table.get("variant") == MISINFORMATION_VARIANT and seat["role"] == MAFIA_ROLE:
            llm_config[COVER_ROLE_KEY] = random.choice(sorted(MAFIA_COVER_STORIES))  # its cover
        players.append({"name": name, "is_mafia": seat["role"] == MAFIA_ROLE, "is_llm": True,
                        "real_name": "", LLM_CONFIG_KEY: llm_config,
                        "special_role": "" if seat["role"] == MAFIA_ROLE else seat["role"]})
    return {PLAYERS_KEY_IN_CONFIG: players,
            DAYTIME_MINUTES_KEY: table.get(DAYTIME_MINUTES_KEY, DEFAULT_DAYTIME_MINUTES),
            NIGHTTIME_MINUTES_KEY: table.get(NIGHTTIME_MINUTES_KEY, DEFAULT_NIGHTTIME_MINUTES),
            MODERATOR_MODEL_KEY: get_moderator_model(table),
            MODERATOR_VOICE_KEY: get_voice(table),
            # spectators can follow the night step by step; only the night gets longer
            NIGHT_PACING_KEY: table.get("night_pacing", True),
            NIGHT_FIRST_KEY: True,  # night 1 first: nobody votes before anyone has died
            VARIANT_KEY: table.get("variant"),
            "table_config_path": str(table_path)}


def update_index(game_id, **fields):
    """The list of games that the viewer's game picker reads."""
    with LOCK:  # games running in parallel all update it
        _update_index(game_id, **fields)


def _update_index(game_id, **fields):
    index_file = Path(DIRS_PREFIX) / GAMES_INDEX_FILE
    games = json.loads(index_file.read_text()) if index_file.exists() else []
    game = next((game for game in games if game["id"] == game_id), None)
    if game is None:
        game = {"id": game_id}
        games.append(game)
    game.update(fields)
    temporary_file = index_file.with_suffix(".tmp")  # the viewer must never read half a file
    temporary_file.write_text(json.dumps(games, indent=1))
    os.replace(temporary_file, index_file)


def run_game(table, table_path, timeout_minutes, start_delay=0):
    # Games running in parallel start a few seconds apart, so that the providers don't get
    # every game's first calls at the same moment.
    if STOP.wait(start_delay):
        return ABORTED  # the launcher was stopped before this game began
    with LOCK:  # one game at a time picks the next free id and claims its directory
        game_id = get_next_free_game_id()
        config = build_game_config(table, table_path)
        init_game(game_id, config)
        game_dir = Path(DIRS_PREFIX) / game_id
        models = sorted({player[LLM_CONFIG_KEY][MODEL_NAME_KEY] for player in config[PLAYERS_KEY_IN_CONFIG]})
        update_index(game_id, started=time.time(), models=models, winner=None)
    return play(game_id, [player["name"] for player in config[PLAYERS_KEY_IN_CONFIG]],
                timeout_minutes)


def resume_game(game_id, timeout_minutes, start_delay=0):
    """Goes on with a stopped game: the manager and the living players, from where it stopped."""
    if STOP.wait(start_delay):
        return ABORTED
    game_dir = Path(DIRS_PREFIX) / game_id
    events = [json.loads(line) for line in (game_dir / EVENTS_FILE).read_text().splitlines()]
    living = (game_dir / REMAINING_PLAYERS_FILE).read_text().splitlines()
    for name in living:  # the manager waits for each of them to join again
        (game_dir / PERSONAL_STATUS_FILE_FORMAT.format(name)).write_text("")
    update_index(game_id, winner=None, resumed=time.time())
    # the game's clock goes on from its last event (game_time() in game_constants.py)
    return play(game_id, living, timeout_minutes, stopped_at=events[-1]["ts"])


def play(game_id, names, timeout_minutes, stopped_at=None):
    """Runs the game's manager and one process per named player until the game ends."""
    game_dir = Path(DIRS_PREFIX) / game_id
    # PYTHONUTF8: on Windows a model's first non-cp1252 character would crash its player
    environment = {**os.environ, "PYTHONUTF8": "1"}
    if stopped_at is not None:
        environment["LLMAFIA_CLOCK_OFFSET"] = str(time.time() - stopped_at)

    def start(script, *arguments, console_name):
        # a resumed game keeps what its processes printed before it stopped
        console = open(game_dir / f"console_{console_name}.txt", "w" if stopped_at is None else "a")
        if stopped_at is not None:
            console.write(f"\n===== resumed at {time.ctime()} =====\n")
            console.flush()
        return subprocess.Popen([sys.executable, "-u", script, game_id, *arguments],
                                env=environment, stdout=console, stderr=subprocess.STDOUT)

    processes = {"manager": start("mafia_main.py", *(["--resume"] if stopped_at is not None else []),
                                  console_name="manager")}
    for name in names:
        processes[name] = start("llm_interface.py", name, console_name=name)
    manager = processes["manager"]
    deadline = time.time() + timeout_minutes * 60
    problem = None
    try:
        while manager.poll() is None and not problem:
            # a player that leaves the game normally (eliminated) exits with 0
            crashed = [name for name, process in processes.items() if process.poll()]
            if crashed:
                problem = f"crashed: {', '.join(crashed)} (see console_<name>.txt in {game_dir})"
            elif time.time() > deadline:
                problem = f"not finished after {timeout_minutes} minutes"
            elif STOP.wait(1):
                problem = "the launcher was stopped"
        if manager.poll():
            problem = problem or f"the game manager crashed (see {game_dir}/console_manager.txt)"
        if not problem:  # the players see that the game is over and leave by themselves
            exit_deadline = time.time() + SECONDS_FOR_PLAYERS_TO_EXIT
            while time.time() < exit_deadline and any(p.poll() is None for p in processes.values()):
                time.sleep(0.2)
    finally:  # also on Ctrl-C: a process left behind would go on calling the API
        for process in processes.values():
            if process.poll() is None:
                process.kill()
        winner = ABORTED
        if not problem and manager.poll() == 0:
            is_mafia_win = MAFIA_WINS_MESSAGE in (game_dir / WHO_WINS_FILE).read_text()
            winner = "mafia" if is_mafia_win else "town"
        update_index(game_id, winner=winner)
        print(f"Game {game_id}: " + (f"{winner} wins" if winner != ABORTED else
                                     f"ABORTED, {problem or 'the launcher was stopped'}"),
              flush=True)
    return winner


def mark_unfinished_games_aborted():
    # At start-up, an entry without a result is left from a launcher that was killed before it
    # could clean up (run only one launcher at a time). The viewer would wait for it forever.
    index_file = Path(DIRS_PREFIX) / GAMES_INDEX_FILE
    if index_file.exists():
        for game in json.loads(index_file.read_text()):
            if game["winner"] is None:
                update_index(game["id"], winner=ABORTED)


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("table_config", nargs="?", help="path to the table config (json)")
    parser.add_argument("--resume", nargs="+", metavar="GAME_ID",
                        help="go on with these stopped games instead of starting new ones")
    parser.add_argument("-n", "--games", type=int, default=1, help="number of games to play")
    parser.add_argument("--timeout-minutes", type=float, default=DEFAULT_TIMEOUT_MINUTES,
                        help="a game that takes longer is aborted")
    parser.add_argument("-p", "--parallel", type=int, default=1,
                        help="how many games to run at the same time (each is ~9 processes, ~165 MB)")
    args = parser.parse_args()
    if bool(args.table_config) == bool(args.resume):
        parser.error("give either a table config or --resume with game ids")
    os.chdir(REPO_DIR)  # the game's processes find each other's files relative to the repo
    if args.resume:
        table = table_path = None
        configs = [json.loads((Path(DIRS_PREFIX) / game_id / GAME_CONFIG_FILE).read_text())
                   for game_id in args.resume]
        models = [config.get(MODERATOR_MODEL_KEY) for config in configs] + [
            player[LLM_CONFIG_KEY][MODEL_NAME_KEY] for config in configs
            for player in config[PLAYERS_KEY_IN_CONFIG]]
        args.games = len(args.resume)
    else:
        table_path = Path(args.table_config).resolve()
        table = json.loads(table_path.read_text())
        validate_table(table)
        models = [seat["model"] for seat in table[PLAYERS_KEY_IN_CONFIG]] + [get_moderator_model(table)]
    if any(model not in (MOCK_MODEL_NAME, None, "") for model in models) \
            and not os.environ.get(OPENROUTER_API_KEY_KEYWORD):
        sys.exit(f"{OPENROUTER_API_KEY_KEYWORD} is not set")
    if table and get_voice(table) and not os.environ.get(DEEPGRAM_API_KEY_KEYWORD):
        print(f"Note: {DEEPGRAM_API_KEY_KEYWORD} is not set, so the moderator will not speak",
              flush=True)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))  # so that `finally` stops the games
    mark_unfinished_games_aborted()
    parallel = max(1, min(args.parallel, args.games))
    pool = ThreadPoolExecutor(parallel)
    if args.resume:
        futures = [pool.submit(resume_game, game_id, args.timeout_minutes,
                               STAGGER_SECONDS * i if i < parallel else 0)
                   for i, game_id in enumerate(args.resume)]
    else:
        futures = [pool.submit(run_game, table, table_path, args.timeout_minutes,
                               STAGGER_SECONDS * i if i < parallel else 0) for i in range(args.games)]
    try:
        winners = [future.result() for future in futures]
    except BaseException:  # Ctrl-C or SIGTERM: every running game stops its processes
        STOP.set()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    pool.shutdown()
    print("Done: " + ", ".join(f"{winners.count(winner)} {winner}" for winner in sorted(set(winners))))
    print(f"Games are in {Path(DIRS_PREFIX).resolve()}")


if __name__ == "__main__":
    main()
