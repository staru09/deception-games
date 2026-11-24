"""One seat of a turn-based arena game: a model behind OpenRouter, or an offline mock."""
import threading

from llm_players.llm_constants import MODEL_NAME_KEY, MOCK_MODEL_NAME
from llm_players.mock_llm import MOCK_LATENCY_KEY
from llm_players.logger import Logger
from llm_players.openrouter_llm import OpenRouterLLM

STOP = threading.Event()  # set by the launcher on Ctrl-C/SIGTERM: every game ends at its next call


class Stopped(Exception):
    pass


class Agent:

    def __init__(self, name, llm_config, game_dir):
        self.name = name
        self.model = llm_config[MODEL_NAME_KEY]
        # 0 by default so selfchecks run instantly; a table can slow mocks down to watch them live
        self.mock_latency = llm_config.get(MOCK_LATENCY_KEY, 0)
        self.logger = Logger(name, game_dir)  # <Name>_log.txt and <Name>_reasoning.jsonl, as in Mafia
        self.llm = None if self.is_mock else OpenRouterLLM(self.logger, **llm_config)

    @property
    def is_mock(self):
        return self.model == MOCK_MODEL_NAME

    def ask(self, system, prompt, kind, mock):
        """The model's answer. `mock` is a no-argument function giving what a mock seat answers
        (the game knows its legal moves); it is never called for a real model."""
        if STOP.is_set():
            raise Stopped("the launcher was stopped")
        if self.llm is None:
            if STOP.wait(self.mock_latency):
                raise Stopped("the launcher was stopped")
            output = mock()
            self.logger.log_call(kind, output, f"[mock] no model was called for this {kind}")
            return output
        return self.llm.generate(prompt, system, kind=kind)


def llm_config_for(seat, table):
    """A seat's llm_config: its model, the table's "llm_defaults", then the seat's other keys
    (temperature, max_tokens, reasoning, provider, ...), as in Mafia's run_autonomous.py."""
    extra = {key: value for key, value in seat.items() if key not in ("role", "model")}
    return {MODEL_NAME_KEY: seat["model"], **table.get("llm_defaults", {}), **extra}


def model_problem(seat, i):
    """None, or why seat i (0-based) has no usable model."""
    model = seat.get("model") if isinstance(seat, dict) else None
    if not isinstance(model, str) or not model or "<" in model:
        return f"player {i + 1} has no model (got {model!r}): set an OpenRouter model id, or \"{MOCK_MODEL_NAME}\""
    return None
