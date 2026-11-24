"""Poker selfcheck: the evaluator against known hands, then mock games replayed from events.jsonl.
    env -u OPENROUTER_API_KEY backend/.venv/bin/python -m poker.selfcheck   (from backend/)"""
import json
import random
import tempfile
from pathlib import Path

from arena.events import EventLog
from poker import game
from poker.evaluator import best_hand, hand_name, rank5

# (cards, name): every category, kickers, wheel, steel wheel, board plays
HANDS = [
    ("As Kd 9h 5c 2d", "high card, ace high"), ("Qs Jd 9h 5c 2d", "high card, queen high"),
    ("As Ad 9h 5c 2d", "pair of aces"), ("6s 6d 9h 5c 2d", "pair of sixes"),
    ("Ks Kd 9h 9c 2d", "two pair, kings and nines"), ("3s 3d 2h 2c Ad", "two pair, threes and twos"),
    ("7s 7d 7h 5c 2d", "three of a kind, sevens"),
    ("As 2d 3h 4c 5d", "straight, five high"), ("6s 2d 3h 4c 5d", "straight, six high"),
    ("Ts Jd Qh Kc Ad", "straight, ace high"),
    ("As 9s 7s 5s 2s", "flush, ace high"), ("7s 7d 7h 2c 2d", "full house, sevens over twos"),
    ("9s 9d 9h 9c 2d", "four of a kind, nines"), ("5s 4s 3s 2s As", "straight flush, five high"),
    ("9s 8s 7s 6s 5s", "straight flush, nine high"), ("Ts Js Qs Ks As", "royal flush"),
]
BETTER = [  # each line beats the next
    "9s 8s 7s 6s 5s", "9s 9d 9h 9c 2d", "Ks Kd Kh 2c 2d", "As 9s 7s 5s 2s", "6s 2d 3h 4c 5d", "7s 7d 7h 5c 2d",
    "Ks Kd 9h 9c 2d", "Qs Qd 9h 9c 2s", "As Ad 9h 5c 2d", "As Kd 9h 5c 2d",
]


def check_evaluator():
    for cards, name in HANDS:
        assert hand_name(rank5(cards.split())) == name, (cards, hand_name(rank5(cards.split())))
    ranks = [rank5(c.split()) for c in BETTER]
    assert all(a > b for a, b in zip(ranks, ranks[1:])), "category order"
    assert rank5("Ks Kd 9h 9c 3d".split()) > rank5("Ks Kd 9h 9c 2d".split())  # kicker
    assert rank5("As Ah Qs Jd 9c".split()) > rank5("Ad Ac Qh Td 9s".split())
    assert rank5("As Ah Qs Jd 9c".split()) == rank5("Ad Ac Qh Jc 9s".split())  # exact tie
    assert rank5("As 2d 3h 4c 5d".split()) < rank5("6s 2d 3h 4c 5d".split())  # wheel is lowest
    assert rank5("As 9s 7s 5s 2s".split()) > rank5("Ts Jd Qh Kc Ad".split())  # flush beats straight
    assert rank5("8s 8d 8h 2c 2d".split()) < rank5("As Ad Ah Kc Kd".split())  # full house: trips first
    # seven cards: board plays, wheel inside seven, flush beats lower straight, full house from two trips
    rank, five = best_hand("Ts Js Qs Ks As 2d 3c".split())
    assert hand_name(rank) == "royal flush" and set(five) == set("Ts Js Qs Ks As".split())
    assert hand_name(best_hand("As 2d 3h 4c 9d 5s Kh".split())[0]) == "straight, five high"
    assert best_hand("2s 3s 4s 5s 6d 7d Kh".split())[0] == rank5("3s 4s 5s 6d 7d".split())
    assert hand_name(best_hand("7s 7d 7h 2c 2d 2h Ac".split())[0]) == "full house, sevens over twos"
    assert best_hand("Ac Kd 2h 3h 4s 5d 9c".split())[0] == rank5("As 2d 3h 4c 5d".split())
    board = "Ah Ad Ac Kh Kd".split()  # board plays: both hands tie
    assert best_hand(board + ["2c", "3c"])[0] == best_hand(board + ["4s", "5s"])[0]
    legal = {"to_call": 4, "raise": (8, 200)}
    for text, want in [("fold", ("fold",)), ("call", ("call",)), ("Raise to 40", ("raise", 40)),
                       ("bet 3", ("raise", 8)), ("raise 9999", ("raise", 200)), ("ALL-IN", ("raise", 200)),
                       ("all in", ("raise", 200)), ("I think", None), ("raise", None), ("check", ("call",)),
                       ("raise to 1,000", ("raise", 200)), ("bet 2.5", ("raise", 8)), ("raise 12.4", ("raise", 12)),
                       ("all_in", ("raise", 200)), ("allin", ("raise", 200)), ("raise all-in", ("raise", 200)),
                       ("bet all in", ("raise", 200)), ("I raise to 40", ("raise", 40)), ("I'll call", ("call",)),
                       ("So I fold.", ("fold",))]:
        assert game.parse_action(text, legal) == want, text
    assert game.parse_action("fold", {"to_call": 0, "raise": (2, 200)}) == ("check",)
    assert game.parse_action("all-in", {"to_call": 4, "raise": None}) == ("call",)


def check_events(events, config):
    names = [p["name"] for p in config["players"]]
    hands = [[]]
    for e in events:
        if e["type"] == "hand_start" and hands[-1]:
            hands.append([])
        if e["type"] != "game_over":
            hands[-1].append(e)
    assert len(hands) == config["hands"]
    totals = dict.fromkeys(names, 0)
    for n, hand in enumerate(hands, 1):
        types = [e["type"] for e in hand]
        assert types[0] == "hand_start" and hand[0]["hand"] == n and types[-1] == "hand_end"
        assert types[1:3] == ["action"] * 2 and hand[1]["action"] == hand[2]["action"] == "blind"
        assert types[3:5] == ["deal"] * 2 and all(e["spoiler"] for e in hand[3:5])
        button = names[(n - 1) % 2]
        assert hand[0]["button"] == button and hand[1]["player"] == button and hand[1]["amount"] == 1
        assert hand[2]["amount"] == 2
        deals = {e["player"]: e["cards"] for e in hand[3:5]}
        stack, put, bet = dict.fromkeys(names, 200), dict.fromkeys(names, 0), dict.fromkeys(names, 0)
        cur, last_raise, pot, board, street = 0, 2, 0, [], "preflop"
        acting = []  # whose turn it is next, derived from the rules
        shown, folded, refunded = [], None, 0
        for e in hand[1:-1]:
            t = e["type"]
            if "spoiler" not in e:
                assert "cards" not in e or t == "showdown", "hole cards leaked"
            if t == "action":
                p = e["player"]
                a = e["action"]
                if a == "blind":
                    stack[p] -= e["amount"]; put[p] += e["amount"]; bet[p] += e["amount"]; cur = max(cur, bet[p])
                    if p == hand[2]["player"]:
                        acting = [button, names[n % 2]]
                else:
                    assert acting and acting.pop(0) == p, "turn order"
                    owed = cur - bet[p]
                    if a == "check":
                        assert owed == 0 and e["amount"] == 0
                    elif a == "fold":
                        assert owed > 0 and e["amount"] == 0
                        folded = p
                    elif a == "call":
                        assert owed > 0 and e["amount"] == min(owed, stack[p])
                    else:
                        assert a == ("raise" if cur else "bet") and e["amount"] > 0
                        to = bet[p] + e["amount"]
                        allin = e["amount"] == stack[p]
                        assert to > cur and (allin or (to >= cur + last_raise and to >= 2)), "min raise"
                        if to - cur >= last_raise:
                            last_raise = to - cur
                        cur = to
                        other = [q for q in names if q != p][0]
                        acting = [other] if stack[other] > 0 else []
                    stack[p] -= e["amount"]; put[p] += e["amount"]; bet[p] += e["amount"]
                assert stack[p] >= 0 and e["stack"] == stack[p] and e["to"] == bet[p]
                assert e["all_in"] == (stack[p] == 0)
                pot += e["amount"]
                assert e["pot"] == pot == sum(put.values())
            elif t == "street":
                assert not acting and folded is None, "street before betting is over"
                street = e["name"]
                board = e["board"]
                assert len(board) == {"flop": 3, "turn": 4, "river": 5}[street]
                bet = dict.fromkeys(names, 0)
                cur, last_raise = 0, 2
                acting = [names[n % 2], button] if min(stack.values()) > 0 else []
            elif t == "refund":
                assert e["player"] != folded and e["amount"] == bet[e["player"]] - bet[folded]
                refunded = e["amount"]; pot -= refunded; put[e["player"]] -= refunded
                assert e["pot"] == pot
            elif t == "showdown":
                assert e["cards"] == deals[e["player"]] and len(e["best"]) == 5
                shown.append(e)
        end = hand[-1]
        assert not acting or folded, "betting round left unfinished"
        assert end["pot"] == pot == sum(put.values())
        assert sum(end["deltas"].values()) == 0 and sorted(end["deltas"]) == sorted(names)
        for name in names:
            totals[name] += end["deltas"][name]
        assert end["totals"] == totals
        if folded:
            assert not shown and end["winners"] == [q for q in names if q != folded]
            assert end["board"] == board
        else:
            assert len(shown) == 2 and len(board) == 5 and end["board"] == board
            assert all(s["player"] in names for s in shown)
            if len(end["winners"]) == 2:
                assert end["deltas"] == dict.fromkeys(names, 0)
        assert all(abs(d) <= 200 for d in end["deltas"].values())
        assert len({c for cs in deals.values() for c in cs} | set(board)) == 4 + len(board)
    return totals, hands


def play_one(config, directory):
    path = Path(directory) / "events.jsonl"
    winner = game.play(config, Path(directory), EventLog(path))
    events = [json.loads(line) for line in path.read_text().splitlines()]
    totals, hands = check_events(events, config)
    over = events[-1]
    assert over["type"] == "game_over" and over["winner"] == winner and over["totals"] == totals
    expected = "draw" if len(set(totals.values())) == 1 else max(totals, key=totals.get)
    assert winner == expected
    return events, totals, hands


def seat_view(hands, config):
    """Per hand: the hole cards by seat and the boards seen (the longest one is the prefix of all)."""
    names = [p["name"] for p in config["players"]]
    return [({names.index(e["player"]): e["cards"] for e in h if e["type"] == "deal"},
             max([e["board"] for e in h if e["type"] == "street"], key=len, default=[])) for h in hands]


def check_garbage(directory):
    """A seat that always answers garbage: one re-ask, then a random legal action, logged invalid."""
    table = {"players": [{"model": "mock"}, {"model": "mock"}], "hands": 8, "duplicate": False, "table_talk": True}
    config = game.make_configs(table, 1)[0]
    ask = game.Agent.ask
    calls = []

    def garbage(self, system, prompt, kind, mock):
        if self.name != config["players"][0]["name"]:
            return ask(self, system, prompt, kind, mock)
        calls.append(prompt)
        self.logger.log_call(kind, "garbage", "test")
        return "no idea"

    game.Agent.ask = garbage
    try:
        play_one(config, directory)
    finally:
        game.Agent.ask = ask
    name = config["players"][0]["name"]
    invalid = [line for line in (Path(directory) / f"{name}_reasoning.jsonl").read_text().splitlines() if "invalid:action" in line]
    assert invalid and len(calls) == 2 * len(invalid), (len(invalid), len(calls))  # exactly one re-ask each


def main():
    check_evaluator()
    with tempfile.TemporaryDirectory() as d:
        check_garbage(d)
    table = {"players": [{"model": "mock"}, {"model": "mock"}], "hands": 30, "duplicate": True, "table_talk": True}
    assert game.validate(table) == [] and game.validate({"players": [{"model": "mock"}], "hands": 3})
    allin = ended = showdowns = folds = said = 0
    for _ in range(30):
        a, b = game.make_configs(table, 1)
        assert a["pair"] == b["pair"] and a["seed"] == b["seed"] and (a["mirror"], b["mirror"]) == (False, True)
        assert [p["model"] for p in a["players"]] == ["mock", "mock"] and a["players"][0]["name"] != b["players"][0]["name"]
        with tempfile.TemporaryDirectory() as d1, tempfile.TemporaryDirectory() as d2:
            ea, _, ha = play_one(a, d1)
            eb, _, hb = play_one(b, d2)
        # mirror: same hole cards per seat and same boards (first hands' boards are seed-only)
        for (cards_a, board_a), (cards_b, board_b) in zip(seat_view(ha, a), seat_view(hb, b)):
            assert cards_a == cards_b, "seats get the same cards in both games"
            assert board_a[:len(board_b)] == board_b[:len(board_a)], "same boards"
        assert [p["model"] for p in a["players"]] == [p["model"] for p in b["players"]]
        for e in ea + eb:
            allin += e["type"] == "action" and e["all_in"]
            showdowns += e["type"] == "showdown"
            folds += e["type"] == "action" and e["action"] == "fold"
            said += e["type"] == "action" and "say" in e and len(e["say"]) <= 200
        ended += 2
    assert allin and showdowns and folds and said, (allin, showdowns, folds, said)
    m, w = game.make_configs({**table, "players": [{"model": "mock"}, {"model": "mock", "x": 1}]}, 1)
    assert m["players"][0]["llm_config"] == w["players"][1]["llm_config"] and m["players"][1]["llm_config"] == w["players"][0]["llm_config"]
    assert not {p["name"] for p in m["players"]} & {p["name"] for p in w["players"]}
    unduplicated = game.make_configs({**table, "duplicate": False}, 3)
    assert len(unduplicated) == 3 and all(c["pair"] is None and not c["mirror"] for c in unduplicated)
    print(f"poker selfcheck: ok ({ended} mock games; all-ins {allin}, showdowns {showdowns}, folds {folds}, says {said})")


if __name__ == "__main__":
    random.seed()
    main()
