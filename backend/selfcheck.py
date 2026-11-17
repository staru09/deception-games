"""
Checks the autonomous game end to end without calling any model.

    python selfcheck.py [--games 2]

1. Vote parsing and table validation.
2. The OpenRouter client, against a fake server on localhost.
3. A night resolved by the game manager: a doctor save, then a kill.
4. Whole games with mock players (--games per table), replayed from events.jsonl and
   checked against the rules.

Everything is written to a temporary directory.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# all of this must be in place before the game modules are imported
TEMPORARY_DIR = Path(tempfile.mkdtemp(prefix="llmafia_selfcheck_"))
os.environ["LLMAFIA_GAMES_DIR"] = str(TEMPORARY_DIR / "games")
FAKE_SERVER = HTTPServer(("127.0.0.1", 0), None)
os.environ["OPENROUTER_BASE_URL"] = f"http://127.0.0.1:{FAKE_SERVER.server_port}"
os.environ["OPENROUTER_API_KEY"] = "selfcheck-not-a-real-key"
os.environ["DEEPGRAM_SPEAK_URL"] = f"http://127.0.0.1:{FAKE_SERVER.server_port}/v2/speak"
os.environ["DEEPGRAM_API_KEY"] = "selfcheck-not-a-real-key"
os.chdir(Path(__file__).resolve().parent)

import llm_interface
import mafia_main
import moderator
import run_autonomous
from game_constants import *
from llm_players import openrouter_llm
from llm_players.logger import Logger
from prepare_game import init_game

FAST = {"mock_latency_seconds": 0.05, "vote_delay_seconds": 0.2, "opening_jitter_seconds": 1,
        "num_words_per_second_to_wait": 0}


def table(*roles):
    return {"daytime_minutes": 0.1, "nighttime_minutes": 0.07, "shuffle_roles": True,
            "night_pacing": False,  # the pauses are for spectators and would only slow the checks
            "llm_defaults": FAST, "players": [{"role": role, "model": "mock"} for role in roles]}


SIX_SEATS = table("mafia", "detective", "doctor", "villager", "villager", "villager")
SEVEN_SEATS = table("mafia", "mafia", "detective", "doctor", "villager", "villager", "villager")


def read_events(game_dir):
    return [json.loads(line) for line in (game_dir / EVENTS_FILE).read_text().splitlines()]


# ---------------------------------------------------------------- 1. parsing and validation

def check_vote_parsing():
    pick = llm_interface.pick_voted_name
    assert pick("Ariel", ["Ari", "Ariel"]) == "Ariel"
    assert pick("I vote for Ari.", ["Ariel", "Ari"]) == "Ari"
    assert pick("Morgan, because Riley defended them", ["Riley", "Morgan"]) == "Morgan"
    assert pick("**Riley**", ["Riley", "Morgan"]) == "Riley"
    assert pick("nobody", ["Riley", "Morgan"]) is None
    assert pick("", ["Riley"]) is None


def check_table_validation():
    run_autonomous.validate_table(SIX_SEATS)
    run_autonomous.validate_table(table("mafia", "detective", "doctor", "villager"))
    bad_tables = [table("mafia", "villager", "villager"),  # too few players
                  table("mafia", "doctor", "doctor", "villager", "villager"),
                  table("mafia", "detective", "detective", "villager", "villager"),
                  table("villager", "villager", "villager", "doctor"),  # no mafia
                  table("mafia", "mafia", "villager", "doctor"),  # mafia isn't a minority
                  table("mafia", "sheriff", "villager", "villager"),
                  {**SIX_SEATS, "players": [{**seat, "model": "<openrouter-model-id>"}
                                            for seat in SIX_SEATS["players"]]}]
    for bad_table in bad_tables:
        try:
            run_autonomous.validate_table(bad_table)
        except SystemExit:
            continue
        raise AssertionError(f"accepted an invalid table: {bad_table['players']}")


# ---------------------------------------------------------------- 2. the OpenRouter client

class FakeOpenRouter(BaseHTTPRequestHandler):
    replies = []  # (status, body) per expected request, in order
    requests = []  # what actually arrived

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeOpenRouter.requests.append((self.path, dict(self.headers), body))
        status, reply = FakeOpenRouter.replies.pop(0)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(reply).encode())

    def log_message(self, *args):
        pass


def answer(content, reasoning=None, finish_reason="stop"):
    return 200, {"choices": [{"message": {"content": content, "reasoning": reasoning},
                              "finish_reason": finish_reason}],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 2, "cost": 0.0001}}


def expect_error(function, *args):
    try:
        function(*args)
    except RuntimeError:
        return
    raise AssertionError(f"{function} should have raised a RuntimeError")


def check_openrouter_client():
    assert openrouter_llm.BASE_URL.startswith("http://127.0.0.1:"), "would call the real API!"
    FAKE_SERVER.RequestHandlerClass = FakeOpenRouter
    threading.Thread(target=FAKE_SERVER.serve_forever, daemon=True).start()
    openrouter_llm.time = types.SimpleNamespace(sleep=lambda seconds: None)  # no retry waits
    log_dir = TEMPORARY_DIR / "client"
    log_dir.mkdir()
    replies, requests = FakeOpenRouter.replies, FakeOpenRouter.requests

    def client(name, **llm_config):
        return openrouter_llm.OpenRouterLLM(Logger(name, log_dir), model_name="some/model",
                                            **llm_config)

    def traces(name):
        return [json.loads(line) for line in
                (log_dir / REASONING_FILE_FORMAT.format(name)).read_text().splitlines()]

    # a plain seat: the request is well formed, a tiny output limit is raised to the minimum
    plain = client("plain", temperature=0.7)
    replies[:] = [answer("<send>", reasoning="they suspect me")]
    assert plain.generate("prompt", "system", {"max_tokens": 6}, kind="schedule") == "<send>"
    path, headers, body = requests[-1]
    assert path == "/chat/completions" and headers["Authorization"] == "Bearer selfcheck-not-a-real-key"
    assert body["model"] == "some/model" and body["temperature"] == 0.7
    assert body["max_tokens"] == openrouter_llm.MIN_MAX_TOKENS and "reasoning" not in body
    assert body["messages"] == [{"role": "system", "content": "system"},
                                {"role": "user", "content": "prompt"}]
    trace = traces("plain")[-1]
    assert (trace["kind"], trace["output"], trace["reasoning"]) == ("schedule", "<send>", "they suspect me")
    assert trace["usage"]["cost"] == 0.0001
    # no output limit unless something asks for one; a multi-line answer becomes one line
    replies[:] = [answer("  i think\nits riley ")]
    assert plain.generate("prompt", "system") == "i think its riley"
    assert "max_tokens" not in requests[-1][2]
    # a failing server is retried, and an error inside a 200 response too
    replies[:] = [(500, {"error": "boom"}), (200, {"error": {"message": "provider down"}}), answer("ok")]
    assert plain.generate("prompt") == "ok" and not replies
    # inline reasoning never reaches the chat, but is kept as the trace
    replies[:] = [answer("<think>i am mafia, blame riley</think>riley is sus")]
    assert plain.generate("prompt", kind="message") == "riley is sus"
    assert traces("plain")[-1]["reasoning"] == "i am mafia, blame riley"
    # a model that reasons by default: empty at the limit, so the seat loses its limit for good
    hidden_reasoner = client("hidden")
    replies[:] = [answer("", finish_reason="length"), answer("<wait>"), answer("<wait>")]
    assert hidden_reasoner.generate("prompt", "", {"max_tokens": 6}) == "<wait>"
    assert "max_tokens" in requests[-2][2] and "max_tokens" not in requests[-1][2]
    assert hidden_reasoner.generate("prompt", "", {"max_tokens": 6}) == "<wait>"
    assert "max_tokens" not in requests[-1][2]
    # a seat configured to reason: the option is sent, an output limit never is
    reasoner = client("reasoner", reasoning={"effort": "low"}, max_tokens=50)
    replies[:] = [answer("Riley", reasoning="riley pushed the vote")]
    assert reasoner.generate("prompt", "", {"max_tokens": 6}, kind="vote") == "Riley"
    assert requests[-1][2]["reasoning"] == {"effort": "low"} and "max_tokens" not in requests[-1][2]
    # a wrong model id or key stops the process at once
    replies[:] = [(404, {"error": {"message": "no such model"}})]
    expect_error(plain.generate, "prompt")
    # a request the provider keeps rejecting: "" (wait / random vote), then stop for good
    failing = client("failing")
    replies[:] = [(400, {"error": "bad request"})] * openrouter_llm.MAX_CONSECUTIVE_FAILURES
    for _ in range(openrouter_llm.MAX_CONSECUTIVE_FAILURES - 1):
        assert failing.generate("prompt") == ""
    expect_error(failing.generate, "prompt")
    assert not replies
    # the moderator: one request with the public facts and chat, a fixed line when it fails
    narrator = moderator.Moderator("some/narrator", log_dir)
    (log_dir / PUBLIC_DAYTIME_CHAT_FILE).write_text("[10:00:00] Riley: i trust no one\n")
    facts = {"round": 2, "alive": "Riley, Sage", "out_so_far": "nobody"}
    replies[:] = [answer("  The sun rises\non Day 2. ")]
    assert narrator.narrate("day_start", **facts) == ("The sun rises on Day 2.", None)
    body = requests[-1][2]
    assert body["model"] == "some/narrator" and "alive: Riley, Sage" in body["messages"][1]["content"]
    assert "Riley: i trust no one" in body["messages"][1]["content"]
    assert body["messages"][1]["content"].endswith(moderator.TASKS["day_start"])
    replies[:] = [answer("Welcome, and the town")]
    narrator.narrate("first_night", **{**facts, "round": 1})
    assert requests[-1][2]["messages"][1]["content"].endswith(moderator.TASKS["first_night"])
    replies[:] = [answer("Dawn breaks and the town must weigh", finish_reason="length")]
    assert narrator.narrate("day_start", **facts)[0] == moderator.FALLBACK_LINES["day_start"].format(**facts)
    # a result comes from its own facts only: no chat, which ends with an older vote
    replies[:] = [answer("Sage was killed in the night.")]
    narrator.narrate("eliminated", **facts, name="Sage", role="villager",
                     how="killed by the mafia during the night")
    prompt = requests[-1][2]["messages"][1]["content"]
    assert "Riley: i trust no one" not in prompt
    assert ("Sage is out of the game, killed by the mafia during the night. "
            "Their role was villager.") in prompt
    replies[:] = [(500, {"error": "boom"})]
    assert narrator.narrate("saved", **facts)[0] == moderator.FALLBACK_LINES["saved"] and not replies
    num_requests = len(requests)
    mock_line = moderator.Moderator("mock", log_dir).narrate("vote_open", **facts)
    assert mock_line == (moderator.FALLBACK_LINES["vote_open"], None) and len(requests) == num_requests
    # the voice: each line becomes an mp3 in narration/, a failed call only means no audio
    speaker = moderator.Moderator("some/narrator", log_dir, voice="flux-hannah-en")
    replies[:] = [answer("Night falls."), (200, "fake mp3 bytes")]
    assert speaker.narrate("night_start", **facts) == ("Night falls.", "narration/001.mp3")
    path, headers, body = requests[-1]
    assert path == "/v2/speak?model=flux-hannah-en&encoding=mp3&bit_rate=48000"
    assert body == {"text": "Night falls."}
    (log_dir / "narration" / "length.mp3").write_bytes(bytes(9000))  # 9000 bytes at 48 kbps
    assert moderator.clip_seconds(log_dir, "narration/length.mp3") == 1.5
    assert headers["Authorization"] == "Token selfcheck-not-a-real-key"
    assert (log_dir / "narration" / "001.mp3").read_bytes() == b'"fake mp3 bytes"'
    replies[:] = [answer("Dawn."), (500, {"err_code": "boom"})]
    assert speaker.narrate("day_start", **facts) == ("Dawn.", None) and not replies
    FAKE_SERVER.shutdown()


# ---------------------------------------------------------------- 3. one night, by hand

def check_night_resolution():
    game_id = "night"
    config = run_autonomous.build_game_config({**SIX_SEATS, "shuffle_roles": False}, "selfcheck")
    init_game(game_id, config)
    mafia_main.game_dir = game_dir = Path(DIRS_PREFIX) / game_id
    players = mafia_main.get_players(config)
    by_role = {}
    for player in players:
        by_role.setdefault(player.role, []).append(player)
    mafia, detective, doctor = by_role["mafia"][0], by_role["detective"][0], by_role["doctor"][0]
    victim, other = by_role["villager"][:2]

    def play_night(round_number, mafia_vote, detective_vote, doctor_vote):
        for player, vote in ((mafia, mafia_vote), (detective, detective_vote), (doctor, doctor_vote)):
            with open(player.personal_vote_file, "a") as f:
                f.write(vote.name + "\n")
        mafia_main.voting_sub_phase(NIGHTTIME, [mafia], [p for p in players if not p.is_mafia],
                                    game_dir / PUBLIC_NIGHTTIME_CHAT_FILE, players, round_number)
        return read_events(game_dir)

    # night 1: the doctor protects the mafia's target, the detective finds the mafia
    events = play_night(1, victim, mafia, victim)
    # asked in this order: the mafia, then the doctor, then the detective
    assert [event["type"] for event in events] == ["vote_open", "vote", "protect", "investigate", "saved"]
    assert events[3]["is_mafia"] is True and events[4]["name"] == victim.name
    assert victim in players and len(players) == 6
    assert NOBODY_ELIMINATED_MESSAGE in (game_dir / PUBLIC_MANAGER_CHAT_FILE).read_text()
    assert f"{mafia.name} is MAFIA" in detective.private_notes_file.read_text()
    assert f"you protected {victim.name}" in doctor.private_notes_file.read_text()
    # night 2: the doctor protects someone else, so the target dies
    events = play_night(2, victim, other, other)[5:]
    assert [event["type"] for event in events] == ["vote_open", "vote", "protect", "investigate", "eliminated"]
    assert events[3]["is_mafia"] is False
    assert events[4] == {**events[4], "name": victim.name, "role": "villager", "cause": "night"}
    assert victim not in players and len(players) == 5
    assert victim.name not in (game_dir / REMAINING_PLAYERS_FILE).read_text().splitlines()
    assert VOTED_OUT in victim.personal_status_file.read_text()
    # nothing about the night roles may reach a file that other players read
    public_text = "".join((game_dir / file_name).read_text() for file_name in
                          (PUBLIC_MANAGER_CHAT_FILE, PUBLIC_DAYTIME_CHAT_FILE, PUBLIC_NIGHTTIME_CHAT_FILE))
    for night_role_player in (detective, doctor):
        assert not re.search(rf"\b{night_role_player.name}\b", public_text)
    assert "investigat" not in public_text and "protect" not in public_text


# ---------------------------------------------------------------- 4. whole games

def check_game(game_dir):
    """Replays the event log of a finished game and checks every event against the rules."""
    config = json.loads((game_dir / GAME_CONFIG_FILE).read_text())
    roles = {player["name"]: get_role_string(player["is_mafia"], player["special_role"])
             for player in config[PLAYERS_KEY_IN_CONFIG]}
    events = read_events(game_dir)
    first_phase = "night" if config.get(NIGHT_FIRST_KEY) else "day"
    assert events[0] == {**events[0], "type": "phase", "phase": first_phase, "round": 1}, events[0]
    assert events[-1]["type"] == "game_over" and events.count(events[-1]) == 1
    alive = set(roles)
    is_mafia = lambda name: roles[name] == MAFIA_ROLE
    phase = protected = last_protected = None
    round_number = 0
    seen = set()
    # with a moderator, each night choice comes right after the question for it
    asked_before = {"protect": "ask_doctor", "investigate": "ask_detective"}
    previous = {}
    for event in events:
        kind = event["type"]
        seen.add(kind)
        if kind in asked_before and config.get(MODERATOR_MODEL_KEY):
            assert previous.get("moment") == asked_before[kind], f"not asked first: {event}"
        previous = event
        if kind == "phase":
            assert event["phase"] == ({"day": "night", "night": "day"}.get(phase, first_phase)), event
            round_number += event["phase"] == first_phase
            assert event["round"] == round_number, event
            if event["phase"] == "night":
                last_protected, protected = protected, None
                assert (event["duration"] > 0) == (sum(map(is_mafia, alive)) > 1), event
            phase = event["phase"]
        elif kind == "message":
            assert event["name"] in alive and event["phase"] == phase and event["text"], event
            assert phase == "day" or is_mafia(event["name"]), f"town spoke at night: {event}"
            seen.add(f"{phase} message")
        elif kind == "vote":
            assert {event["voter"], event["target"]} <= alive and event["phase"] == phase, event
            if phase == "night":
                assert is_mafia(event["voter"]) and not is_mafia(event["target"]), event
            else:
                assert event["voter"] != event["target"], event
        elif kind == "investigate":
            assert phase == "night" and roles[event["detective"]] == DETECTIVE_ROLE, event
            assert event["target"] in alive - {event["detective"]}, event
            assert event["is_mafia"] == is_mafia(event["target"]), event
        elif kind == "protect":
            assert phase == "night" and roles[event["doctor"]] == DOCTOR_ROLE, event
            assert event["target"] in alive, event
            assert event["target"] != last_protected, f"same player protected twice in a row: {event}"
            protected = event["target"]
        elif kind == "saved":
            assert phase == "night" and event["name"] == protected and event["name"] in alive, event
        elif kind == "eliminated":
            assert event["name"] in alive and event["role"] == roles[event["name"]], event
            assert event["cause"] == ("night" if phase == "night" else "vote"), event
            if phase == "night":
                assert event["name"] != protected and not is_mafia(event["name"]), event
                seen.add("night kill")
            alive.remove(event["name"])
        elif kind == "narration":
            assert event["text"] and event["moment"], event
            if event["moment"] != "game_over":  # until the end, it may not name a living mafia
                hidden = [name for name in alive if is_mafia(name)]
                assert not any(re.search(rf"\b{name}\b", event["text"]) for name in hidden), event
        elif kind == "game_over":
            num_mafia = sum(map(is_mafia, alive))
            expected = "town" if num_mafia == 0 else "mafia"
            assert num_mafia == 0 or num_mafia >= len(alive) - num_mafia, f"game ended early: {alive}"
            assert event["winner"] == expected, event
            assert (MAFIA_WINS_MESSAGE in (game_dir / WHO_WINS_FILE).read_text()) == (expected == "mafia")
    assert set((game_dir / REMAINING_PLAYERS_FILE).read_text().splitlines()) == alive
    assert ("narration" in seen) == bool(config.get(MODERATOR_MODEL_KEY)), "moderator mismatch"
    # the chat files that players read hold exactly the messages of the log, and no night secrets
    for file_name, phase in ((PUBLIC_DAYTIME_CHAT_FILE, "day"), (PUBLIC_NIGHTTIME_CHAT_FILE, "night")):
        chat = [line for line in (game_dir / file_name).read_text().splitlines()
                if f"] {GAME_MANAGER_NAME}: " not in line]
        logged = [e for e in events if e["type"] == "message" and e["phase"] == phase]
        assert len(chat) == len(logged), f"{file_name}: {len(chat)} lines, {len(logged)} events"
    night_chat = (game_dir / PUBLIC_NIGHTTIME_CHAT_FILE).read_text()
    for name, role in roles.items():
        assert role == MAFIA_ROLE or f"{name} voted" not in night_chat, f"{name}'s night choice leaked"
        if role in NIGHT_ROLES:
            notes = (game_dir / PRIVATE_NOTES_FILE_FORMAT.format(name)).read_text().splitlines()
            actions = [e for e in events if name in (e.get("detective"), e.get("doctor"))]
            assert len(notes) == len(actions), f"{name}: {len(notes)} notes, {len(actions)} actions"
        traces = (game_dir / REASONING_FILE_FORMAT.format(name)).read_text().splitlines()
        assert {json.loads(line)["kind"] for line in traces} <= {"schedule", "message", "vote"}
        # a villager killed on the first night never gets to choose anything
        chose = any(name in (e.get("voter"), e.get("detective"), e.get("doctor")) for e in events)
        assert chose == any(json.loads(line)["kind"] == "vote" for line in traces), name
    for console in game_dir.glob("console_*.txt"):
        assert "Traceback" not in console.read_text(), f"error in {console}"
    return seen


def check_whole_games(num_games):
    seen = set()
    for name, mock_table in (("six_seats", SIX_SEATS), ("seven_seats", SEVEN_SEATS)):
        table_path = TEMPORARY_DIR / f"{name}.json"
        table_path.write_text(json.dumps(mock_table))
        subprocess.run([sys.executable, "run_autonomous.py", str(table_path), "--games",
                        str(num_games), "--timeout-minutes", "5"], check=True)
    index = json.loads((Path(DIRS_PREFIX) / GAMES_INDEX_FILE).read_text())
    assert len(index) == 2 * num_games, index
    for game in index:
        assert game["winner"] in ("mafia", "town"), f"game {game['id']}: {game['winner']}"
        seen |= check_game(Path(DIRS_PREFIX) / game["id"])
        assert game["winner"] == read_events(Path(DIRS_PREFIX) / game["id"])[-1]["winner"]
    return seen


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--games", type=int, default=2, help="mock games to play per table")
    args = parser.parse_args()
    for check in (check_vote_parsing, check_table_validation, check_openrouter_client,
                  check_night_resolution):
        check()
        print(f"ok  {check.__name__}", flush=True)
    seen = check_whole_games(args.games)
    print(f"ok  check_whole_games ({2 * args.games} games), seen: {', '.join(sorted(seen))}")
    missing = {"day message", "night message", "investigate", "protect", "saved", "night kill"} - seen
    if missing:  # the mock players move at random, so this is about coverage, not correctness
        print(f"note: never happened in these games: {', '.join(sorted(missing))} (try a higher --games)")
    print(f"All checks passed. Files are in {TEMPORARY_DIR}")


if __name__ == "__main__":
    main()
