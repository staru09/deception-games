"""events.jsonl: one JSON object per line, {"ts", "type", ...}, the same shape as Mafia's."""
import json
import time


class EventLog:

    def __init__(self, path):
        self.path = path

    def emit(self, type, **fields):
        # one write per line, flushed at once: the viewer polls this file while the game runs
        with open(self.path, "a") as f:
            f.write(json.dumps({"ts": time.time(), "type": type, **fields}) + "\n")
