"""The smallest arena game, to prove the core: everyone guesses a coin flip, first to 3 wins.
    python -m arena.run mock configurations/arena_mock.json"""
import random

from arena.agent import Agent, llm_config_for, model_problem
from arena.decide import choose, tag
from game_constants import OPTIONAL_CODE_NAMES


def validate(table):
    seats = table.get("players", [])
    problems = [] if 2 <= len(seats) <= 6 else [f"the mock game needs 2 to 6 players, got {len(seats)}"]
    return problems + [problem for i, seat in enumerate(seats) if (problem := model_problem(seat, i))]


def make_configs(table, n):
    seats = table["players"]
    return [{"players": [{"name": name, "model": seat["model"], "llm_config": llm_config_for(seat, table)}
                         for name, seat in zip(random.sample(OPTIONAL_CODE_NAMES, len(seats)), seats)]}
            for _ in range(n)]


def play(config, game_dir, log):
    agents = [Agent(p["name"], p["llm_config"], game_dir) for p in config["players"]]
    score = dict.fromkeys((agent.name for agent in agents), 0)
    for n in range(1, 100):
        coin = random.choice(["heads", "tails"])
        log.emit("round", n=n)
        for agent in agents:
            guess, answer = choose(agent, "You are playing a coin-guessing game.",
                                   f"Round {n}. Scores: {score}. Guess the coin, and add a <say>short line</say>.",
                                   ["heads", "tails"], "guess")
            log.emit("message", name=agent.name, text=tag(answer, "say") or guess)
            score[agent.name] += guess == coin
        log.emit("flip", coin=coin, score=dict(score))
        if max(score.values()) >= 3:
            winner = max(score, key=score.get)
            log.emit("game_over", winner=winner, reason="first to 3")
            return winner
