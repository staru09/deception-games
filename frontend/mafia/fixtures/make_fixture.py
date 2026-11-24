"""Writes the scripted demo game in fixtures/games/demo (no engine, no LLM calls).

    python make_fixture.py

7 seats (2 mafia, detective, doctor, 3 villagers) so that every viewer feature has data:
mafia night chat, a doctor save, a night kill, a detective hit, three day votes and a
town win. The file formats match what backend/mafia_main.py and run_autonomous.py write.
"""
import json
from pathlib import Path

OUT = Path(__file__).parent / "games"
GAME = OUT / "demo"
T0 = 1763200000.0  # fixed, so the fixture is byte-for-byte reproducible

SEATS = [  # (name, role, model)
    ("Riley", "villager", "openai/gpt-5-mini"),
    ("Morgan", "mafia", "anthropic/claude-opus-5.5"),
    ("Quinn", "detective", "google/gemini-3-pro"),
    ("Sage", "villager", "meta-llama/llama-3.3-70b-instruct"),
    ("Harper", "doctor", "openai/gpt-5"),
    ("Ziggy", "mafia", "x-ai/grok-4"),
    ("Eden", "villager", "mistralai/mistral-large"),
]

events = []
clock = [T0]


def emit(dt, type_, **data):
    clock[0] += dt
    events.append({"ts": round(clock[0], 3), "type": type_, **data})


def chat(phase, lines):
    for dt, name, text in lines:
        emit(dt, "message", name=name, text=text, phase=phase)


def vote(phase, round_, ballots):
    emit(4, "vote_open", phase=phase, round=round_)
    for dt, voter, target in ballots:
        emit(dt, "vote", voter=voter, target=target, phase=phase)


# ---- Day 1 ----
emit(0, "phase", phase="day", round=1, duration=60)
chat("day", [
    (3, "Sage", "hey all so who's acting weird already"),
    (2, "Ziggy", "too early to tell honestly"),
    (4, "Riley", "ziggy thats exactly what mafia would say lol"),
    (3, "Morgan", "riley jumping on people in the first ten seconds is pretty sus"),
    (5, "Quinn", "lets not tunnel yet, eden and harper havent said a word"),
    (4, "Eden", "im here just reading"),
    (3, "Harper", "same, i dont trust how fast morgan defended ziggy though"),
    (5, "Ziggy", "defended? morgan just called riley out"),
    (4, "Riley", "you two are very in sync"),
    (3, "Morgan", "or you are deflecting because you got caught pushing a fake read"),
    (5, "Sage", "riley has been the loudest and has said nothing useful"),
    (4, "Eden", "yeah riley feels off to me too"),
    (4, "Riley", "this is how town loses, voting the one person actually trying"),
    (5, "Quinn", "im not sold on riley but i dont have anything better"),
])
vote("day", 1, [(2, "Morgan", "Riley"), (1, "Ziggy", "Riley"), (2, "Sage", "Riley"),
                (1, "Eden", "Riley"), (3, "Riley", "Morgan"), (1, "Harper", "Morgan"),
                (2, "Quinn", "Ziggy")])
emit(1, "eliminated", name="Riley", role="villager", cause="vote")

# ---- Night 1: two mafia confer, the doctor saves their target, the detective finds Morgan ----
emit(2, "phase", phase="night", round=1, duration=30)
chat("night", [
    (4, "Morgan", "nice, that was clean"),
    (3, "Ziggy", "harper is onto us, she voted you"),
    (4, "Morgan", "killing harper is too obvious, take sage and keep blaming harper tomorrow"),
    (3, "Ziggy", "ok sage it is"),
])
vote("night", 1, [(2, "Morgan", "Sage"), (1, "Ziggy", "Sage")])
emit(2, "investigate", detective="Quinn", target="Morgan", is_mafia=True)
emit(1, "protect", doctor="Harper", target="Sage")
emit(1, "saved", name="Sage")

# ---- Day 2 ----
emit(2, "phase", phase="day", round=2, duration=60)
chat("day", [
    (3, "Eden", "wait nobody died??"),
    (3, "Harper", "doctor did their job, good"),
    (4, "Ziggy", "or mafia skipped the kill to confuse us"),
    (5, "Quinn", "ok i have to say it. i am the detective and i checked morgan last night. morgan is mafia"),
    (3, "Morgan", "lol what. quinn is making that up to save themselves"),
    (4, "Sage", "why would quinn fake claim on day 2 with no pressure on them"),
    (3, "Ziggy", "a real detective would stay hidden, this smells like a mafia gambit"),
    (5, "Harper", "ziggy is defending morgan again, same as yesterday"),
    (4, "Eden", "riley flipped villager and morgan led that vote. i believe quinn"),
    (4, "Morgan", "if you vote me you lose a villager and quinn wins"),
    (3, "Quinn", "vote morgan, and if im wrong vote me out tomorrow"),
])
vote("day", 2, [(1, "Quinn", "Morgan"), (2, "Harper", "Morgan"), (1, "Sage", "Morgan"),
                (2, "Eden", "Morgan"), (2, "Morgan", "Quinn"), (1, "Ziggy", "Quinn")])
emit(1, "eliminated", name="Morgan", role="mafia", cause="vote")

# ---- Night 2: one mafia left, so no discussion (duration 0) ----
emit(2, "phase", phase="night", round=2, duration=0)
vote("night", 2, [(3, "Ziggy", "Quinn")])
emit(2, "investigate", detective="Quinn", target="Eden", is_mafia=False)
emit(1, "protect", doctor="Harper", target="Harper")
emit(1, "eliminated", name="Quinn", role="detective", cause="night")

# ---- Day 3 ----
emit(2, "phase", phase="day", round=3, duration=60)
chat("day", [
    (3, "Sage", "they got quinn. so quinn was telling the truth"),
    (4, "Ziggy", "sad. ok so its between harper and eden, both were quiet day 1"),
    (4, "Harper", "ziggy you defended morgan twice and voted the real detective"),
    (3, "Eden", "yeah ziggy that vote on quinn looks terrible now"),
    (5, "Ziggy", "i thought quinn was faking, anyone could have"),
    (4, "Sage", "only one person kept shielding a confirmed mafia"),
    (3, "Harper", "im the doctor, i saved sage night 1. ziggy is the last one"),
    (4, "Ziggy", "convenient claim right when its down to four"),
])
vote("day", 3, [(2, "Harper", "Ziggy"), (1, "Sage", "Ziggy"), (2, "Eden", "Ziggy"),
                (2, "Ziggy", "Harper")])
emit(1, "eliminated", name="Ziggy", role="mafia", cause="vote")
emit(1, "game_over", winner="town")


def player_config(name, role, model):
    return {
        "name": name, "is_mafia": role == "mafia", "is_llm": True, "real_name": "",
        "special_role": "" if role == "mafia" else role,
        "llm_config": {"model_name": model, "use_openrouter": True,
                       "async_type": "schedule_then_generate", "let_others_open": False},
    }


REASONING = {
    "Morgan": [
        (9, "schedule", "<send>", "Riley accused Ziggy, my partner. If I stay silent the pair of "
            "us looks passive. Redirecting onto Riley's speed is cheap and plausible."),
        (12, "message", "riley jumping on people in the first ten seconds is pretty sus",
         "Frame Riley as reckless. Do not defend Ziggy by name, that links us."),
        (30, "schedule", "<wait>", "I have spoken twice in a row. Let Sage and Eden carry it."),
        (62, "vote", "Riley", "Riley is the consensus target and a villager. Voting with the "
            "crowd keeps me hidden."),
        (125, "message", "lol what. quinn is making that up to save themselves",
         "Quinn's claim is true. My only out is to make it a 1v1 credibility fight."),
    ],
    "Quinn": [
        (17, "schedule", "<send>", "Two players are silent. Naming them gets them to talk and "
            "gives me reads without exposing my role."),
        (88, "vote", "Morgan", "Morgan pushed hardest on Riley, who was innocent. Best target "
            "for tonight's investigation."),
        (118, "message", "ok i have to say it. i am the detective and i checked morgan last "
            "night. morgan is mafia",
         "Nobody died, so the doctor is alive and can protect me tonight. Claiming now is "
         "worth the risk because I have a confirmed mafia."),
    ],
    "Harper": [
        (86, "vote", "Sage", "Mafia will likely kill someone who voted with town but is not a "
            "power-role candidate. Sage led the Riley vote by accident and looks expendable."),
        (150, "vote", "Harper", "I cannot protect Sage twice in a row. Quinn is the obvious "
            "target, but if I die there are no more saves, so I cover myself."),
    ],
}


def main():
    GAME.mkdir(parents=True, exist_ok=True)
    (GAME / "events.jsonl").write_text(
        "".join(json.dumps(e) + "\n" for e in events), encoding="utf-8", newline="\n")
    config = {"players": [player_config(*seat) for seat in SEATS],
              "daytime_minutes": 1, "nighttime_minutes": 0.5}
    (GAME / "config.json").write_text(json.dumps(config, indent=4) + "\n", encoding="utf-8",
                                      newline="\n")
    for name, _, _ in SEATS:
        lines = [{"ts": T0 + dt, "kind": kind, "output": output, "reasoning": reasoning,
                  "usage": {"prompt_tokens": 900 + 40 * i, "completion_tokens": 30,
                            "cost": 0.0004}}
                 for i, (dt, kind, output, reasoning) in enumerate(REASONING.get(name, []))]
        (GAME / f"{name}_reasoning.jsonl").write_text(
            "".join(json.dumps(line) + "\n" for line in lines), encoding="utf-8", newline="\n")
    index = [{"id": "demo", "started": T0, "winner": "town",
              "models": sorted({model for _, _, model in SEATS})}]
    (OUT / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8",
                                    newline="\n")
    print(f"wrote {len(events)} events to {GAME}")


if __name__ == "__main__":
    main()
