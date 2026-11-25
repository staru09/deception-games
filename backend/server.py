"""Serve the arena on localhost: the dashboard, the four games' viewers and data, and the API
that lists, starts and stops AI runs (docs/ARENA_CONTRACT.md §7).

    python server.py [--port 8000] [--host 127.0.0.1]

    /                    -> ../frontend/ (the dashboard at /, the viewers at /<game>/)
    /misinformation/     -> the Mafia viewer's page, which themes itself by its URL
    /<game>/games/...    -> that game's data dir; mafia and misinformation share one, and each
                            gets its own filtered index.json
    /api/...             -> games, tables, models, budget, launches; POST launch and stop

Data dirs, relative to backend/: $LLMAFIA_GAMES_DIR (default ./autonomous_games) for Mafia and
Misinformation Mafia, $SENATE_GAMES_DIR and $POKER_GAMES_DIR (see arena.run.data_dir).
Launcher logs and records: $ARENA_LAUNCHES_DIR (default ./launches).

The games hold full prompts and reasoning traces and the API starts paid runs, so the server
binds 127.0.0.1 and answers only requests addressed to a local name. From another machine use
an SSH tunnel:
    ssh -L 8000:127.0.0.1:8000 <host>
Start it with OPENROUTER_API_KEY in its environment: the launchers inherit it, the page never
sees it. Launchers run in their own session, so restarting the server doesn't stop a paid
batch: each launch is recorded in the launches dir, and a restarted server still lists it,
refuses a second launcher on its data dir, and can stop it.
"""
import argparse
import itertools
import json
import os
import posixpath
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import requests

import run_autonomous
from arena.run import data_dir, ABORTED
from game_constants import MISINFORMATION_VARIANT
from llm_players.llm_constants import MOCK_MODEL_NAME, OPENROUTER_API_KEY_KEYWORD, MODEL_NAME_KEY, \
    USE_OPENROUTER_KEY, USE_MOCK_KEY
from llm_players.openrouter_llm import BASE_URL as OPENROUTER_BASE_URL
from moderator import DEFAULT_MODERATOR_MODEL

BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
CONFIG_DIR = BACKEND_DIR / "configurations"
LAUNCHES_DIR = (BACKEND_DIR / os.environ.get("ARENA_LAUNCHES_DIR", "launches")).resolve()
MAFIA_GAMES = ("mafia", "misinformation")  # one engine and one data dir, split by variant
VARIANTS = {None: "mafia", MISINFORMATION_VARIANT: "misinformation"}  # config "variant" -> game
FILTERED_INDEXES = {f"/{game}/games/index.json": game for game in MAFIA_GAMES}
MISINFORMATION_PAGES = ("/misinformation/", "/misinformation/index.html")  # the Mafia page
# The engines set these from a seat's "model". In a table they would override it, and could turn
# a seat shown as "mock" into a paid one.
RESERVED_KEYS = (MODEL_NAME_KEY, USE_OPENROUTER_KEY, USE_MOCK_KEY)
MAFIA_ROLES = ["mafia", "detective", "doctor", "villager"]
GAMES = {
    "mafia": {"title": "Mafia", "sides": ["town", "mafia"], "roles": MAFIA_ROLES,
              "default_moderator": DEFAULT_MODERATOR_MODEL,
              "description": "The mafia kill by night; the town debates and votes someone out by day."},
    "misinformation": {"title": "Misinformation Mafia", "sides": ["town", "mafia"], "roles": MAFIA_ROLES,
                       "default_moderator": DEFAULT_MODERATOR_MODEL,
                       "description": "Mafia where anyone may bluff, one villager is a false "
                                      "detective and the dead keep their roles secret."},
    "senate": {"title": "Senate", "sides": ["loyalists", "conspiracy"],
               "roles": ["usurper", "conspirator", "loyalist"],
               "description": "Loyalists pass reforms while a hidden Conspiracy pushes decrees "
                              "and tries to raise its Usurper."},
    "poker": {"title": "Poker", "sides": [], "roles": [],
              "description": "Two models play no-limit Texas Hold'em, in duplicate pairs that "
                             "cancel out the luck of the cards."},
}
MAX_GAMES = 50
MAX_PARALLEL = 8
MAX_BODY_BYTES = 64 * 1024
CHECK_TIMEOUT_SECONDS = 60  # `arena.run --check` only imports the game and validates
LOG_TAIL_LINES = 15
LOG_TAIL_BYTES = 16 * 1024
FINISHED_LAUNCHES_SHOWN = 10  # /api/launches: every running launcher, and the newest of the others
BUDGET_NOTE = ("This is the API key's own limit. The workspace budget can't be read from here: "
               "check it on openrouter.ai.")


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def write_json(path, data):
    temporary_file = path.with_suffix(".tmp")  # a reader must never see half a file
    temporary_file.write_text(json.dumps(data, indent=1))
    os.replace(temporary_file, path)


def games_dir(game):
    if game in MAFIA_GAMES:
        return (BACKEND_DIR / os.environ.get("LLMAFIA_GAMES_DIR", "./autonomous_games")).resolve()
    return data_dir(game)


# ---------- game data ----------

_mafia_split = [None, {}]  # [(index path, mtime), {game: entries}]
_costs = {}  # run dir -> (signature of its reasoning files, summed cost)
CACHE_LOCK = threading.Lock()


def index_entries(game):
    """The game's index.json entries; Mafia's shared index split by each game's variant."""
    root = games_dir(game)
    if game not in MAFIA_GAMES:
        entries = read_json(root / "index.json", [])
        return entries if isinstance(entries, list) else []
    index_file = root / "index.json"
    try:
        key = (index_file, index_file.stat().st_mtime_ns)
    except OSError:
        return []
    with CACHE_LOCK:
        # Read every config again whenever the index changes: an id can be reused (the newest
        # game deleted, the next one gets its id), and a new game is written to the index too.
        if _mafia_split[0] != key:
            entries = read_json(index_file, [])
            split = {name: [] for name in MAFIA_GAMES}
            for entry in entries if isinstance(entries, list) else []:
                config = read_json(root / str(entry.get("id")) / "config.json", {})
                name = VARIANTS.get(config.get("variant") if isinstance(config, dict) else None)
                if name:
                    split[name].append(entry)
            _mafia_split[:] = [key, split]
        return _mafia_split[1][game]


def run_cost(game_dir):
    """The summed usage.cost of every model call of a run, or None when it logged none."""
    files = sorted(game_dir.glob("*_reasoning.jsonl"))
    signature = [(f.name, f.stat().st_mtime_ns, f.stat().st_size) for f in files]
    cached = _costs.get(game_dir)
    if cached and cached[0] == signature:
        return cached[1]
    total, found = 0.0, False
    for f in files:
        for line in f.read_text(errors="replace").splitlines():
            try:
                cost = json.loads(line)["usage"]["cost"]
            except (ValueError, KeyError, TypeError):
                continue  # a mock call has no usage
            if isinstance(cost, (int, float)):
                total, found = total + cost, True
    _costs[game_dir] = (signature, total if found else None)
    return _costs[game_dir][1]


def summary(game):
    root = games_dir(game)
    entries = sorted(index_entries(game), key=lambda e: e.get("started") or 0, reverse=True)
    finished = [e for e in entries if e.get("winner") not in (None, ABORTED)]
    wins = dict.fromkeys(GAMES[game]["sides"], 0)
    for entry in finished:
        winner = entry["winner"]
        if game == "poker":  # poker has no sides: count wins per model ("draw" stays "draw")
            winner = (entry.get("seats") or {}).get(winner, winner)
        wins[winner] = wins.get(winner, 0) + 1
    costs = [run_cost(root / str(e["id"])) for e in finished
             if any(model != MOCK_MODEL_NAME for model in e.get("models", []))]
    costs = [cost for cost in costs if cost is not None]
    return {**GAMES[game], "runs": len(entries), "live": sum(e.get("winner") is None for e in entries),
            "wins": wins, "avg_cost": sum(costs) / len(costs) if costs else None, "list": entries}


def is_mafia_table(table):
    # configurations/ also holds the older hand-run game configs (and models.json): skip them
    players = table.get("players") if isinstance(table, dict) else None
    return isinstance(players, list) and bool(players) and \
        all(isinstance(seat, dict) and "model" in seat and "role" in seat for seat in players)


def tables(game):
    """Saved tables: the game's own, then those the dashboard saved, newest first."""
    if game in MAFIA_GAMES:
        own = [path for path in sorted(CONFIG_DIR.glob("*.json"))
               if is_mafia_table(table := read_json(path))
               and VARIANTS.get(table.get("variant")) == game]
    else:
        own = sorted((CONFIG_DIR / game).glob("*.json"))
    saved = sorted((CONFIG_DIR / game / "dashboard").glob("*.json"), reverse=True)
    found = [(path, read_json(path)) for path in own + saved]
    return [{"path": str(path.relative_to(CONFIG_DIR)), "table": table}
            for path, table in found if isinstance(table, dict)]


def budget():
    key = os.environ.get(OPENROUTER_API_KEY_KEYWORD)
    if not key:
        return {"error": f"{OPENROUTER_API_KEY_KEYWORD} is not set on the server", "note": BUDGET_NOTE}
    try:
        response = requests.get(f"{OPENROUTER_BASE_URL}/key", timeout=10,
                                headers={"Authorization": f"Bearer {key}"})
        response.raise_for_status()
        data = response.json()["data"]
        return {"limit": data.get("limit"), "usage": data.get("usage"),
                "remaining": data.get("limit_remaining"), "note": BUDGET_NOTE}
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        # the message names the URL, never the key
        return {"error": f"OpenRouter did not answer: {e}", "note": BUDGET_NOTE}


# ---------- launchers ----------
# Each launch has a record, <name>_<game>.json next to its log in LAUNCHES_DIR: pid, game, data
# dir, log, started, argv, and exit_code once this server has seen it end. The records, not this
# process's memory, decide what runs, so they survive a restart of the server.

_children = {}  # record path -> Popen, for the launchers this server process started
LAUNCH_LOCK = threading.Lock()  # a launch checks for a running launcher, then spawns: one at a time
RECORDS_LOCK = threading.Lock()  # two requests may both see a launcher end and update its record


def runs_argv(record):
    """Whether the record's pid still runs the recorded command. A pid alone can be reused, and
    an ended launcher (or one not reaped yet) has an empty cmdline."""
    # ponytail: Linux /proc only; elsewhere a launcher from before a restart reads as ended
    try:
        argv = Path(f"/proc/{record['pid']}/cmdline").read_bytes().split(b"\0")[:-1]
        return argv == [arg.encode() for arg in record["argv"]]
    except (OSError, KeyError, TypeError, AttributeError):
        return False


def launch_records():
    """Every recorded launch, newest first, with "running" and "exit_code" (null while it runs,
    "unknown" when it ended without this server seeing how)."""
    records = []
    with RECORDS_LOCK:  # ponytail: reads every record per call; archive old ones if there are thousands
        for path in LAUNCHES_DIR.glob("*.json"):
            record = read_json(path)
            if not isinstance(record, dict):
                continue
            child = _children.get(path)
            if child is not None:  # started by this process: poll() knows, and reaps it
                running = child.poll() is None
                if not running and record.get("exit_code") is None:
                    record["exit_code"] = child.returncode
                    write_json(path, record)  # so a restarted server can still tell
            else:
                running = record.get("exit_code") is None and runs_argv(record)
            records.append({**record, "path": path, "running": running,
                            "exit_code": None if running else record.get("exit_code", "unknown")})
    return sorted(records, key=lambda r: r.get("started") or 0, reverse=True)


def is_count(value, top):
    return type(value) is int and 1 <= value <= top  # type(): JSON true is not a count


def reserved_problem(table):
    """A table must choose models only through each seat's "model" (see RESERVED_KEYS)."""
    defaults, seats = table.get("llm_defaults", {}), table.get("players")
    if not isinstance(defaults, dict):
        return "\"llm_defaults\" must be a JSON object"
    places = [("\"llm_defaults\"", defaults)] + \
        [(f"player {i + 1}", seat) for i, seat in enumerate(seats if isinstance(seats, list) else [])]
    for place, keys in places:
        found = [key for key in RESERVED_KEYS if isinstance(keys, dict) and key in keys]
        if found:
            return f"{place} sets {', '.join(found)}: set the seat's \"model\" instead"
    return None


def table_problem(game, table):
    """Why the launcher would refuse this table (or the server refuses it), or None."""
    problem = reserved_problem(table)
    if problem:
        return problem
    if game in MAFIA_GAMES:
        wanted = MISINFORMATION_VARIANT if game == "misinformation" else None
        if table.get("variant") != wanted:
            return f"a {GAMES[game]['title']} table needs \"variant\": {json.dumps(wanted)}"
        try:
            run_autonomous.validate_table(table)
        except SystemExit as e:
            return str(e.code)
        except Exception as e:  # a malformed table (say "players" is not a list)
            return f"Invalid table config: {e!r}"
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".json") as table_file:  # only valid tables are saved
        json.dump(table, table_file)
        table_file.flush()
        try:
            result = subprocess.run([sys.executable, "-m", "arena.run", game, table_file.name, "--check"],
                                    cwd=BACKEND_DIR, capture_output=True, text=True,
                                    timeout=CHECK_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return f"checking the table took more than {CHECK_TIMEOUT_SECONDS} s"
    if result.returncode == 0:
        return None
    return (result.stderr or result.stdout).strip()[-2000:] or "invalid table config"


def free_name(game):
    """<YYYYmmdd-HHMMSS> for this launch's table and log, with -2, -3, ... on a clash."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for n in itertools.count(1):
        name = stamp if n == 1 else f"{stamp}-{n}"
        if not (CONFIG_DIR / game / "dashboard" / f"{name}.json").exists() \
                and not (LAUNCHES_DIR / f"{name}_{game}.log").exists():
            return name


def launch(body):
    """(status, response) for POST /api/launch."""
    game, table = body.get("game"), body.get("table")
    if not isinstance(game, str) or game not in GAMES:
        return 400, {"error": f"game must be one of: {', '.join(GAMES)}"}
    if not isinstance(table, dict):
        return 400, {"error": "table must be a JSON object"}
    if not is_count(body.get("games"), MAX_GAMES) or not is_count(body.get("parallel"), MAX_PARALLEL):
        return 400, {"error": f"games must be 1–{MAX_GAMES} and parallel 1–{MAX_PARALLEL}"}
    root = games_dir(game)
    with LAUNCH_LOCK:
        running = next((r for r in launch_records() if r["running"] and r.get("dir") == str(root)), None)
        if running:
            return 409, {"error": f"launcher {running['pid']} ({running['game']}) is still running "
                                  f"on {root.name}: stop it or let it finish first"}
        problem = table_problem(game, table)
        if problem:
            return 400, {"error": problem}
        name = free_name(game)
        table_path = CONFIG_DIR / game / "dashboard" / f"{name}.json"
        table_path.parent.mkdir(parents=True, exist_ok=True)
        with open(table_path, "x") as f:  # "x": never overwrite the table of another launch
            json.dump(table, f, indent=1)
        relative = str(table_path.relative_to(BACKEND_DIR))
        command = ["run_autonomous.py", relative] if game in MAFIA_GAMES else \
            ["-m", "arena.run", game, relative]
        command = [sys.executable, "-u", *command, "--games", str(body["games"]),
                   "--parallel", str(body["parallel"])]
        LAUNCHES_DIR.mkdir(parents=True, exist_ok=True)
        log_path = LAUNCHES_DIR / f"{name}_{game}.log"
        with open(log_path, "x") as log:
            log.write("$ python " + " ".join(command[2:]) + "\n")
            log.flush()
            # its own session: a restart of the server (or Ctrl-C on it) must not stop a paid batch
            process = subprocess.Popen(command, cwd=BACKEND_DIR, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        record_path = log_path.with_suffix(".json")
        try:
            write_json(record_path, {"pid": process.pid, "game": game, "dir": str(root),
                                     "log": str(log_path), "started": time.time(), "argv": command,
                                     "table": relative, "games": body["games"],
                                     "parallel": body["parallel"]})
        except OSError as e:
            # Unrecorded, it would escape the one-launcher rule and Stop. It has had no time to
            # start a game; its group (its own session) holds anything it did start.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            table_path.unlink(missing_ok=True)  # nothing was launched with it
            return 500, {"error": f"could not record the launch ({e}), so launcher {process.pid} "
                                  f"was killed before it started a game", "pid": process.pid}
        _children[record_path] = process
    print(f"Launched {game} (pid {process.pid}): {' '.join(command[2:])}", flush=True)
    return 200, {"pid": process.pid, "game": game, "table": relative,
                 "log": os.path.relpath(log_path, BACKEND_DIR)}


# A stopped launcher first waits out the model calls in flight (a billed answer is still logged),
# which takes up to the 190 s request timeout; past this it is stuck and its group is killed.
STOP_WAIT_SECONDS = 300
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")


def is_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    return True


def kill_group_later(pgid, child):
    """A launcher that got SIGTERM ends its games itself. Once it has exited (or after
    STOP_WAIT_SECONDS, stuck), SIGKILL whatever of its group is still alive: game processes a launcher
    killed hard left playing. The launcher is its own session leader, so its group holds nothing
    else. Never killed while the launcher still waits for an answer it will log."""
    deadline = time.time() + STOP_WAIT_SECONDS
    while time.time() < deadline and (child.poll() is None if child else is_alive(pgid)):
        time.sleep(1)
    time.sleep(2)  # its game processes get a moment to end after their launcher
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:  # the whole group has ended
        pass


def stop(body):
    pid = body.get("pid")
    records = [r for r in launch_records() if type(pid) is int and r.get("pid") == pid]
    if not records:
        return 404, {"error": "not a launcher this server started"}
    record = next((r for r in records if r["running"]), None)
    if record is None:  # never signal a pid that may belong to someone else now
        return 409, {"error": "that launcher has already finished"}
    child = _children.get(record["path"])
    if child is not None:
        child.terminate()
    else:  # started before a restart: runs_argv() has just matched its command line
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:  # it ended in between
            return 409, {"error": "that launcher has already finished"}
    threading.Thread(target=kill_group_later, args=(pid, child), daemon=True).start()
    print(f"Stopped {record['game']} (pid {pid})", flush=True)  # it aborts its games, marks them
    return 200, {"pid": pid, "stopping": True}


def log_tail(path):
    try:
        with open(path, "rb") as f:
            f.seek(max(0, f.seek(0, os.SEEK_END) - LOG_TAIL_BYTES))
            return f.read().decode(errors="replace").splitlines()[-LOG_TAIL_LINES:]
    except (OSError, TypeError):
        return []


def launches():
    return [{"pid": r.get("pid"), "game": r.get("game"), "started": r.get("started"),
             "running": r["running"], "exit_code": r["exit_code"], "table": r.get("table"),
             "games": r.get("games"), "parallel": r.get("parallel"), "log": log_tail(r.get("log"))}
            for i, r in enumerate(launch_records()) if r["running"] or i < FINISHED_LAUNCHES_SHOWN]


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    allowed_hosts = {"127.0.0.1", "localhost", "::1"}  # main() adds --host
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".jsonl": "application/x-ndjson", ".glb": "model/gltf-binary",
                      ".mjs": "text/javascript"}

    def parse_request(self):
        # Every request, of any method, must be addressed to a local name: a page that reaches
        # 127.0.0.1 through DNS rebinding sends its own name as Host, and must read nothing.
        if not super().parse_request():
            return False
        try:
            hostname = urlsplit("http://" + self.headers.get("Host", "")).hostname
        except ValueError:
            hostname = None
        if hostname not in self.allowed_hosts:
            self.send_json(403, {"error": f"open http://127.0.0.1:{self.server.server_port}/"})
            return False
        return True

    def translate_path(self, path):
        # super() resolves against self.directory and already blocks ".." traversal
        url_path = urlsplit(path).path
        parts = url_path.split("/", 3)  # "", game, "games", the rest
        if len(parts) > 2 and parts[1] in GAMES and parts[2] == "games":
            self.directory, path = str(games_dir(parts[1])), "/" + (parts[3] if len(parts) > 3 else "")
        elif url_path in MISINFORMATION_PAGES:
            self.directory, path = str(FRONTEND_DIR), "/mafia/index.html"
        else:
            self.directory = str(FRONTEND_DIR)
        return super().translate_path(path)

    sent_status = None

    def send_response(self, code, message=None):
        self.sent_status = code
        super().send_response(code, message)

    def end_headers(self):
        # The 3D models and textures (/<page>/assets/...) stay in the browser for a day, so a second
        # viewer tab doesn't download them again. Everything else is fetched fresh: live games grow
        # while being watched, and the code changes while we work on it.
        cached = self.sent_status in (200, 304) and urlsplit(self.path).path.split("/")[2:3] == ["assets"]
        self.send_header("Cache-Control", "max-age=86400" if cached else "no-store")
        # the data dirs hold model-written text, served from the origin that may start runs
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()  # and no CORS header, ever: other sites must not read or post

    def log_message(self, *args):
        pass  # the viewers poll every second; per-request logs would bury everything else

    def send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlsplit(self.path)
        path = posixpath.normpath(unquote(url.path))  # "/mafia/games/./index%2ejson" too
        if path in FILTERED_INDEXES:
            game = FILTERED_INDEXES[path]
            if not (games_dir(game) / "index.json").exists():
                return self.send_error(404)  # the viewer treats it as "no games yet"
            return self.send_json(200, index_entries(game))
        if url.path == "/misinformation":  # its page fetches games/ relative to the trailing /
            self.send_response(301)
            self.send_header("Location", "/misinformation/" + (f"?{url.query}" if url.query else ""))
            self.send_header("Content-Length", "0")
            return self.end_headers()
        if not url.path.startswith("/api/"):
            return super().do_GET()
        query = parse_qs(url.query)
        if url.path == "/api/games":
            return self.send_json(200, {game: summary(game) for game in GAMES})
        if url.path == "/api/tables":
            game = query.get("game", [""])[0]
            if game not in GAMES:
                return self.send_json(400, {"error": f"game must be one of: {', '.join(GAMES)}"})
            return self.send_json(200, tables(game))
        if url.path == "/api/models":
            return self.send_json(200, read_json(CONFIG_DIR / "models.json", []))
        if url.path == "/api/budget":
            return self.send_json(200, budget())
        if url.path == "/api/launches":
            return self.send_json(200, launches())
        return self.send_json(404, {"error": "no such API route"})

    def post_refusal(self):
        """Why this POST is refused, or None. A page from another site can send neither this
        Content-Type nor X-Arena without a CORS preflight, which this server never approves;
        parse_request() has already refused any Host that isn't a local name."""
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if content_type != "application/json":
            return "Content-Type must be application/json"
        if self.headers.get("X-Arena") != "1":
            return "the X-Arena: 1 header is missing"
        if self.headers.get("Origin") != "http://" + self.headers.get("Host", ""):
            return "Origin must be this server"
        return None

    def do_POST(self):
        refusal = self.post_refusal()
        if refusal:
            return self.send_json(403, {"error": refusal})
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self.send_json(411, {"error": "Content-Length is required"})
        if not 0 < length <= MAX_BODY_BYTES:
            return self.send_json(413, {"error": f"the body must be 1 to {MAX_BODY_BYTES} bytes"})
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self.send_json(400, {"error": "the body must be a JSON object"})
        route = {"/api/launch": launch, "/api/stop": stop}.get(urlsplit(self.path).path)
        if route is None:
            return self.send_json(404, {"error": "no such API route"})
        return self.send_json(*route(body))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    if args.host not in LOOPBACK_HOSTS:  # the API starts paid runs and has no login
        sys.exit(f"Refusing --host {args.host}: the arena must listen on loopback only. "
                 f"To reach it from another machine use an SSH tunnel: ssh -L 8000:127.0.0.1:8000 <host>")
    Handler.allowed_hosts = Handler.allowed_hosts | {args.host}
    print(f"Arena: http://{args.host}:{args.port}/   (Mafia games from {games_dir('mafia')})",
          flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
