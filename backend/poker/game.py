"""Heads-up no-limit Hold'em for the arena (rules: docs/ARENA_CONTRACT.md section 5).

    python -m arena.run poker configurations/poker/mock.json --games 2
"""
import random
import re

from arena.agent import Agent, llm_config_for, model_problem
from arena.decide import tag
from game_constants import OPTIONAL_CODE_NAMES
from poker.evaluator import RANKS, best_hand, hand_name

BLINDS = (1, 2)
STACK = 200
SAY_LIMIT = 200
HISTORY_HANDS = 10
STREETS = ["preflop", "flop", "turn", "river"]
BOARD_SIZE = {"preflop": 0, "flop": 3, "turn": 4, "river": 5}
DECK = [r + s for r in RANKS for s in "shdc"]
MOCK_SAYS = ["Nice hand.", "Let's see.", "Hmm, interesting.", "You sure about that?", "Good luck."]
SYSTEM = (f"You are playing heads-up no-limit Texas Hold'em against one opponent. Blinds are "
          f"{BLINDS[0]}/{BLINDS[1]} and every hand starts with {STACK} chips each. Your goal is to win "
          f"as many chips as you can over all the hands. Amounts after bet/raise mean \"to N\": the total "
          f"you have put in on this street after the action.")


def validate(table):
    seats = table.get("players", [])
    problems = [] if len(seats) == 2 else [f"poker needs exactly 2 players, got {len(seats)}"]
    problems += [p for i, seat in enumerate(seats) if (p := model_problem(seat, i))]
    if not isinstance(table.get("hands"), int) or table["hands"] < 1:
        problems.append('"hands" must be a positive integer')
    return problems


def make_configs(table, n):
    seats = table["players"]
    duplicate = table.get("duplicate", True)

    def config(order, seed, pair, mirror, names):
        return {"players": [{"name": name, "model": seats[i]["model"], "llm_config": llm_config_for(seats[i], table)}
                            for name, i in zip(names, order)],
                "hands": table["hands"], "blinds": list(BLINDS), "stack": STACK, "seed": seed,
                "pair": pair, "mirror": mirror, "table_talk": table.get("table_talk", True)}

    configs = []
    for k in range(n):
        seed = random.randrange(2 ** 31)
        names = random.sample(OPTIONAL_CODE_NAMES, 4)  # new names in each game of a pair
        if duplicate:
            configs += [config((0, 1), seed, seed, False, names[:2]), config((1, 0), seed, seed, True, names[2:])]
        else:
            configs.append(config((0, 1), seed, None, False, names[:2]))
    return configs


def parse_action(text, legal):
    """('fold',) | ('check',) | ('call',) | ('raise', to) from a model's <action>, or None.
    legal: {"to_call", "raise": (min_to, max_to) or None}. Amounts are clamped into range, bet and
    raise are read as the legal one, check/call as each other, fold as check when nothing is owed."""
    said = re.sub(r"(?<=\d),(?=\d{3})", "", (text or "").lower())  # 1,000 -> 1000
    said = re.sub(r"all[-_ ]?in", "allin", said)
    m = re.search(r"\b(fold|check|call|bet|raise|allin)\b(?:\s+to)?\s*(allin|\d+(?:\.\d+)?)?", said)  # first keyword wins: "I raise to 40"
    if not m:
        return None
    word, amount = m.group(1), m.group(2)
    if amount == "allin":
        word = "allin"
    if word == "fold":
        return ("fold",) if legal["to_call"] else ("check",)
    if word in ("check", "call"):
        return ("call",) if legal["to_call"] else ("check",)
    low, high = legal["raise"] or (0, 0)
    if word == "allin":
        return ("raise", high) if legal["raise"] else ("call",)
    if amount is None:
        return None
    if not legal["raise"]:
        return ("call",)  # nothing to raise with: the chips are all in already
    return ("raise", max(low, min(high, round(float(amount)))))


def describe(legal, cur_word):
    parts = ["fold", f"call {legal['to_call_amount']}"] if legal["to_call"] else ["check"]
    if legal["raise"]:
        low, high = legal["raise"]
        parts.append(f"{cur_word} N, N from {low} to {high} (N = {high} is all-in)")
    return "; ".join(parts)


class Hand:
    """One hand. Seat 0/1 indexes everything; the button is the small blind and acts first preflop."""

    def __init__(self, game, n):
        self.g, self.n = game, n
        self.button = (n - 1) % 2
        deck = DECK[:]
        random.Random(f"{game.seed}-{n}").shuffle(deck)
        self.hole = [deck[0:2], deck[2:4]]
        self.full_board = deck[4:9]
        self.board = []
        self.stk = [STACK, STACK]
        self.bet = [0, 0]  # this street
        self.put = [0, 0]  # this hand
        self.cur = 0
        self.last_raise = BLINDS[1]
        self.lines = {s: [] for s in STREETS}  # one-line history of this hand
        self.street = "preflop"

    @property
    def pot(self):
        return sum(self.put)

    def act(self, i, kind, amount, say=None):
        self.stk[i] -= amount
        self.bet[i] += amount
        self.put[i] += amount
        fields = {"say": say} if say else {}
        self.g.log.emit("action", player=self.g.names[i], action=kind, amount=amount, to=self.bet[i],
                        pot=self.pot, stack=self.stk[i], all_in=self.stk[i] == 0, **fields)
        if kind != "blind":
            label = f"{kind} to {self.bet[i]}" if kind in ("bet", "raise") else kind
            self.lines[self.street].append(f"{self.g.names[i]} {label}" + (f' "{say}"' if say else ""))

    def prompt(self, i, legal):
        g, me, opp = self.g, self.g.names[i], self.g.names[1 - i]
        past = [f"hand {h['n']}: {h['text']}" for h in g.history[-HISTORY_HANDS:]]
        now = [f"{s}: {', '.join(self.lines[s])}" for s in STREETS if self.lines[s]]
        position = "button (small blind, acts first preflop, last after)" if i == self.button else "big blind"
        return "\n".join([
            f"You are {me}; your opponent is {opp}. Hand {self.n} of {g.hands}.",
            f"Your position: {position}.",
            f"Your hole cards: {' '.join(self.hole[i])}",
            f"Board: {' '.join(self.board) or '(none yet)'}  ({self.street})",
            f"Pot: {self.pot}. Your stack: {self.stk[i]}, {opp}'s stack: {self.stk[1 - i]}. "
            f"This street you have put in {self.bet[i]}, {opp} {self.bet[1 - i]}. To call: {legal['to_call_amount']}.",
            f"Legal actions: {describe(legal, 'raise' if self.cur else 'bet')}",
            "This hand so far: " + ("; ".join(now) if now else "nothing yet"),
            f"Last {len(past)} hands:" if past else "No earlier hands.", *past,
            "", "Reply with <action>fold|check|call|bet N|raise N</action>"
            + (f" and optionally <say>a short remark to {opp}, at most {SAY_LIMIT} characters</say>." if g.table_talk else "."),
        ])

    def legal(self, i):
        to_call = self.cur - self.bet[i]
        high = self.bet[i] + self.stk[i]
        low = min(high, self.cur + self.last_raise if self.cur else BLINDS[1])
        can_raise = self.stk[i] > to_call and self.stk[1 - i] > 0
        return {"to_call": to_call, "to_call_amount": min(to_call, self.stk[i]),
                "raise": (low, high) if can_raise else None}

    def decide(self, i, legal):
        g, agent = self.g, self.g.agents[i]

        def mock():
            r, options = random.random(), []
            if legal["raise"] and r < 0.3:
                low, high = legal["raise"]
                size = random.choice([low, low, (low + high) // 2, high]) if random.random() < 0.8 else random.randint(low, high)
                options = [f"{'raise' if self.cur else 'bet'} {size}"]
            elif legal["to_call"] and r > 0.9:
                options = ["fold"]
            answer = options[0] if options else ("call" if legal["to_call"] else "check")
            talk = f"<say>{random.choice(MOCK_SAYS)}</say>" if g.table_talk and random.random() < 0.3 else ""
            return f"<action>{answer}</action>{talk}"

        prompt = self.prompt(i, legal)
        answer = agent.ask(SYSTEM, prompt, "action", mock)
        action = parse_action(tag(answer, "action"), legal)
        if action is None:
            retry = (f"{prompt}\n\nYour last answer had no legal <action>. Reply again with exactly one of: "
                     f"fold, check, call, bet N, raise N, all-in, inside <action></action>.")
            answer = agent.ask(SYSTEM, retry, "action", mock)
            action = parse_action(tag(answer, "action"), legal)
        if action is None:
            action = random.choice([("call",) if legal["to_call"] else ("check",)] * 3
                                   + ([("raise", random.randint(*legal["raise"]))] if legal["raise"] else [])
                                   + ([("fold",)] if legal["to_call"] else []))
            agent.logger.log_call("invalid:action", " ".join(map(str, action)), f"no legal action in: {answer!r}")
        say = (tag(answer, "say") or "")[:SAY_LIMIT] if g.table_talk else ""
        return action, say

    def betting(self, first):
        """The betting round. Returns the seat that folded, or None."""
        pending = [first, 1 - first] if min(self.stk) > 0 else []
        while pending:
            i = pending.pop(0)
            legal = self.legal(i)
            action, say = self.decide(i, legal)
            if action[0] == "fold":
                self.act(i, "fold", 0, say)
                return i
            if action[0] == "check":
                self.act(i, "check", 0, say)
            elif action[0] == "call":
                self.act(i, "call", legal["to_call_amount"], say)
            else:
                to = action[1]
                kind = "raise" if self.cur else "bet"
                self.act(i, kind, to - self.bet[i], say)
                if to - self.cur >= self.last_raise:  # a short all-in does not raise the minimum
                    self.last_raise = to - self.cur
                self.cur = to
                pending = [1 - i] if self.stk[1 - i] > 0 else []
        return None

    def play(self):
        g, b = self.g, self.button
        g.log.emit("hand_start", hand=self.n, button=g.names[b], seed=g.seed, stacks=dict.fromkeys(g.names, STACK))
        self.act(b, "blind", BLINDS[0])
        self.act(1 - b, "blind", BLINDS[1])
        self.cur = BLINDS[1]
        for i in (0, 1):
            g.log.emit("deal", player=g.names[i], cards=self.hole[i], spoiler=True)
        folder = None
        for self.street in STREETS:
            if self.street != "preflop":
                self.board = self.full_board[:BOARD_SIZE[self.street]]
                self.bet, self.cur, self.last_raise = [0, 0], 0, BLINDS[1]
                g.log.emit("street", name=self.street, board=self.board)
            folder = self.betting(b if self.street == "preflop" else 1 - b)
            if folder is not None:
                break
        shown = {}
        if folder is not None:
            w = 1 - folder
            refund = self.bet[w] - self.bet[folder]
            if refund > 0:
                self.put[w] -= refund
                self.stk[w] += refund
                g.log.emit("refund", player=g.names[w], amount=refund, pot=self.pot)
            winners, pot = [w], self.pot
        else:
            ranks = []
            for i in (0, 1):
                rank, five = best_hand(self.hole[i] + self.board)
                ranks.append(rank)
                shown[i] = hand_name(rank)
                g.log.emit("showdown", player=g.names[i], cards=self.hole[i], hand_name=shown[i], best=five)
            winners = [0, 1] if ranks[0] == ranks[1] else [0 if ranks[0] > ranks[1] else 1]
            pot = self.pot
        share = pot // len(winners)
        deltas = {g.names[i]: (share if i in winners else 0) - self.put[i] for i in (0, 1)}
        for name, d in deltas.items():
            g.totals[name] += d
        g.log.emit("hand_end", hand=self.n, winners=[g.names[i] for i in winners], pot=pot, deltas=deltas,
                   totals=dict(g.totals), board=self.board)
        self.summarize(deltas, folder, shown)

    def summarize(self, deltas, folder, shown):
        g = self.g
        acts = " | ".join(f"{s}: {', '.join(self.lines[s])}" for s in STREETS if self.lines[s])
        end = (f"{g.names[folder]} folded" if folder is not None else
               "showdown " + "; ".join(f"{g.names[i]} {' '.join(self.hole[i])} ({shown[i]})" for i in (0, 1)))
        g.history.append({"n": self.n, "text": f"button {g.names[self.button]}, board {' '.join(self.board) or '-'}. "
                          f"{acts}. {end}. Result: " + ", ".join(f"{k} {v:+d}" for k, v in deltas.items())})


class Game:

    def __init__(self, config, game_dir, log):
        self.log, self.hands, self.seed = log, config["hands"], config["seed"]
        self.table_talk = config["table_talk"]
        self.agents = [Agent(p["name"], p["llm_config"], game_dir) for p in config["players"]]
        self.names = [a.name for a in self.agents]
        self.totals = dict.fromkeys(self.names, 0)
        self.history = []


def play(config, game_dir, log):
    g = Game(config, game_dir, log)
    for n in range(1, g.hands + 1):
        Hand(g, n).play()
    a, b = g.names
    winner = "draw" if g.totals[a] == g.totals[b] else max(g.totals, key=g.totals.get)
    log.emit("game_over", winner=winner, reason="hands_played", hands=g.hands, totals=dict(g.totals))
    return winner
