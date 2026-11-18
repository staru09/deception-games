"""
Gives a finished game's moderator a voice afterwards: every narration line without audio gets a
Deepgram clip, exactly as in a game played with a voice, and the clip is linked into events.jsonl.

    python add_voice.py autonomous_games/0004 [--voice flux-hannah-en]

Needs DEEPGRAM_API_KEY. Only narration events change (they gain an "audio" field); the original
log is kept next to it as events.jsonl.bak.
"""
import argparse
import json
import os
import sys
from pathlib import Path

from game_constants import EVENTS_FILE
from moderator import Moderator, DEFAULT_VOICE, DEEPGRAM_API_KEY_KEYWORD, NARRATION_AUDIO_DIR


def main():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("game_dir")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="a Deepgram voice")
    args = parser.parse_args()
    game_dir = Path(args.game_dir)
    if not os.environ.get(DEEPGRAM_API_KEY_KEYWORD):
        sys.exit(f"{DEEPGRAM_API_KEY_KEYWORD} is not set")
    events_file = game_dir / EVENTS_FILE
    original = events_file.read_text()
    events = [json.loads(line) for line in original.splitlines()]
    if not events or events[-1]["type"] != "game_over":
        sys.exit(f"{game_dir} has not finished: its log may still grow, so it is left alone")
    speaker = Moderator(None, game_dir, voice=args.voice)  # only its voice is used
    clips_dir = game_dir / NARRATION_AUDIO_DIR
    speaker.num_clips = len(list(clips_dir.glob("*.mp3"))) if clips_dir.exists() else 0
    silent = [event for event in events if event["type"] == "narration" and not event.get("audio")]
    for event in silent:
        audio = speaker.speak(event["text"])
        if audio:
            event["audio"] = audio
    backup = events_file.with_name(EVENTS_FILE + ".bak")
    if not backup.exists():
        backup.write_text(original, newline="\n")
    temporary = events_file.with_name(EVENTS_FILE + ".tmp")  # the viewer must never read half a file
    temporary.write_text("".join(json.dumps(event) + "\n" for event in events), newline="\n")
    os.replace(temporary, events_file)
    voiced = sum(1 for event in silent if event.get("audio"))
    print(f"{game_dir}: {voiced} of {len(silent)} silent lines now have a voice"
          + ("" if voiced == len(silent) else f" (see {game_dir}/Moderator_log.txt)"))


if __name__ == "__main__":
    main()
