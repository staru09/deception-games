"""
Senate: an original hidden-role game on Secret Hitler's mechanics, under our own names and theme.
The Loyalists want 5 Reforms; a hidden Conspiracy (conspirators and one Usurper) wants 6 Decrees
or the Usurper elected Prefect. Rules, configs and events: docs/ARENA_CONTRACT.md §4.

    cd backend
    python -m arena.run senate configurations/senate/mock_5p.json --games 3   # offline, mock seats
    python -m senate.selfcheck                                               # the rule checks
"""
import random
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from arena.agent import Agent, llm_config_for, model_problem
from arena.decide import choose, tag
from game_constants import OPTIONAL_CODE_NAMES

LOYALIST, CONSPIRATOR, USURPER = "loyalist", "conspirator", "usurper"
LOYALISTS, CONSPIRACY = "loyalists", "conspiracy"
REFORM, DECREE = "reform", "decree"
PEEK, INVESTIGATE, SPECIAL_ELECTION, EXECUTION = "peek", "investigate", "special_election", "execution"
AYE, NAY = "Aye", "Nay"
CHAOS = "chaos"  # the enact event's "by" when three failed elections force the top law

ROLE_COUNTS = {5: (3, 1, 1), 6: (4, 1, 1), 7: (4, 2, 1), 8: (5, 2, 1), 9: (5, 3, 1), 10: (6, 3, 1)}
DECK = [REFORM] * 6 + [DECREE] * 11
HAND = 3  # laws a Consul draws and a peek shows; fewer left in the deck means a reshuffle first
REFORMS_TO_WIN, DECREES_TO_WIN = 5, 6
USURPER_ELECTED_AFTER = 3  # decrees enacted before electing the Usurper Prefect wins
VETO_AFTER = 5  # decrees enacted before the Prefect may propose a veto
CHAOS_AT = 3  # failed elections in a row
CONSUL_TERM_LIMIT_ABOVE = 5  # the last Consul can't be Prefect while more players than this live
USURPER_KNOWS_ALLIES_UP_TO = 6  # players
POWERS = {  # table size -> {decrees enacted: the power the Consul uses}
    **dict.fromkeys((5, 6), {3: PEEK, 4: EXECUTION, 5: EXECUTION}),
    **dict.fromkeys((7, 8), {2: INVESTIGATE, 3: SPECIAL_ELECTION, 4: EXECUTION, 5: EXECUTION}),
    **dict.fromkeys((9, 10), {1: INVESTIGATE, 2: INVESTIGATE, 3: SPECIAL_ELECTION, 4: EXECUTION,
                              5: EXECUTION}),
}
DEFAULT_DISCUSSION_ROUNDS = 1
MESSAGE_CHARS = 600

RULES = """You are playing Senate, a hidden-role game, with {size} players: {loyalists} loyalists, \
{conspirators} conspirator(s) and 1 usurper. The loyalists are the Loyalists; the conspirators and the \
usurper are the Conspiracy. Roles stay secret until the game ends, even after death.
Laws: a shuffled deck of 6 Reforms and 11 Decrees. The Loyalists win when 5 Reforms are enacted or \
the Usurper is executed. The Conspiracy wins when 6 Decrees are enacted, or when the Usurper is \
elected Prefect after 3 or more Decrees are enacted.
Each round the office of Consul passes to the next living player in seat order. The Consul \
nominates a Prefect: not the last elected Prefect, nor the last elected Consul while more than 5 \
players live. {debate}All living players then vote Aye or Nay at once; more Ayes than Nays \
elects the government. A failed vote moves the failed-election tracker up by 1; at 3 the top law of \
the deck is enacted with no power and the term limits are forgotten. Any enacted law sets the \
tracker back to 0. In an elected government the Consul secretly draws 3 laws and discards 1, \
and the Prefect secretly discards 1 of the other 2 and enacts the last. Nobody else sees these \
laws, so either of them may lie about them. Once 5 Decrees are enacted the Prefect may propose a \
veto; if the Consul accepts, both laws are discarded and the tracker moves up by 1 (at 3, the top \
law is enacted). When fewer than 3 laws are left in the deck, the discards are shuffled back in.
Powers: when a government enacts a Decree, its Consul uses the power for the Decree count reached: \
{powers}. {power_rules} The dead never speak or vote.
After each law a government enacts, everyone speaks once; the Consul and the Prefect usually say \
which laws they saw."""
POWER_RULES = {PEEK: "Peek: see the top 3 laws of the deck.",
               INVESTIGATE: "Investigate: learn whether another player is loyalist or conspiracy (the "
                            "Usurper shows as conspiracy); nobody is investigated twice.",
               SPECIAL_ELECTION: "Special election: choose the next Consul; after that round the order "
                                 "goes on from you.",
               EXECUTION: "Execution: kill another player; their role is not revealed, but executing "
                          "the Usurper wins for the Loyalists."}
DISGUISE = " Pass for a loyalist: never admit your role, and lie about the laws you saw whenever it helps."
GOALS = {LOYALIST: "Win with 5 Reforms or by executing the Usurper. Elect players you trust and watch "
                   "who passes and enacts Decrees.",
         CONSPIRATOR: "Win with 6 Decrees, or by getting the Usurper elected Prefect once 3 Decrees are "
                      "enacted." + DISGUISE,
         USURPER: "Win with 6 Decrees, or by getting yourself elected Prefect once 3 Decrees are "
                  "enacted." + DISGUISE}
SAY = "\nSay one short message to the table (1 to 3 sentences) inside <say></say>. You may lie."
SAY_AGAIN = ("\n\nYour last answer had no <say></say>. Reply again with your message to the table "
             "inside <say></say>, or <say></say> to stay silent.")
DEBATE_ROUNDS_KEPT = 3  # older debate leaves the record; facts and report claims always stay
POWER_ASKS = {INVESTIGATE: "Your power: investigate a player to learn their side.",
              SPECIAL_ELECTION: "Your power: choose the next Consul (a special election).",
              EXECUTION: "Your power: execute a player."}
POWER_LINES = {INVESTIGATE: "{by} investigated {target}'s side.",
               SPECIAL_ELECTION: "{by} called a special election: {target} is the next Consul.",
               EXECUTION: "{by} executed {target}."}
MOCK_LINES = ["I trust {name} for now.", "{name}'s story about those laws doesn't add up.",
              "Watch who {name} keeps nominating.", "I'd back {name} as Prefect.",
              "I passed two Reforms, I swear.", "Let's give this government a chance.",
              "{name} is too quiet for a loyalist.", "Only Decrees in my hand, nothing to do."]


class GameOver(Exception):
    """Raised wherever a side wins; args are (winner, reason)."""


def validate(table):
    if not isinstance(table, dict):
        return ["the table config must be a JSON object"]
    seats = table.get("players")
    if not isinstance(seats, list) or len(seats) not in ROLE_COUNTS:
        return [f"Senate needs 5 to 10 players, got {len(seats) if isinstance(seats, list) else seats!r}"]
    problems = [problem for i, seat in enumerate(seats) if (problem := model_problem(seat, i))]
    roles = Counter(seat.get("role") for seat in seats if isinstance(seat, dict))
    wanted = dict(zip((LOYALIST, CONSPIRATOR, USURPER), ROLE_COUNTS[len(seats)]))
    if roles != wanted:
        problems.append(f"{len(seats)} players need the roles {wanted}, got {dict(roles)}")
    rounds = table.get("discussion_rounds", DEFAULT_DISCUSSION_ROUNDS)
    if type(rounds) is not int or rounds < 0:
        problems.append(f"discussion_rounds must be a whole number, 0 or more, got {rounds!r}")
    if not isinstance(table.get("shuffle_roles", False), bool):
        problems.append("shuffle_roles must be true or false")
    return problems


def make_configs(table, n):
    """n games: each shuffles the seats, draws new names and a first Consul, and with
    "shuffle_roles" also deals the roles out again among the seats."""
    configs = []
    for _ in range(n):
        seats = [dict(seat) for seat in table["players"]]
        if table.get("shuffle_roles"):
            for seat, role in zip(seats, random.sample([s["role"] for s in seats], len(seats))):
                seat["role"] = role
        random.shuffle(seats)
        names = random.sample(OPTIONAL_CODE_NAMES, len(seats))
        configs.append({
            "players": [{"name": name, "model": seat["model"], "role": seat["role"],
                         "llm_config": llm_config_for(seat, table)} for name, seat in zip(names, seats)],
            "discussion_rounds": table.get("discussion_rounds", DEFAULT_DISCUSSION_ROUNDS),
            "seed": random.randrange(2 ** 31), "first_consul": random.choice(names)})
    return configs


def play(config, game_dir, log):
    game = Senate(config, game_dir, log)
    try:
        game.run()
    except GameOver as over:
        winner, reason = over.args
        log.emit("game_over", winner=winner, reason=reason, roles=game.roles)
        return winner


def system_prompt(name, roles, seats, discussion_rounds):
    """The rules, the player's role and what that role knows. Fixed for the whole game."""
    size, role = len(seats), roles[name]
    usurper = next(p for p in seats if roles[p] == USURPER)
    conspirators = [p for p in seats if roles[p] == CONSPIRATOR]
    if role == LOYALIST:
        you = "You are a loyalist. You don't know anyone else's role."
    elif role == CONSPIRATOR:
        others = [p for p in conspirators if p != name]
        knows = "knows" if size <= USURPER_KNOWS_ALLIES_UP_TO else "does not know"
        you = f"You are a conspirator. The Usurper is {usurper}, who {knows} who you are."
        you += f" Your fellow conspirators: {', '.join(others)}." if others else ""
    elif size <= USURPER_KNOWS_ALLIES_UP_TO:
        you = f"You are the Usurper. Your conspirators, who know you too: {', '.join(conspirators)}."
    else:
        you = "You are the Usurper. You don't know who the conspirators are, but they know you."
    powers = ", ".join(f"Decree {count}: {power.replace('_', ' ')}"
                       for count, power in POWERS[size].items())
    power_rules = " ".join(POWER_RULES[power] for power in dict.fromkeys(POWERS[size].values()))
    debate = ("" if discussion_rounds == 0 else "Everyone speaks once. " if discussion_rounds == 1 else
              f"Everyone speaks {discussion_rounds} times, in a new random order each time. ")
    rules = RULES.format(size=size, loyalists=ROLE_COUNTS[size][0], conspirators=ROLE_COUNTS[size][1],
                         powers=powers, power_rules=power_rules, debate=debate)
    return f"Your name is {name}. {rules}\n\n{you} {GOALS[role]}"


def laws(hand):
    return ", ".join(law.capitalize() for law in hand)


def message_text(answer):
    """What a player says: the <say> content without tags, capped; None when there is no <say>.
    Never the rest of the answer: a model that forgets the tag would publish its private reasoning."""
    said = tag(answer, "say")
    return None if said is None else " ".join(re.sub(r"<[^>]*>", "", said).split())[:MESSAGE_CHARS]


class Senate:

    def __init__(self, config, game_dir, log):
        self.log = log
        self.rng = random.Random(config["seed"])  # deck and speaking order; mocks use the global random
        players = config["players"]
        self.seats = [player["name"] for player in players]
        self.roles = {player["name"]: player["role"] for player in players}
        self.agents = {p["name"]: Agent(p["name"], p["llm_config"], game_dir) for p in players}
        self.discussion_rounds = config["discussion_rounds"]
        self.system = {name: system_prompt(name, self.roles, self.seats, self.discussion_rounds)
                       for name in self.seats}
        self.first_consul = config["first_consul"]
        self.alive = list(self.seats)  # in seat order
        self.draw_pile = self.rng.sample(DECK, len(DECK))  # top first
        self.discard_pile = []
        self.enacted = Counter()
        self.tracker = 0
        self.last_consul = self.last_prefect = None  # the term limits
        self.investigated = set()
        self.transcript = []  # (round, is debate, line): one line per public event, shown to everyone
        self.notes = {name: [] for name in self.seats}  # what only that player saw
        self.n = 0

    def run(self):
        rotation = special = None
        while True:  # ends with GameOver: every round enacts a law or moves the tracker
            self.n += 1
            if special:  # the order then goes on from whoever called the special election
                consul, special = special, None
            else:
                consul = rotation = self.first_consul if rotation is None else self.next_alive(rotation)
            special = self.play_round(consul)

    def next_alive(self, name):
        i = self.seats.index(name)
        return next(seat for seat in self.seats[i + 1:] + self.seats[:i] if seat in self.alive)

    def play_round(self, consul):
        """One round. Returns the Consul a special election named, else None."""
        self.emit("round", f"Round {self.n}: {consul} is Consul.", n=self.n, consul=consul,
                  tracker=self.tracker, draw_pile=len(self.draw_pile), discard_pile=len(self.discard_pile))
        limited = {consul, self.last_prefect}
        if len(self.alive) > CONSUL_TERM_LIMIT_ABOVE:
            limited.add(self.last_consul)
        prefect = self.decide(consul, "You are the Consul: nominate a Prefect.",
                              [p for p in self.alive if p not in limited], "nominate")
        self.emit("nominate", f"{consul} nominated {prefect} as Prefect.", consul=consul, prefect=prefect)
        for k in range(self.discussion_rounds):
            self.discuss("debate", self.rng.sample(self.alive, len(self.alive)),
                         f"Debate before the vote on Consul {consul} with Prefect {prefect} "
                         f"(turn {k + 1} of {self.discussion_rounds}).")
        # simultaneous by rule, so asked in parallel; map keeps seat order and re-raises Stopped
        with ThreadPoolExecutor(len(self.alive)) as pool:
            answers = pool.map(lambda voter: self.decide(
                voter, f"Vote on the government: Consul {consul}, Prefect {prefect}.", [AYE, NAY], "vote"),
                self.alive)
            votes = {voter: answer == AYE for voter, answer in zip(self.alive, answers)}
        for voter, aye in votes.items():
            self.emit("vote", voter=voter, aye=aye)
        ayes = [voter for voter, aye in votes.items() if aye]
        nays = [voter for voter, aye in votes.items() if not aye]
        passed = len(ayes) > len(nays)
        if not passed:  # a passed vote leaves the tracker alone: only an enacted law resets it
            self.tracker += 1
        self.emit("vote_result", f"Vote: Aye {', '.join(ayes) or 'none'}; Nay {', '.join(nays) or 'none'}. "
                                 + ("Elected." if passed else f"Failed: tracker {self.tracker}/{CHAOS_AT}."),
                  passed=passed, ayes=len(ayes), nays=len(nays), tracker=self.tracker)
        if not passed:
            self.chaos_if_due()
            return None
        self.last_consul, self.last_prefect = consul, prefect
        if self.enacted[DECREE] >= USURPER_ELECTED_AFTER and self.roles[prefect] == USURPER:
            raise GameOver(CONSPIRACY, "usurper_elected")
        return self.legislate(consul, prefect)

    def legislate(self, consul, prefect):
        self.reshuffle_if_low()
        drawn, self.draw_pile = self.draw_pile[:HAND], self.draw_pile[HAND:]
        self.emit("draw", consul=consul, laws=drawn, spoiler=True)
        dropped = self.decide(consul, f"You are the Consul and drew {laws(drawn)}. Choose the law to "
                                      f"discard; {prefect} (Prefect) gets the other two.",
                              sorted(set(drawn)), "discard")
        hand = list(drawn)
        hand.remove(dropped)
        self.discard(consul, dropped)
        self.note(consul, f"as Consul you drew {laws(drawn)}, discarded a {dropped.capitalize()} "
                          f"and passed {laws(hand)} to {prefect}.")
        self.note(prefect, f"as Prefect you got {laws(hand)} from {consul}.")
        if self.enacted[DECREE] == VETO_AFTER and self.decide(
                prefect, f"You are the Prefect and hold {laws(hand)}. Propose a veto? If {consul} "
                         f"accepts, both laws are discarded and the tracker moves up by 1.",
                [AYE, NAY], "veto") == AYE:
            accepted = self.decide(consul, f"{prefect} (Prefect) proposes to veto the 2 laws you passed. "
                                           f"Accept? Both are then discarded and the tracker moves up by 1.",
                                   [AYE, NAY], "veto_reply") == AYE
            if accepted:
                self.tracker += 1
            self.emit("veto", f"{prefect} proposed a veto; {consul} "
                              + ("accepted: both laws were discarded." if accepted else "refused."),
                      prefect=prefect, consul=consul, accepted=accepted, tracker=self.tracker)
            if accepted:
                self.discard_pile += hand  # no discard events: the veto event says so
                self.chaos_if_due()
                return None
        law = self.decide(prefect, f"You are the Prefect and hold {laws(hand)}. Choose the law to "
                                   f"enact; the other is discarded.", sorted(set(hand)), "enact")
        hand.remove(law)
        self.discard(prefect, hand[0])
        self.note(prefect, f"you enacted a {law.capitalize()} and discarded a {hand[0].capitalize()}.")
        self.enact(law, prefect)
        special = self.use_power(consul) if law == DECREE else None
        others = [p for p in self.alive if p not in (consul, prefect)]
        self.discuss("report", [consul, prefect] + self.rng.sample(others, len(others)),
                     f"{prefect} has enacted a {law.capitalize()}. Everyone speaks once; the Consul "
                     f"and the Prefect usually say which laws they saw, truthfully or not.")
        return special

    def use_power(self, consul):
        """The power for the decree count just reached. Returns a special election's Consul."""
        kind = POWERS[len(self.seats)].get(self.enacted[DECREE])
        if kind == PEEK:
            self.emit("power", f"{consul} peeked at the top 3 laws of the deck.", kind=PEEK, by=consul)
            self.reshuffle_if_low()
            top = self.draw_pile[:HAND]
            self.emit("power_result", kind=PEEK, by=consul, result=top, spoiler=True)
            self.note(consul, f"you peeked: the top 3 laws of the deck are {laws(top)}.")
            return None
        targets = [p for p in self.alive if p != consul and not (kind == INVESTIGATE and p in self.investigated)]
        if kind is None or not targets:
            return None
        target = self.decide(consul, POWER_ASKS[kind], targets, "execute" if kind == EXECUTION else kind)
        self.emit("power", POWER_LINES[kind].format(by=consul, target=target), kind=kind, by=consul,
                  target=target)
        if kind == INVESTIGATE:
            self.investigated.add(target)
            side = LOYALIST if self.roles[target] == LOYALIST else CONSPIRACY
            self.emit("power_result", kind=kind, by=consul, target=target, result=side, spoiler=True)
            self.note(consul, f"you investigated {target}: {side}.")
        elif kind == EXECUTION:
            self.alive.remove(target)
            self.emit("executed", name=target)
            if self.roles[target] == USURPER:
                raise GameOver(LOYALISTS, "usurper_executed")
        elif kind == SPECIAL_ELECTION:
            return target
        return None

    def chaos_if_due(self):
        if self.tracker < CHAOS_AT:
            return
        self.reshuffle_if_low()
        self.last_consul = self.last_prefect = None
        self.enact(self.draw_pile.pop(0), CHAOS)

    def enact(self, law, by):
        self.tracker = 0  # any enacted law, chaos included
        self.enacted[law] += 1
        reforms, decrees = self.enacted[REFORM], self.enacted[DECREE]
        who = "Three failed elections: the top law of the deck" if by == CHAOS else by
        self.emit("enact", f"{who} enacted a {law.capitalize()}. Reforms {reforms}/{REFORMS_TO_WIN}, "
                           f"Decrees {decrees}/{DECREES_TO_WIN}.",
                  law=law, by=by, reforms=reforms, decrees=decrees, tracker=self.tracker)
        if reforms == REFORMS_TO_WIN:
            raise GameOver(LOYALISTS, "reforms")
        if decrees == DECREES_TO_WIN:
            raise GameOver(CONSPIRACY, "decrees")

    def reshuffle_if_low(self):
        if len(self.draw_pile) < HAND:
            self.draw_pile += self.discard_pile
            self.discard_pile = []
            self.rng.shuffle(self.draw_pile)
            self.emit("reshuffle", f"The discards were shuffled back into the deck ({len(self.draw_pile)} laws).",
                      draw_pile=len(self.draw_pile))

    def discard(self, by, law):
        self.discard_pile.append(law)
        self.emit("discard", by=by, law=law, spoiler=True)

    def emit(self, type, line=None, **fields):
        """An event, and its line in the public record (spoilers have none)."""
        self.log.emit(type, **fields)
        if line:
            self.transcript.append((self.n, fields.get("stage") == "debate", line))

    def note(self, name, text):
        self.notes[name].append(f"Round {self.n}: {text}")

    def prompt(self, name, task):
        # ponytail: every report claim stays (at most 9 laws' worth); trim old ones too if prompts grow
        oldest = self.n - DEBATE_ROUNDS_KEPT + 1
        record = "\n".join(line for n, debate, line in self.transcript if not debate or n >= oldest)
        header = f"Public record (debate before round {oldest} left out)" if oldest > 1 else "Public record"
        notes = "\n".join(self.notes[name]) or "(none)"
        return (f"{header}:\n{record or '(nothing yet)'}\n\nYour private notes:\n{notes}\n\n"
                f"Now, round {self.n}: Reforms {self.enacted[REFORM]}/{REFORMS_TO_WIN}, Decrees "
                f"{self.enacted[DECREE]}/{DECREES_TO_WIN}, tracker {self.tracker}/{CHAOS_AT}, deck "
                f"{len(self.draw_pile)}, discards {len(self.discard_pile)}. Living players in seat "
                f"order: {', '.join(self.alive)}. You are {name}.\n{task}")

    def decide(self, name, question, options, kind):
        if len(options) == 1:  # nothing to decide: no call
            return options[0]
        return choose(self.agents[name], self.system[name], self.prompt(name, question), options, kind)[0]

    def discuss(self, stage, order, situation):
        for name in order:
            if name not in self.alive:  # an executed Prefect skips the report
                continue
            agent, prompt = self.agents[name], self.prompt(name, situation + SAY)
            others = [p for p in self.alive if p != name]
            mock = lambda: f"<say>{random.choice(MOCK_LINES).format(name=random.choice(others))}</say>"
            answer = agent.ask(self.system[name], prompt, stage, mock)
            text = message_text(answer)
            if text is None:  # no <say>: ask once more, then the seat stays silent this turn
                answer = agent.ask(self.system[name], prompt + SAY_AGAIN, stage, mock)
                text = message_text(answer)
            if text is None:
                agent.logger.log_call(f"invalid:{stage}", "", f"no <say> in: {answer!r}")
            if text:
                self.emit("message", f"{name}: {text}", name=name, text=text, stage=stage)
