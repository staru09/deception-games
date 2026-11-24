"""
Results per model for the arena games (see arena/run.py).

    python analyze_arena.py senate [games_dir]      (default: ./senate_games or $SENATE_GAMES_DIR)
    python analyze_arena.py poker [games_dir]       (default: ./poker_games or $POKER_GAMES_DIR)

Only finished games count (events.jsonl ends with game_over). Both write seats.csv into the games
dir: one row per seat, with its model calls, invalid answers (kind "invalid:...", see
arena/decide.py) and cost.

Senate prints each model's win rate as each team, and how those wins came about.
Poker prints each model's bb/100. Duplicate pairs (same cards, seats swapped) are summed into
one result per pair first, which cancels most of the card luck; the ± is 1.96 standard errors
over the pairs (over single games for unpaired matches).
"""
import json
import sys
from pathlib import Path

import pandas as pd

from arena.run import data_dir


def finished_games(games_dir):
    for game_dir in sorted(path for path in games_dir.iterdir() if (path / "events.jsonl").exists()):
        events = [json.loads(line) for line in (game_dir / "events.jsonl").read_text().splitlines()]
        if events and events[-1]["type"] == "game_over":
            yield game_dir, json.loads((game_dir / "config.json").read_text()), events


def seat_usage(game_dir, name):
    calls = [json.loads(line) for line in (game_dir / f"{name}_reasoning.jsonl").read_text().splitlines()] \
        if (game_dir / f"{name}_reasoning.jsonl").exists() else []
    invalid = sum(call["kind"].startswith("invalid:") for call in calls)
    return {"calls": len(calls) - invalid, "invalid": invalid,
            "cost": sum((call.get("usage") or {}).get("cost") or 0 for call in calls)}


def senate(games_dir):
    rows = []
    for game_dir, config, events in finished_games(games_dir):
        over = events[-1]
        for player in config["players"]:
            team = "loyalists" if player["role"] == "loyalist" else "conspiracy"
            rows.append({"game": game_dir.name, "name": player["name"], "model": player["model"],
                         "role": player["role"], "team": team, "won": team == over["winner"],
                         "reason": over["reason"], **seat_usage(game_dir, player["name"])})
    seats = pd.DataFrame(rows)
    if seats.empty:
        return seats
    # a team's seats share one result, so count each model once per game and team
    played = seats.drop_duplicates(["game", "model", "team"])
    summary = played.groupby(["model", "team"]).agg(games=("won", "size"), win_rate=("won", "mean"))
    reasons = pd.crosstab([played["model"], played["team"]],
                          played["reason"].where(played["won"]).fillna("(lost)"))
    print(f"{seats['game'].nunique()} finished Senate games in {games_dir}\n")
    print(summary.join(reasons).round(3).to_string())
    return seats


def poker(games_dir):
    rows = []
    for game_dir, config, events in finished_games(games_dir):
        hands = [event for event in events if event["type"] == "hand_end"]
        for player in config["players"]:
            rows.append({"game": game_dir.name, "pair": config.get("pair"), "name": player["name"],
                         "model": player["model"], "hands": len(hands), "big_blind": config["blinds"][1],
                         "chips": sum(hand["deltas"].get(player["name"], 0) for hand in hands),
                         **seat_usage(game_dir, player["name"])})
    seats = pd.DataFrame(rows)
    if seats.empty:
        return seats
    # one unit per complete duplicate pair (both games finished), else per game
    seats["unit"] = seats["game"]
    paired = seats.dropna(subset=["pair"])
    complete = paired.groupby("pair")["game"].nunique()
    is_complete = seats["pair"].isin(complete[complete == 2].index)
    seats.loc[is_complete, "unit"] = "pair " + seats.loc[is_complete, "pair"].astype(int).astype(str)
    units = seats.groupby(["unit", "model"]).agg(chips=("chips", "sum"), hands=("hands", "sum"),
                                                 big_blind=("big_blind", "first")).reset_index()
    units["bb_per_100"] = units["chips"] / units["big_blind"] / units["hands"] * 100
    summary = units.groupby("model").agg(units=("unit", "size"), hands=("hands", "sum"),
                                         chips=("chips", "sum"), bb_per_100_sd=("bb_per_100", "std"))
    summary["bb_per_100"] = summary["chips"] / units.groupby("model")["big_blind"].first() / summary["hands"] * 100
    summary["plus_minus"] = 1.96 * summary.pop("bb_per_100_sd") / summary["units"] ** 0.5
    print(f"{seats['game'].nunique()} finished Poker games in {games_dir} "
          f"({(complete == 2).sum()} complete duplicate pairs)\n")
    print(summary.round(2).to_string())
    return seats


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("senate", "poker"):
        sys.exit(__doc__)
    game = sys.argv[1]
    games_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else data_dir(game)
    seats = (senate if game == "senate" else poker)(games_dir)
    if seats.empty:
        sys.exit(f"No finished {game} games in {games_dir}")
    seats.to_csv(games_dir / "seats.csv", index=False)
    print(f"\nWrote {games_dir / 'seats.csv'}")


if __name__ == "__main__":
    main()
