"""Checks server.py end to end with mock players only: no model is called and no real data dir is
touched.

    python server.check.py

Starts the server on a free port with LLMAFIA_GAMES_DIR, SENATE_GAMES_DIR, POKER_GAMES_DIR and
ARENA_LAUNCHES_DIR in a temporary directory and without OPENROUTER_API_KEY, then checks:
  1. the Mafia and Misinformation indexes filtered by variant (also on odd spellings of the
     path, and after a game id is reused), and /api/games, on fake games;
  2. a request for another Host is refused (403), whatever its method; a POST without JSON,
     X-Arena or this server's Origin is refused (403); no response has a CORS header;
     /api/stop refuses a pid the server did not start;
  3. invalid tables are refused (400), and so is a table that sets "model_name", "use_openrouter"
     or "use_mock" (they would override a seat's model);
  4. a mock run of each game launched over the API: Senate and Poker play to a winner, Mafia and
     Misinformation are stopped after their first events and end up "aborted"; a second
     launcher on the shared Mafia data dir is refused (409); launches in the same second get
     their own table and log; a launch whose record can't be written is refused (500) and its
     launcher killed;
  5. a restart of the server: a running Mafia launcher survives it, is still listed with its
     log, still blocks a second launcher, and can still be stopped;
  6. the dashboard, every viewer page (/misinformation/ is the Mafia page) and common/replay.js
     are served, and ".." can't escape: files that do exist one level above frontend/ and above
     the data dirs are never served, however ".." is spelled.
The tables these launches save under configurations/ are removed at the end, and so is the
temporary directory when every check passed.
"""
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
CONFIG_DIR = BACKEND_DIR / "configurations"
TABLES = {"senate": "senate/mock_5p.json", "poker": "poker/mock.json", "mafia": "mock_6p.json"}
RESERVED_KEYS = ("model_name", "use_openrouter", "use_mock")
SERVER_START_SECONDS = 20
MAFIA_EVENTS_SECONDS = 120   # a mock Mafia game starts ~8 processes before its first event
STOP_SECONDS = 60
ARENA_FINISH_SECONDS = 600
CLASH_SECONDS = 10  # two quick launches fit in this many seconds
FAILURES = []
CREATED = []  # tables the launches saved in the repo, removed at the end
PORT = None
SERVER = None


def check(ok, what):
    print(("ok    " if ok else "FAIL  ") + what, flush=True)
    if not ok:
        FAILURES.append(what)
    return ok


def request(method, path, body=None, headers=None):
    """(status, JSON or text, response headers); `path` is sent exactly as given."""
    connection = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
    data = body if isinstance(body, bytes) or body is None else json.dumps(body).encode()
    connection.request(method, path, body=data, headers=headers or {})
    response = connection.getresponse()
    raw = response.read()
    connection.close()
    try:
        content = json.loads(raw)
    except ValueError:
        content = raw.decode(errors="replace")
    return response.status, content, response.headers


def post(path, body, **headers):
    """A POST as the dashboard sends it; a header given as None is left out."""
    default = {"Content-Type": "application/json", "X-Arena": "1", "Origin": f"http://127.0.0.1:{PORT}"}
    return request("POST", path, body, {k: v for k, v in {**default, **headers}.items() if v is not None})


def get(path):
    return request("GET", path)[1]


def no_cors(headers):
    return not any(name.lower().startswith("access-control") for name in headers)


def wait_until(condition, seconds, what):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            if condition():
                return check(True, what)
        except (OSError, KeyError, TypeError, ValueError, StopIteration):
            pass  # not there yet
        time.sleep(1)
    return check(False, f"{what} (gave up after {seconds} s)")


def launch(game, table, games=1, parallel=1):
    status, content, _ = post("/api/launch", {"game": game, "table": table, "games": games, "parallel": parallel})
    if status == 200:
        CREATED.append(BACKEND_DIR / content["table"])
    return status, content


def next_stamps():
    """The launch-name stamps of this second and the next CLASH_SECONDS - 1."""
    return {time.strftime("%Y%m%d-%H%M%S", time.localtime(time.time() + s)) for s in range(CLASH_SECONDS)}


def launcher(pid):
    return next(entry for entry in get("/api/launches") if entry["pid"] == pid)


def ids(path):
    return [entry["id"] for entry in get(path)]


def table_of(game):
    return json.loads((CONFIG_DIR / TABLES["mafia" if game == "misinformation" else game]).read_text()) \
        | ({"variant": "misinformation"} if game == "misinformation" else {})


def start_server(log_file):
    global SERVER
    SERVER = subprocess.Popen([sys.executable, "server.py", "--port", str(PORT)], cwd=BACKEND_DIR,
                              stdout=log_file, stderr=subprocess.STDOUT)
    return wait_until(lambda: request("GET", "/")[0] == 200, SERVER_START_SECONDS, "the server starts")


def seed_mafia(root):
    """0001 plain Mafia (town won), 0002 Misinformation (mafia won), 0003 Misinformation, live."""
    index = []
    for game_id, variant, winner, cost in [("0001", None, "town", 0.1), ("0002", "misinformation", "mafia", 0.25),
                                           ("0003", "misinformation", None, None)]:
        game_dir = root / game_id
        game_dir.mkdir(parents=True)
        (game_dir / "config.json").write_text(json.dumps({"players": [], **({"variant": variant} if variant else {})}))
        if cost:  # two calls of half the cost each, plus a mock call without usage
            lines = [{"usage": {"cost": cost / 2}}, {"usage": {"cost": cost / 2}}, {"usage": None}]
            (game_dir / "Ari_reasoning.jsonl").write_text("".join(json.dumps(line) + "\n" for line in lines))
        index.append({"id": game_id, "started": 1000 + int(game_id), "models": ["openai/gpt-5-mini"], "winner": winner})
    (root / "index.json").write_text(json.dumps(index))
    return index


def check_data(index):
    check(ids("/mafia/games/index.json") == ["0001"], "/mafia/games/index.json lists only the game without a variant")
    check(ids("/misinformation/games/index.json") == ["0002", "0003"],
          "/misinformation/games/index.json lists only the misinformation games")
    for path in ["/mafia/games/./index.json", "/mafia/games//index.json", "/mafia/games/index%2ejson",
                 "/mafia/games/0001/../index.json"]:
        check(ids(path) == ["0001"], f"{path} is the filtered index too")
    games = get("/api/games")
    check(list(games) == ["mafia", "misinformation", "senate", "poker"], "/api/games has the four games")
    check(all(games[game].get(key) for game in games for key in ("title", "description")), "every game has a title and a description")
    mafia, misinformation = games["mafia"], games["misinformation"]
    check((mafia["runs"], mafia["live"], mafia["wins"]) == (1, 0, {"town": 1, "mafia": 0}), "Mafia runs, live and wins")
    check((misinformation["runs"], misinformation["live"], misinformation["wins"]) == (2, 1, {"town": 0, "mafia": 1}),
          "Misinformation runs, live and wins")
    check(abs(mafia["avg_cost"] - 0.1) < 1e-9 and abs(misinformation["avg_cost"] - 0.25) < 1e-9,
          "avg_cost sums usage.cost per finished run (the live run doesn't count)")
    check([run["id"] for run in misinformation["list"]] == ["0003", "0002"], "the run list is newest first")
    check(games["senate"]["sides"] == ["loyalists", "conspiracy"] and games["poker"]["avg_cost"] is None,
          "Senate sides; no avg_cost without paid runs")
    check(mafia.get("default_moderator") and "default_moderator" not in games["senate"],
          "Mafia names its default moderator (the dashboard's paid-run list needs it)")
    # an id reused: the newest game deleted, the next one (plain Mafia) gets its id
    root = Path(os.environ["LLMAFIA_GAMES_DIR"])
    shutil.rmtree(root / "0003")
    (root / "0003").mkdir()
    (root / "0003" / "config.json").write_text(json.dumps({"players": []}))
    time.sleep(0.05)  # a new mtime for the index
    (root / "index.json").write_text(json.dumps(index[:2] + [{**index[2], "winner": "town"}]))
    check(ids("/mafia/games/index.json") == ["0001", "0003"] and ids("/misinformation/games/index.json") == ["0002"],
          "a reused id follows its new config.json")

    tables = [entry["path"] for entry in get("/api/tables?game=mafia")]
    check("mock_6p.json" in tables and "claude_vs_gpt_misinfo_6p.json" not in tables and "models.json" not in tables,
          "/api/tables?game=mafia: Mafia's own tables without a variant")
    check(all(entry["table"].get("variant") == "misinformation" for entry in get("/api/tables?game=misinformation")),
          "/api/tables?game=misinformation: only misinformation tables")
    check(any(entry["path"] == TABLES["poker"] for entry in get("/api/tables?game=poker")), "/api/tables?game=poker")
    check(request("GET", "/api/tables?game=nope")[0] == 400, "/api/tables refuses an unknown game")
    check(any(model["id"] == "mock" for model in get("/api/models")), "/api/models offers mock")
    budget = get("/api/budget")
    check("not set" in budget.get("error", "") and "workspace" in budget.get("note", ""),
          "/api/budget without a key: a clear message, and the workspace budget note")


def check_guards():
    for method, path in [("GET", "/mafia/games/index.json"), ("GET", "/mafia/games/0001/config.json"),
                         ("GET", "/api/launches"), ("GET", "/api/budget"), ("GET", "/"), ("HEAD", "/")]:
        status, _, headers = request(method, path, headers={"Host": f"evil.example:{PORT}"})
        check(status == 403 and no_cors(headers), f"{method} {path} for Host evil.example is refused (403, DNS rebinding)")
    status, _, headers = request("OPTIONS", "/api/launch", headers={
        "Origin": "http://evil.example", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-arena"})
    check(status >= 400 and no_cors(headers), f"the CORS preflight (OPTIONS) is not approved ({status}, no Access-Control-*)")

    body = {"game": "poker", "table": table_of("poker"), "games": 1, "parallel": 1}
    origin = f"http://127.0.0.1:{PORT}"
    for what, headers in [("without X-Arena", {"X-Arena": None}), ("with X-Arena: 0", {"X-Arena": "0"}),
                          ("as text/plain", {"Content-Type": "text/plain"}),
                          ("as a form", {"Content-Type": "application/x-www-form-urlencoded"}),
                          ("without Origin", {"Origin": None}), ("from another Origin", {"Origin": "http://evil.example"}),
                          ("from https on this host", {"Origin": "https://" + origin[7:]}),
                          ("through DNS rebinding", {"Host": f"evil.example:{PORT}", "Origin": f"http://evil.example:{PORT}"})]:
        status, content, response_headers = post("/api/launch", body, **headers)
        check(status == 403 and "error" in content and no_cors(response_headers),
              f"a POST {what} is refused (403, no CORS header)")
    check(get("/api/launches") == [], "nothing was launched by the refused POSTs")
    check(post("/api/stop", {"pid": os.getpid()})[0] == 404, "/api/stop refuses a pid the server did not start")
    check(post("/api/stop", {"pid": str(os.getpid())})[0] == 404, "/api/stop refuses a pid that is not a number")
    for what, bad in [("games 0", {**body, "games": 0}), ("games 51", {**body, "games": 51}),
                      ("parallel 9", {**body, "parallel": 9}), ("games true", {**body, "games": True}),
                      ("an unknown game", {**body, "game": "chess"}), ("a game that is a list", {**body, "game": []}),
                      ("a game that is an object", {**body, "game": {}}), ("a table that is a string", {**body, "table": "x"})]:
        check(post("/api/launch", bad)[0] == 400, f"/api/launch refuses {what} (400)")
    check(post("/api/launch", b"[1]")[0] == 400, "/api/launch refuses a body that is not an object")
    # a key the engines set from "model" would override it: a "mock" seat could call a paid model
    for game in ("mafia", "misinformation", "senate", "poker"):
        table = table_of(game)
        for i, key in enumerate(RESERVED_KEYS):
            value = {"model_name": "openai/gpt-5", "use_openrouter": True, "use_mock": False}[key]
            bad = {**table, "llm_defaults": {**table.get("llm_defaults", {}), key: value}} if i % 2 == 0 else \
                {**table, "players": [{**table["players"][0], key: value}, *table["players"][1:]]}
            status, content = launch(game, bad)
            where = "llm_defaults" if i % 2 == 0 else "a seat"
            check(status == 400 and key in content.get("error", ""), f"{game}: \"{key}\" in {where} is refused (400)")
    check(get("/api/launches") == [], "nothing was launched by the refused tables")


def check_launches():
    mafia_root = Path(os.environ["LLMAFIA_GAMES_DIR"])
    arena_pids = {}
    for game in ("senate", "poker"):
        table = table_of(game)
        status, content = launch(game, {**table, "players": table["players"][:1]})
        check(status == 400 and "player" in content.get("error", ""), f"{game}: a table with 1 player is refused (400)")
        status, content = launch(game, table, games=1, parallel=2)
        if check(status == 200, f"{game}: mock run launched ({content})"):
            arena_pids[game] = content["pid"]
            check((CONFIG_DIR / game / "dashboard" / Path(content["table"]).name).exists(),
                  f"{game}: the table is saved in configurations/{game}/dashboard/")

    mafia_table, misinformation_table = table_of("mafia"), table_of("misinformation")
    check(launch("mafia", misinformation_table)[0] == 400, "mafia: a table with the misinformation variant is refused")
    check(launch("misinformation", mafia_table)[0] == 400, "misinformation: a table without the variant is refused")
    check(launch("mafia", {**mafia_table, "players": mafia_table["players"][:2]})[0] == 400,
          "mafia: run_autonomous.validate_table refuses 2 players")
    for game, expected_id, other in [("mafia", "0004", "misinformation"), ("misinformation", "0005", "mafia")]:
        status, content = launch(game, table_of(game))
        if not check(status == 200, f"{game}: mock run launched ({content})"):
            continue
        pid = content["pid"]
        check(launch(other, table_of(other))[0] == 409, f"{other}: refused (409) while the {game} launcher runs on the shared data dir")
        check(launch(game, table_of(game))[0] == 409, f"{game}: a second launcher is refused (409)")
        events = mafia_root / expected_id / "events.jsonl"
        wait_until(lambda: events.read_text().strip(), MAFIA_EVENTS_SECONDS, f"{game}: game {expected_id} writes events")
        check(expected_id in ids(f"/{game}/games/index.json") and expected_id not in ids(f"/{other}/games/index.json"),
              f"{game}: game {expected_id} is in its own filtered index only")
        check(get(f"/{game}/games/{expected_id}/config.json").get("players"), f"{game}: its config.json is served")
        check(post("/api/stop", {"pid": pid})[0] == 200, f"{game}: Stop accepted")
        wait_until(lambda: not launcher(pid)["running"], STOP_SECONDS, f"{game}: the launcher exits after Stop")
        check(post("/api/stop", {"pid": pid})[0] == 409, f"{game}: a second Stop is refused (409)")
        check(launcher(pid)["exit_code"] == 1, f"{game}: its exit code is 1 (stopped)")
        run = next(run for run in get("/api/games")[game]["list"] if run["id"] == expected_id)
        check(run["winner"] == "aborted", f"{game}: game {expected_id} is marked aborted")
        check(any("ABORTED" in line for line in launcher(pid)["log"]), f"{game}: the launcher's log says so")
    check(get("/api/games")["mafia"]["live"] == 0, "no Mafia game is left live")

    for game, pid in arena_pids.items():
        wait_until(lambda: not launcher(pid)["running"], ARENA_FINISH_SECONDS, f"{game}: the launcher finishes")
        entry = launcher(pid)
        check(entry["exit_code"] == 0, f"{game}: exit code 0 (log: {entry['log'][-3:]})")
        summary = get("/api/games")[game]
        winners = [run["winner"] for run in summary["list"]]
        check(summary["runs"] >= 1 and summary["live"] == 0 and None not in winners and "aborted" not in winners,
              f"{game}: every run finished with a winner in /api/games ({winners})")
        check(sum(summary["wins"].values()) == len(winners), f"{game}: wins add up ({summary['wins']})")
        game_id = summary["list"][0]["id"]
        last = get(f"/{game}/games/{game_id}/events.jsonl").strip().splitlines()[-1]
        check(json.loads(last)["type"] == "game_over", f"{game}: /{game}/games/{game_id}/events.jsonl ends in game_over")

    quick = {**table_of("poker"), "hands": 1, "duplicate": False, "llm_defaults": {"mock_latency_seconds": 0}}
    # A launcher whose record can't be written would escape the 409 rule and Stop: a directory in
    # the way of the record's temporary file makes the write fail.
    blocked = [Path(os.environ["ARENA_LAUNCHES_DIR"]) / f"{stamp}{suffix}_poker.tmp"
               for stamp in next_stamps() for suffix in ("", "-2", "-3")]
    for folder in blocked:
        folder.mkdir()
    status, content = launch("poker", quick)
    pid = content.get("pid")
    check(status == 500 and pid and not Path(f"/proc/{pid}").exists(),
          f"a launch that can't be recorded is refused (500) and its launcher killed ({content.get('error')})")
    check(all(entry["pid"] != pid for entry in get("/api/launches")), "  and it is not listed")
    for folder in blocked:
        folder.rmdir()

    # The next launches' second already has a saved table (and so do the 9 after it): each gets its own name.
    blockers = [CONFIG_DIR / "poker" / "dashboard" / f"{stamp}.json" for stamp in next_stamps()]
    for blocker in blockers:
        blocker.write_text('"not this launch\'s"')
    CREATED.extend(blockers)
    names = []
    for _ in range(2):
        status, content = launch("poker", quick)
        if check(status == 200, "poker: a quick mock run launched"):
            names.append((content["table"], content["log"]))
            wait_until(lambda: not launcher(content["pid"])["running"], ARENA_FINISH_SECONDS, "  and finished")
    check(len(set(names)) == 2 and all("-2" in table or "-3" in table for table, _ in names),
          f"launches in a second that already has a table get their own table and log ({names})")
    check(all(blocker.read_text() == '"not this launch\'s"' for blocker in blockers), "no saved table was overwritten")


def check_restart(server_log):
    status, content = launch("mafia", table_of("mafia"))
    if not check(status == 200, "restart: a mock Mafia launch"):
        return
    pid = content["pid"]
    events = Path(os.environ["LLMAFIA_GAMES_DIR"]) / "0006" / "events.jsonl"
    wait_until(lambda: events.read_text().strip(), MAFIA_EVENTS_SECONDS, "restart: game 0006 writes events")
    SERVER.terminate()
    SERVER.wait()
    check(Path(f"/proc/{pid}").exists(), "restart: the launcher outlives the server")
    if not start_server(server_log):
        return
    entry = launcher(pid)
    check(entry["running"] and entry["game"] == "mafia" and entry["log"], "restart: the launcher is still listed, running, with its log")
    check(launch("misinformation", table_of("misinformation"))[0] == 409,
          "restart: a second launcher on its data dir is still refused (409)")
    check(post("/api/stop", {"pid": pid})[0] == 200, "restart: Stop accepted")
    wait_until(lambda: not launcher(pid)["running"], STOP_SECONDS, "restart: the launcher exits after Stop")
    check(launcher(pid)["exit_code"] == "unknown", "restart: its exit code is \"unknown\" (another server started it)")
    check(any("ABORTED" in line for line in launcher(pid)["log"]), "restart: its log says the game was aborted")
    run = next(run for run in get("/api/games")["mafia"]["list"] if run["id"] == "0006")
    check(run["winner"] == "aborted", "restart: game 0006 is marked aborted")


def check_pages():
    for path in ["/", "/dashboard/dashboard.js", "/mafia/", "/misinformation/", "/misinformation/index.html",
                 "/senate/", "/poker/", "/common/replay.js", "/common/arena.css", "/mafia/main.js"]:
        status, content, _ = request("GET", path)
        check(status == 200 and "Directory listing" not in str(content), f"GET {path}")  # a page, not a listing
    mafia_page = get("/mafia/")
    check(get("/misinformation/") == mafia_page == get("/misinformation/index.html"),
          "/misinformation/ is the Mafia page (it themes itself by its URL)")
    check('src="/mafia/main.js"' in mafia_page and 'href="/mafia/style.css"' in mafia_page,
          "the Mafia page loads its own files by absolute path")
    status, _, headers = request("GET", "/misinformation?game=0002")
    check(status == 301 and headers["Location"] == "/misinformation/?game=0002", "/misinformation redirects to /misinformation/")
    check(not (BACKEND_DIR.parent / "frontend" / "misinformation").exists(), "no copied misinformation page")
    for path in ["/../backend/server.py", "/misinformation/../../backend/server.py", "/mafia/..%2f..%2fbackend/server.py"]:
        check(request("GET", path)[0] == 404, f"GET {path} can't leave frontend/ (backend/server.py exists)")
    # Files that do exist one level above every data dir: the server's log, and one planted here.
    # A data route must not reach them, however ".." is spelled.
    temporary_dir = Path(os.environ["LLMAFIA_GAMES_DIR"]).parent
    (temporary_dir / "planted.txt").write_text("outside every data dir")
    spellings = ["../{f}", "..%2f{f}", "%2e%2e/{f}", "%2e%2e%2f{f}", "%2E%2E%2F{f}", ".//..//{f}", "0001/../../{f}"]
    for game in ("mafia", "misinformation", "senate", "poker"):
        data_route = f"/{game}/games/"
        check(request("GET", data_route + "0001/config.json")[0] == 200, f"{data_route}0001/config.json is served")
        leaks = [data_route + spelling.format(f=name) for name in ("server.log", "planted.txt") for spelling in spellings
                 if request("GET", data_route + spelling.format(f=name))[0] != 404]
        check(not leaks, f"{data_route}: {2 * len(spellings)} spellings of ../server.log and ../planted.txt all 404 {leaks}")


def check_stop_race():
    """Stop on a launcher from before a restart that ends between Stop's check and its signal.
    The race can't be timed over HTTP, so this calls stop() in this process."""
    import server  # its environment already points at the temporary dirs
    pid = int(Path("/proc/sys/kernel/pid_max").read_text()) + 1  # no process can have it
    record = server.LAUNCHES_DIR / "race_mafia.json"
    server.write_json(record, {"pid": pid, "game": "mafia", "dir": "-", "log": "-", "started": 0, "argv": ["-"]})
    server.runs_argv = lambda record: True  # as if it still ran when Stop looked
    status, content = server.stop({"pid": pid})
    record.unlink()
    check(status == 409 and "finished" in content["error"],
          "Stop on a launcher that ends just before its signal: 409 (ProcessLookupError caught)")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    global PORT
    temporary_dir = Path(tempfile.mkdtemp(prefix="arena_server_check_"))
    for name in ("LLMAFIA_GAMES", "SENATE_GAMES", "POKER_GAMES", "ARENA_LAUNCHES"):
        os.environ[f"{name}_DIR"] = str(temporary_dir / name.lower())
    for key in ("OPENROUTER_API_KEY", "DEEPGRAM_API_KEY"):
        os.environ.pop(key, None)
    os.environ["OPENROUTER_BASE_URL"] = "http://127.0.0.1:9"  # nothing listens: no call can leave
    index = seed_mafia(Path(os.environ["LLMAFIA_GAMES_DIR"]))
    PORT = free_port()
    server_log = open(temporary_dir / "server.log", "w")
    print(f"Server on port {PORT}, data in {temporary_dir}", flush=True)
    try:
        if start_server(server_log):
            check_data(index)
            check_guards()
            check_launches()
            check_restart(server_log)
            check_pages()
            check_stop_race()
    finally:
        try:
            for entry in get("/api/launches"):
                if entry["running"]:
                    post("/api/stop", {"pid": entry["pid"]})
                    print(f"stopped the launcher {entry['pid']} that was left running", flush=True)
            deadline = time.time() + STOP_SECONDS
            while time.time() < deadline and any(entry["running"] for entry in get("/api/launches")):
                time.sleep(1)
        except OSError:
            pass
        SERVER.terminate()
        SERVER.wait()
        for path in CREATED:
            path.unlink(missing_ok=True)
            for folder in (path.parent, path.parent.parent):  # dashboard/ and configurations/<game>/
                if folder != CONFIG_DIR and folder.is_dir() and not any(folder.iterdir()):
                    folder.rmdir()
    if FAILURES:
        sys.exit(f"\n{len(FAILURES)} check(s) failed (the server's log and data: {temporary_dir})")
    shutil.rmtree(temporary_dir)
    print("\nAll server checks passed")


if __name__ == "__main__":
    main()
