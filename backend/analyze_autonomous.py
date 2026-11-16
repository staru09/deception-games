"""
Win rates per model for the autonomous games (see run_autonomous.py).

    python analyze_autonomous.py [games_dir]        (default: ./autonomous_games)

Writes seats.csv (one row per seat) and games.csv (one row per game) into the games dir.
A seat wins like in the paper: did_win = (mafia won) == is_mafia. Elo ratings come from
configurations/model_elo.json ({"<model id>": <elo>}); they are used only here, so they
can be updated without replaying anything.
"""
import json
import sys
from collections import Counter
from pathlib import Path

import pandas as pd

from game_constants import EVENTS_FILE, GAME_CONFIG_FILE, WHO_WINS_FILE, MAFIA_WINS_MESSAGE, \
    PLAYERS_KEY_IN_CONFIG, get_role_string
from llm_players.llm_constants import LLM_CONFIG_KEY, MODEL_NAME_KEY

ELO_FILE = Path(__file__).resolve().parent / "configurations" / "model_elo.json"


def load_finished_games(games_dir, elo):
    seat_rows, game_rows = [], []
    for game_dir in sorted(path for path in games_dir.iterdir() if (path / EVENTS_FILE).exists()):
        events = [json.loads(line) for line in (game_dir / EVENTS_FILE).read_text().splitlines()]
        if not events or events[-1]["type"] != "game_over":
            continue  # still running, or aborted
        winner = events[-1]["winner"]
        is_mafia_win = MAFIA_WINS_MESSAGE in (game_dir / WHO_WINS_FILE).read_text()
        assert (winner == "mafia") == is_mafia_win, f"{game_dir}: event log and result disagree"
        players = json.loads((game_dir / GAME_CONFIG_FILE).read_text())[PLAYERS_KEY_IN_CONFIG]
        eliminated = {event["name"] for event in events if event["type"] == "eliminated"}
        num_messages = Counter(event["name"] for event in events if event["type"] == "message")
        seats = [{"game": game_dir.name, "name": player["name"],
                  "model": player[LLM_CONFIG_KEY][MODEL_NAME_KEY],
                  "elo": elo.get(player[LLM_CONFIG_KEY][MODEL_NAME_KEY]),
                  "role": get_role_string(player["is_mafia"], player.get("special_role", "")),
                  "team": "mafia" if player["is_mafia"] else "town",
                  "won": is_mafia_win == player["is_mafia"],
                  "survived": player["name"] not in eliminated,
                  "messages": num_messages[player["name"]]} for player in players]
        assert len({seat["team"] for seat in seats if seat["won"]}) == 1, f"{game_dir}: two winners"
        seat_rows += seats
        teams = pd.DataFrame(seats).groupby("team")
        mean_elo = teams["elo"].mean()  # NaN when a team has no rated model
        game_rows.append({"game": game_dir.name,
                          "mafia_models": " ".join(sorted(teams.get_group("mafia")["model"])),
                          "town_models": " ".join(sorted(teams.get_group("town")["model"])),
                          "mafia_elo": mean_elo["mafia"], "town_elo": mean_elo["town"],
                          "elo_gap": mean_elo["mafia"] - mean_elo["town"],
                          "mafia_won": is_mafia_win,
                          "rounds": max(event.get("round", 0) for event in events)})
    return pd.DataFrame(seat_rows), pd.DataFrame(game_rows)


def main():
    games_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "./autonomous_games")
    elo = json.loads(ELO_FILE.read_text())
    seats, games = load_finished_games(games_dir, elo)
    if seats.empty:
        sys.exit(f"No finished games in {games_dir}")
    seats.to_csv(games_dir / "seats.csv", index=False)
    games.to_csv(games_dir / "games.csv", index=False)
    win_rates = seats.groupby("model").agg(elo=("elo", "first"), seats=("won", "size"),
                                           win_rate=("won", "mean"))
    for team in ("mafia", "town"):
        of_team = seats[seats["team"] == team].groupby("model")["won"]
        win_rates[f"as_{team}"] = of_team.mean()
        win_rates[f"n_{team}"] = of_team.size()
    win_rates = win_rates.sort_values("elo", ascending=False, na_position="last")
    print(f"{len(games)} finished games in {games_dir}, the mafia won {games['mafia_won'].mean():.0%}\n")
    print(win_rates.round(3).to_string())
    unrated = sorted(set(seats["model"]) - set(elo))
    if unrated:
        print(f"\nNo Elo in {ELO_FILE.name} for: {', '.join(unrated)}")
    print(f"\nWrote {games_dir / 'seats.csv'} and {games_dir / 'games.csv'}")


if __name__ == "__main__":
    main()
