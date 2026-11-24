import json
from pathlib import Path
from game_constants import LLM_LOG_FILE_FORMAT, REASONING_FILE_FORMAT, get_current_timestamp, \
    game_time

NEW_LOG_FORMAT = "# NEW LOG\n## TIME: {time}\n## OPERATION: {operation}\n## CONTENT: {content}\n\n"


class Logger:

    def __init__(self, name: str, game_dir: Path):
        self.game_dir = game_dir
        self.log_file = game_dir / LLM_LOG_FILE_FORMAT.format(name)
        self.reasoning_file = game_dir / REASONING_FILE_FORMAT.format(name)

    def log(self, operation, content):
        with open(self.log_file, "a") as f:
            f.write(NEW_LOG_FORMAT.format(time=get_current_timestamp(),
                                          operation=operation, content=content))

    def log_call(self, kind, output, reasoning, usage=None):
        """One JSON line per LLM call: what it was for, what came out and the reasoning trace."""
        self.log(f"reasoning trace ({kind})", reasoning)
        with open(self.reasoning_file, "a") as f:
            f.write(json.dumps({"ts": game_time(), "kind": kind, "output": output,
                                "reasoning": reasoning, "usage": usage}) + "\n")
