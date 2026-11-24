"""Hold'em hand evaluation: the best five of seven cards, as a tuple that compares with < and ==.
Cards are 2-character strings: rank "23456789TJQKA" + suit "shdc" ("As", "Td")."""
from collections import Counter
from itertools import combinations

RANKS = "23456789TJQKA"
CATEGORIES = ["high card", "pair", "two pair", "three of a kind", "straight", "flush",
              "full house", "four of a kind", "straight flush"]
WORDS = {14: "ace", 13: "king", 12: "queen", 11: "jack", 10: "ten", 9: "nine", 8: "eight",
         7: "seven", 6: "six", 5: "five", 4: "four", 3: "three", 2: "two"}


def rank5(cards):
    """(category 0-8, tie-breakers...) of exactly five cards."""
    values = sorted((RANKS.index(c[0]) + 2 for c in cards), reverse=True)
    counts = Counter(values)
    # groups by count, then by rank: the tie-breakers of paired hands
    ordered = sorted(counts, key=lambda v: (counts[v], v), reverse=True)
    shape = sorted(counts.values(), reverse=True)
    flush = len({c[1] for c in cards}) == 1
    straight_high = 0
    if len(counts) == 5:
        if values[0] - values[4] == 4:
            straight_high = values[0]
        elif values == [14, 5, 4, 3, 2]:
            straight_high = 5  # the wheel: the ace plays low
    if straight_high and flush:
        return (8, straight_high)
    if shape == [4, 1]:
        return (7, *ordered)
    if shape == [3, 2]:
        return (6, *ordered)
    if flush:
        return (5, *values)
    if straight_high:
        return (4, straight_high)
    return ({(3, 1, 1): 3, (2, 2, 1): 2, (2, 1, 1, 1): 1}.get(tuple(shape), 0), *ordered)


def best_hand(cards):
    """(rank, the best five cards) among all five-card combinations of 5 to 7 cards."""
    return max(((rank5(five), list(five)) for five in combinations(cards, 5)), key=lambda x: x[0])


def _plural(value):
    return WORDS[value] + ("es" if value == 6 else "s")


def hand_name(rank):
    category, *v = rank
    if category == 8 and v[0] == 14:
        return "royal flush"
    return {
        0: lambda: f"high card, {WORDS[v[0]]} high",
        1: lambda: f"pair of {_plural(v[0])}",
        2: lambda: f"two pair, {_plural(v[0])} and {_plural(v[1])}",
        3: lambda: f"three of a kind, {_plural(v[0])}",
        4: lambda: f"straight, {WORDS[v[0]]} high",
        5: lambda: f"flush, {WORDS[v[0]]} high",
        6: lambda: f"full house, {_plural(v[0])} over {_plural(v[1])}",
        7: lambda: f"four of a kind, {_plural(v[0])}",
        8: lambda: f"straight flush, {WORDS[v[0]]} high",
    }[category]()
