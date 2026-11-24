"""Picking one legal option from a model's free-text answer."""
import random
import re


def tag(text, name):
    """The content of the last <name>...</name> in text, stripped, or None."""
    found = re.findall(rf"<{name}>(.*?)</{name}>", text or "", flags=re.DOTALL | re.IGNORECASE)
    return found[-1].strip() if found else None


def _norm(text):
    return " ".join(text.lower().replace('"', "").replace("'", "").split()).strip(" .!")


def match(answer, options):
    """The option the answer names: an exact match first, else the only option named as a whole
    word inside it. None when there is no clear match."""
    if answer is None:
        return None
    said = _norm(answer)
    for option in options:
        if _norm(option) == said:
            return option
    named = [option for option in options if re.search(rf"\b{re.escape(_norm(option))}\b", said)]
    return named[0] if len(named) == 1 else None


def choose(agent, system, prompt, options, kind):
    """Asks the agent to pick one of options (strings) inside <choice>...</choice>.
    Returns (option, answer): answer is the full text of the last reply, for <say> etc.
    No clear match: asks once more, then picks at random and logs the call as invalid."""
    options = list(options)
    rule = f"\n\nAnswer with exactly one of these inside <choice></choice>: {', '.join(options)}"
    mock = lambda: f"<choice>{random.choice(options)}</choice>"
    answer = agent.ask(system, prompt + rule, kind, mock)
    picked = match(tag(answer, "choice"), options)
    if picked is None:
        retry = (f"{prompt}{rule}\n\nYour last answer did not name one of the options. "
                 f"Reply again: <choice>one option, copied exactly</choice>")
        answer = agent.ask(system, retry, kind, mock)
        picked = match(tag(answer, "choice"), options)
    if picked is None:
        picked = random.choice(options)
        # analysis counts lines whose kind starts with "invalid:"
        agent.logger.log_call(f"invalid:{kind}", picked, f"no legal option in: {answer!r}")
    return picked, answer


if __name__ == "__main__":
    assert match("Alice", ["Ali", "Alice"]) == "Alice"
    assert match("I nominate Ali.", ["Ali", "Alice"]) == "Ali"
    assert match("ali or alice", ["Ali", "Alice"]) is None
    assert match(" AYE ", ["Aye", "Nay"]) == "Aye"
    assert match("raise 40", ["fold", "call", "raise 40"]) == "raise 40"
    assert match(None, ["x"]) is None
    assert tag("<say>a</say> x <say> b </say>", "say") == "b"
    assert tag("nothing", "choice") is None
    print("decide.py: ok")
