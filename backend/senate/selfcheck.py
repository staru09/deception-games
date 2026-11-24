"""
Senate rule checks with mock seats only (no model is called, nothing leaves the machine):

    cd backend && env -u OPENROUTER_API_KEY .venv/bin/python -m senate.selfcheck

Plays games at every size 5-10 through the launcher's own run_one (so config.json and index.json
are written as in a real run) into a temporary directory, then replays every events.jsonl against
the contract's rules, written out again here rather than imported, so a slip in game.py shows up.
Three batches: random mock seats that now and then botch their <say> (NOISE, as real models do),
and two scripted ones (SCRIPTS) that reach the rarest paths whatever the seed: a Reform win, and a
veto that brings chaos. Also checks the prompts (knowledge, rules text, the trimmed record) and that
Stopped inside the parallel vote ends a game. Finally checks that every rare path was reached.
"""
import contextlib
import io
import json
import random
import re
import tempfile
from collections import Counter
from pathlib import Path

from arena import decide
from arena.agent import STOP, Stopped
from arena.events import EventLog
from arena.run import run_one
from senate import game

GAMES_PER_SIZE = 40
SCRIPTED_GAMES_PER_SIZE = 5
SEED = 1
DECK_SIZE = 17
ROLE_COUNTS = {5: (3, 1, 1), 6: (4, 1, 1), 7: (4, 2, 1), 8: (5, 2, 1), 9: (5, 3, 1), 10: (6, 3, 1)}
POWERS = {5: {3: "peek", 4: "execution", 5: "execution"},
          7: {2: "investigate", 3: "special_election", 4: "execution", 5: "execution"},
          9: {1: "investigate", 2: "investigate", 3: "special_election", 4: "execution", 5: "execution"}}
POWERS.update({6: POWERS[5], 8: POWERS[7], 10: POWERS[9]})
FIELDS = {"round": {"n", "consul", "tracker", "draw_pile", "discard_pile"}, "nominate": {"consul", "prefect"},
          "message": {"name", "text", "stage"}, "vote": {"voter", "aye"},
          "vote_result": {"passed", "ayes", "nays", "tracker"}, "draw": {"consul", "laws"},
          "discard": {"by", "law"}, "veto": {"prefect", "consul", "accepted", "tracker"},
          "enact": {"law", "by", "reforms", "decrees", "tracker"}, "reshuffle": {"draw_pile"},
          "power": {"kind", "by", "target"}, "power_result": {"kind", "by", "target", "result"},
          "executed": {"name"}, "game_over": {"winner", "reason", "roles"}}
SPOILERS = {"draw", "discard", "power_result"}
PLAYER_FIELDS = ("consul", "prefect", "name", "voter", "by", "target")  # each must be alive then
MUST_REACH = {"reason:reforms", "reason:decrees", "reason:usurper_executed", "reason:usurper_elected",
              "power:peek", "power:investigate", "power:special_election", "power:execution",
              "veto:accepted", "veto:refused", "veto:chaos", "chaos", "reshuffle", "debate", "report",
              "silent", "say:invalid", "kind:execute"}
DECISION_KINDS = {"nominate", "vote", "discard", "enact", "veto", "veto_reply", "investigate",
                  "special_election", "execute", "debate", "report"}  # the kinds the brief names
NOISE = ["", "PRIVATE reasoning without a tag", "<say></say>", "<say>kept <choice>Aye</choice> words</say>"]
NOISE_RATE = 0.15  # of the random batch's discussion answers
POWER_LABELS = {"peek": "Peek:", "investigate": "Investigate:", "special_election": "Special election:",
                "execution": "Execution:"}
ASK = game.Agent.ask
SCRIPTS = {  # kind -> the option a scripted seat always takes; otherwise it picks at random, never the Usurper
    "reforms": {"vote": "Aye", "discard": "decree", "enact": "reform"},
    "vetoes": {"vote": "Aye", "discard": "reform", "enact": "decree", "veto": "Aye", "veto_reply": "Aye"},
}
SCRIPT_REACHES = {"reforms": "reason:reforms", "vetoes": "veto:chaos"}  # every game, in practice


def table(size):
    loyalists, conspirators, usurpers = ROLE_COUNTS[size]
    roles = ["loyalist"] * loyalists + ["conspirator"] * conspirators + ["usurper"] * usurpers
    return {"players": [{"role": role, "model": "mock"} for role in roles],
            "shuffle_roles": size % 2 == 0, "discussion_rounds": size % 3,  # 0, 1 and 2 all occur
            "llm_defaults": {"mock_latency_seconds": 0}}


def scripted_choose(prefer, roles):
    """Stands in for arena.decide.choose: the scripted option, else a random one that isn't the
    Usurper, so no game ends early by electing or executing it."""
    def choose(agent, system, prompt, options, kind):
        safe = [option for option in options if roles.get(option) != "usurper"] or options
        return (prefer[kind] if prefer.get(kind) in options else random.choice(safe)), ""
    return choose


def noisy_ask(agent, system, prompt, kind, mock):
    """A mock seat that sometimes botches its <say>: none, empty, or with tags inside."""
    if kind in ("debate", "report") and random.random() < NOISE_RATE:
        mock = lambda: random.choice(NOISE)
    return ASK(agent, system, prompt, kind, mock)


def speakers(spoken, alive, turns, all_speak, where):
    """Each living player speaks at most `turns` times (exactly that often when all_speak).
    Returns the number of silent turns."""
    said = Counter(spoken)
    assert set(said) <= set(alive) and all(n <= turns for n in said.values()), f"speakers: {where}"
    assert not all_speak or all(said[p] == turns for p in alive), f"a silent seat: {where}"
    return sum(turns - said[p] for p in alive)


def replay(game_dir, stats, all_speak=False):
    """Replays one game's events against the rules; returns game_over's winner. Works on real-model
    games too: a seat may stay silent, unless all_speak (mock seats always say something)."""
    config = json.loads((game_dir / "config.json").read_text())
    events = [json.loads(line) for line in (game_dir / "events.jsonl").read_text().splitlines()]
    seats = [player["name"] for player in config["players"]]
    roles = {player["name"]: player["role"] for player in config["players"]}
    size = len(seats)
    assert Counter(roles.values()) == dict(zip(("loyalist", "conspirator", "usurper"), ROLE_COUNTS[size]))
    alive, hand, enacted, investigated, votes = list(seats), [], Counter(), set(), {}
    draw, discard, tracker = DECK_SIZE, 0, 0
    last_consul = last_prefect = rotation = special = consul = prefect = None
    power_due = peeked = phase = None
    won, vetoed, spoken = False, False, []
    for i, event in enumerate(events):
        kind, where = event["type"], f"{game_dir.name} event {i}: {event}"
        assert not won or kind == "game_over", f"the game went on after a win: {where}"
        # the exact field set of the contract's event table; secrets only in spoiler events
        assert set(event) - {"ts", "type", "spoiler"} == \
            FIELDS[kind] - ({"target"} if event.get("kind") == "peek" else set()), where
        assert ("spoiler" in event) == (kind in SPOILERS) and event.get("spoiler", True) is True, where
        assert all(event[f] in alive for f in PLAYER_FIELDS if f in event and event[f] != "chaos"), \
            f"a dead or unknown player acts: {where}"
        assert power_due is None or kind == "power", f"power {power_due} not used: {where}"
        assert tracker < 3 or kind == "reshuffle" or (kind == "enact" and event["by"] == "chaos"), \
            f"tracker at 3 without chaos: {where}"
        if kind == "round":
            assert hand == [] and (event["draw_pile"], event["discard_pile"], event["tracker"]) == \
                (draw, discard, tracker), where
            if phase == "report":
                stats["silent"] += speakers(spoken, alive, 1, all_speak, where)
            if special:
                expected, special = special, None
            else:
                expected = rotation = config["first_consul"] if rotation is None else \
                    next(p for p in seats[seats.index(rotation) + 1:] + seats if p in alive)
            assert event["consul"] == expected, f"wrong Consul, expected {expected}: {where}"
            consul, phase, vetoed = expected, None, False
        elif kind == "nominate":
            prefect = event["prefect"]
            assert event["consul"] == consul and prefect not in (consul, last_prefect), where
            assert len(alive) <= 5 or prefect != last_consul, f"term limit: {where}"
            phase, spoken = "debate", []
        elif kind == "message":
            assert event["stage"] == phase and event["text"] and len(event["text"]) <= 600, where
            assert not re.search(r"<[^>]*>", event["text"]), f"a raw tag in a message: {where}"
            spoken.append(event["name"])
            stats[phase] += 1
        elif kind == "vote":
            assert event["voter"] not in votes, where
            votes[event["voter"]] = event["aye"]
        elif kind == "vote_result":
            stats["silent"] += speakers(spoken, alive, config["discussion_rounds"], all_speak, where)
            ayes = sum(votes.values())
            assert sorted(votes) == sorted(alive) and (event["ayes"], event["nays"]) == (ayes, len(votes) - ayes)
            assert event["passed"] == (ayes > len(votes) - ayes), where
            tracker += not event["passed"]  # a passed vote leaves it: only an enacted law resets it
            assert event["tracker"] == tracker, where
            if event["passed"]:
                last_consul, last_prefect = consul, prefect
                won = enacted["decree"] >= 3 and roles[prefect] == "usurper"
            votes, phase = {}, None
        elif kind == "reshuffle":
            assert draw < 3, where
            draw, discard, peeked = draw + discard, 0, None
            assert event["draw_pile"] == draw, where
            stats["reshuffle"] += 1
        elif kind == "draw":
            assert draw >= 3 and hand == [] and event["consul"] == consul and len(event["laws"]) == 3, where
            assert peeked is None or event["laws"] == peeked, f"the peek lied: {where}"
            draw, hand, peeked = draw - 3, list(event["laws"]), None
        elif kind == "discard":
            assert hand, f"a discard with no laws in hand (after a veto?): {where}"
            assert event["by"] == (consul if len(hand) == 3 else prefect), where
            hand.remove(event["law"])
            discard += 1
        elif kind == "veto":
            assert enacted["decree"] == 5 and len(hand) == 2, where
            assert (event["prefect"], event["consul"]) == (prefect, consul), where
            assert event["tracker"] == tracker + event["accepted"], where
            if event["accepted"]:  # both laws go to the discards, with no discard events
                tracker, discard, hand, vetoed = tracker + 1, discard + len(hand), [], True
            stats["veto:accepted" if event["accepted"] else "veto:refused"] += 1
        elif kind == "enact":
            law = event["law"]
            if event["by"] == "chaos":
                assert tracker == 3 and draw >= 3, f"chaos without 3 failures: {where}"
                assert peeked is None or law == peeked[0], where
                draw, peeked, last_consul, last_prefect = draw - 1, None, None, None
                stats["chaos"] += 1
                if vetoed:
                    stats["veto:chaos"] += 1
            else:
                assert event["by"] == prefect and len(hand) == 1, where
                hand.remove(law)
            enacted[law] += 1
            tracker = 0  # any enacted law
            assert (event["reforms"], event["decrees"], event["tracker"]) == \
                (enacted["reform"], enacted["decree"], tracker), where
            won = enacted["reform"] == 5 or enacted["decree"] == 6
            if event["by"] != "chaos" and not won:
                power_due = POWERS[size].get(enacted["decree"]) if law == "decree" else None
                phase, spoken = "report", []
        elif kind == "power":
            assert event["kind"] == power_due and event["by"] == consul, f"power not due: {where}"
            assert event.get("target") != consul, where
            if event["kind"] == "investigate":
                assert event["target"] not in investigated, f"investigated twice: {where}"
                investigated.add(event["target"])
            elif event["kind"] == "special_election":
                special = event["target"]
            power_due = None
            stats["power:" + event["kind"]] += 1
        elif kind == "power_result":
            assert event["by"] == consul, where
            if event["kind"] == "peek":
                assert draw >= 3 and len(event["result"]) == 3, where
                peeked = event["result"]
            else:
                assert event["result"] == ("loyalist" if roles[event["target"]] == "loyalist" else "conspiracy")
        elif kind == "executed":
            assert events[i - 1]["type"] == "power" and events[i - 1]["target"] == event["name"], where
            alive.remove(event["name"])
            won = roles[event["name"]] == "usurper"
        elif kind == "game_over":
            assert i == len(events) - 1 and won and event["roles"] == roles, where
            reason = event["reason"]
            assert (event["winner"], reason) in {
                ("loyalists", "reforms"), ("conspiracy", "decrees"), ("loyalists", "usurper_executed"),
                ("conspiracy", "usurper_elected")}, where
            assert {"reforms": enacted["reform"] == 5, "decrees": enacted["decree"] == 6,
                    "usurper_executed": events[i - 1]["type"] == "executed",
                    "usurper_elected": events[i - 1]["type"] == "vote_result"}[reason], where
            stats["reason:" + reason] += 1
        assert draw + discard + len(hand) + sum(enacted.values()) == DECK_SIZE, f"deck is not 17: {where}"
    assert events[-1]["type"] == "game_over", f"{game_dir.name}: no game_over"
    return events[-1]["winner"]


def check_prompts(config):
    """The system prompts. Who knows whom: 5-6 players all of the Conspiracy know each other; 7+ the
    conspirators know each other and the Usurper, the Usurper knows no one. The rules describe only
    this size's powers, mention debate only when there is some, and the Usurper's goal says "you"."""
    seats = [player["name"] for player in config["players"]]
    roles = {player["name"]: player["role"] for player in config["players"]}
    for name in seats:
        prompt = game.system_prompt(name, roles, seats, config["discussion_rounds"])
        rules, section = prompt.rsplit("\n\n", 1)  # the role and what it knows; the rules name nobody
        assert {power for power, label in POWER_LABELS.items() if label in rules} == \
            set(POWERS[len(seats)].values()), rules
        assert ("Everyone speaks" in rules) == (config["discussion_rounds"] > 0), rules
        assert ("yourself" in section) == (roles[name] == "usurper"), section
        named = {p for p in seats if p != name and re.search(rf"\b{p}\b", section)}
        allies = {p for p in seats if p != name and roles[p] != "loyalist"}
        knows = roles[name] == "conspirator" or (roles[name] == "usurper" and len(seats) <= 6)
        assert named == (allies if knows else set()), (name, roles[name], named)


def check_record_trim(game_dir):
    """Prompts keep every fact line and report claim, but debate only from the last 3 rounds."""
    config = game.make_configs(table(5), 1)[0]
    senate = game.Senate(config, game_dir, EventLog(game_dir / "events.jsonl"))
    for n in range(1, 6):
        senate.n = n
        senate.emit("round", f"fact {n}", n=n)
        senate.emit("message", f"debate {n}", name="x", text="x", stage="debate")
        senate.emit("message", f"report {n}", name="x", text="x", stage="report")
    record = senate.prompt(senate.seats[0], "task")
    assert all(f"fact {n}\n" in record and f"report {n}\n" in record for n in range(1, 6)), record
    assert [n for n in range(1, 6) if f"debate {n}\n" in record] == [3, 4, 5], record
    assert "(debate before round 3 left out)" in record, record


def check_stop_in_vote(game_dir):
    """Stopped raised inside the parallel vote ends the game, before any vote event is written."""
    def stop_at_vote(agent, system, prompt, kind, mock):
        if kind == "vote":
            STOP.set()  # as the launcher does on SIGTERM; Agent.ask then raises Stopped
        return ASK(agent, system, prompt, kind, mock)
    game.Agent.ask = stop_at_vote
    try:
        game.play(game.make_configs(table(7), 1)[0], game_dir, EventLog(game_dir / "events.jsonl"))
        raise AssertionError("the game went on after Stopped")
    except Stopped:
        pass
    finally:
        STOP.clear()
        game.Agent.ask = ASK
    types = [json.loads(line)["type"] for line in (game_dir / "events.jsonl").read_text().splitlines()]
    assert "nominate" in types and not {"vote", "vote_result", "game_over"} & set(types), types


def main(seed=SEED):
    random.seed(seed)  # the mocks' choices; each game's deck comes from its config's seed
    assert game.validate(table(6)) == []
    assert game.validate([]) and game.validate({"players": table(5)["players"][:4]})
    two_conspirators = table(6)["players"][:-2] + [{"role": "conspirator", "model": "mock"}] * 2
    assert game.validate({**table(6), "players": two_conspirators})
    assert game.validate({**table(5), "discussion_rounds": -1})
    assert game.validate({**table(5), "shuffle_roles": "y"})
    assert game.validate({"players": [{"role": "loyalist", "model": "<model>"}] + table(5)["players"][1:]})
    assert game.message_text("<choice>x</choice> hi <say> a  b </say>") == "a b"
    assert game.message_text("<say>I back Bob <choice>Aye</choice></say>") == "I back Bob Aye"
    assert game.message_text("<choice>x</choice> just this") is None and game.message_text("") is None
    assert game.message_text("<say> </say>") == ""
    assert len(game.message_text("<say>" + "w" * 900 + "</say>")) == 600
    stats, played = Counter(), 0
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for check in (check_record_trim, check_stop_in_vote):
            (root / check.__name__).mkdir()
            check(root / check.__name__)
        try:
            for script, games in [("random", GAMES_PER_SIZE)] + [(s, SCRIPTED_GAMES_PER_SIZE) for s in SCRIPTS]:
                batch = Counter()
                for size in ROLE_COUNTS:
                    for config in game.make_configs(table(size), games):
                        check_prompts(config)
                        roles = {player["name"]: player["role"] for player in config["players"]}
                        game.choose = scripted_choose(SCRIPTS[script], roles) if script in SCRIPTS \
                            else decide.choose  # random: the real choose, with each seat's mock
                        game.Agent.ask = ASK if script in SCRIPTS else noisy_ask
                        with contextlib.redirect_stdout(io.StringIO()):
                            winner = run_one("senate", game, root, config, Path("selfcheck"), 0)
                        game_dir = root / f"{played + 1:04d}"
                        console = game_dir / "console.txt"
                        assert not console.exists(), console.read_text()
                        assert replay(game_dir, batch, all_speak=script in SCRIPTS) == winner, game_dir
                        assert "PRIVATE" not in (game_dir / "events.jsonl").read_text(), game_dir
                        kinds = Counter(json.loads(line)["kind"] for log in game_dir.glob("*_reasoning.jsonl")
                                        for line in log.read_text().splitlines())
                        assert set(kinds) <= DECISION_KINDS | {f"invalid:{kind}" for kind in DECISION_KINDS}, kinds
                        batch["say:invalid"] += kinds["invalid:debate"] + kinds["invalid:report"]
                        batch["kind:execute"] += kinds["execute"]
                        played += 1
                assert script not in SCRIPT_REACHES or batch[SCRIPT_REACHES[script]], f"{script}: {batch}"
                stats += batch
        finally:
            game.choose, game.Agent.ask = decide.choose, ASK
        index = json.loads((root / "index.json").read_text())
        assert len(index) == played
        for entry in index:
            game_over = json.loads((root / entry["id"] / "events.jsonl").read_text().splitlines()[-1])
            assert entry["winner"] == game_over["winner"], entry
    missing = MUST_REACH - set(stats)
    assert not missing, f"never reached in {played} games: {sorted(missing)}"
    print(f"senate selfcheck: ok, {played} games, " + ", ".join(f"{k} {v}" for k, v in sorted(stats.items())))


if __name__ == "__main__":
    main()
