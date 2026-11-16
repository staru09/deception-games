"""
Offline stand-in for a model, with the same generate() interface as LLMWrapper: random
scheduling decisions, canned chat lines and random votes. It never touches the network, so
a whole game can be played (and the viewer tested) without a single API call.
"""
import random
import time

from game_constants import REMAINING_PLAYERS_FILE
from llm_players.llm_constants import PASS_TURN_TOKEN_KEY, USE_TURN_TOKEN_KEY

MOCK_LATENCY_KEY = "mock_latency_seconds"  # average pretend API latency, 0 for fast tests
MOCK_TALK_PROBABILITY_KEY = "mock_talk_probability"
MOCK_LINES = [
    "i think {name} is sus", "{name} has been way too quiet", "why is {name} so defensive",
    "no way its {name}", "i trust {name} for now", "{name} what do you think",
    "that vote from {name} made no sense", "we need to look at who voted with {name}",
    "honestly i have no idea yet", "can everyone say who they suspect", "this is going nowhere",
    "im just a villager trying to help", "lets not rush the vote", "ok that changes things",
    "someone here is lying", "agree with that", "wait what", "{name} you are deflecting",
]


class MockLLM:

    def __init__(self, logger, **llm_config):
        self.logger = logger
        self.pass_turn_token = llm_config[PASS_TURN_TOKEN_KEY]
        self.use_turn_token = llm_config[USE_TURN_TOKEN_KEY]
        self.latency = llm_config.get(MOCK_LATENCY_KEY, 1.0)
        self.talk_probability = llm_config.get(MOCK_TALK_PROBABILITY_KEY, 0.3)

    def generate(self, input_text, system_info="", generation_parameters=None, kind=""):
        time.sleep(random.uniform(0.5, 1.5) * self.latency)
        if kind == "schedule":
            is_talking = random.random() < self.talk_probability
            output = self.use_turn_token if is_talking else self.pass_turn_token
        elif kind == "vote":
            # the candidates are the comma separated list that ends the task (see get_vote),
            # which is the second line from the end of the prompt
            output = random.choice(input_text.strip().splitlines()[-2].rsplit(": ", 1)[-1]
                                   .split(", "))
        else:
            my_name = system_info.removeprefix("Your name is ").split(".")[0]
            remaining = (self.logger.game_dir / REMAINING_PLAYERS_FILE).read_text().splitlines()
            others = [name for name in remaining if name != my_name] or remaining
            output = random.choice(MOCK_LINES).format(name=random.choice(others))
        self.logger.log_call(kind, output, f"[mock] no model was called for this {kind}")
        return output
