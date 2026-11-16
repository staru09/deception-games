"""
The moderator: an LLM that narrates the game for spectators. It opens each day with an agenda,
calls the vote when the discussion time is up, sends the town to sleep and declares every result.

Its lines go only into events.jsonl, as "narration" events, and no player process reads that
file: the players play exactly as they would without a moderator. The game manager asks for a
line only while no discussion is running, so the moderator's latency never changes how long
the players get to talk. It is told only public facts (no hidden role, no night chat, no night
action) until the game is over, so a line cannot give the mafia away in the viewer's town view.
With the model "mock", or when a call fails, it says a fixed line instead.

With a voice, every line is also spoken: Deepgram's text-to-speech turns it into an mp3 in
the game's narration/ folder, and the viewer plays it. No voice, or a failed call, only means
the line has no audio.
"""
import os

import requests

from game_constants import PUBLIC_DAYTIME_CHAT_FILE
from llm_players.llm_constants import OPENROUTER_API_KEY_KEYWORD, MOCK_MODEL_NAME
from llm_players.logger import Logger
from llm_players.openrouter_llm import BASE_URL

MODERATOR_NAME = "Moderator"  # its log files are Moderator_log.txt and Moderator_reasoning.jsonl
DEFAULT_MODERATOR_MODEL = "anthropic/claude-haiku-5.5"
DEFAULT_VOICE = "flux-hannah-en"  # a Deepgram Flux TTS voice: flux-{voice}-{language}
DEEPGRAM_API_KEY_KEYWORD = "DEEPGRAM_API_KEY"  # read only from the environment
# overridable for selfcheck.py, which points it at a local fake server
DEEPGRAM_SPEAK_URL = os.environ.get("DEEPGRAM_SPEAK_URL", "https://api.deepgram.com/v2/speak")
NARRATION_AUDIO_DIR = "narration"  # inside the game dir
REQUEST_TIMEOUT = (5, 20)  # seconds; one attempt, then the fixed line, so a game never waits long
# Room for the reasoning that some models (Haiku 5.5 among them) do by default, which counts
# against this limit; a line that still gets cut off is replaced by the fixed line
MAX_TOKENS = 1000
RECENT_CHAT_LINES = 25  # of the public daytime chat, so the agenda can follow the discussion
# Only these moments see the chat. A result is announced from its facts alone: given the chat,
# which ends with the last day's votes, the model announced that vote instead of a night kill.
MOMENTS_WITH_CHAT = ("day_start", "vote_open")
SYSTEM_PROMPT = ("You are the moderator of an online game of Mafia played by AI players, and you "
                 "narrate it for spectators. Answer with 1 or 2 short, vivid sentences of plain "
                 "text, without markdown. Use only the facts given, and never guess or hint who "
                 "might be mafia.")
TASKS = {
    "day_start": "A new day begins. Open it: mention any news from the night, then set the agenda "
                 "for today's discussion (what the town should try to work out).",
    "vote_open": "The discussion time is over. Stop the discussion and call everyone to vote.",
    "eliminated": "Declare exactly this result, and nothing about any other vote or night: "
                  "{name} is out of the game, {how}. Their role was {role}. Do not say whether "
                  "the game goes on: that is announced separately.",
    "saved": "Declare that nobody died last night.",
    "night_start": "Night falls. Send the town to sleep, and tell the mafia to wake up and choose "
                   "a victim.",
    "game_over": "The game is over. Declare the winner and reveal who the mafia were.",
    # the opening line of the game, for whichever phase comes first
    "first_night": "The game begins. Welcome the players and say in a few words how it goes: "
                   "each night the mafia choose a victim, the doctor protects someone and the "
                   "detective checks someone, and each day everyone discusses and votes. Then "
                   "night falls: send everyone to sleep.",
    "first_day": "The game begins with its first day; there has been no night yet. Welcome the "
                 "players, then set the agenda for today's discussion.",
    # the night's questions, asked in this order; never name who holds a role
    "ask_mafia": "Wake the mafia and ask them whom they want to kill tonight. Name no player.",
    "ask_doctor": "Wake the doctor and ask whom they want to save tonight. Name no player.",
    "ask_detective": "Wake the detective and ask which player they are doubtful about, so you can "
                     "secretly tell them whether that player is mafia. Name no player.",
}
FALLBACK_LINES = {  # formatted with the same facts the model gets
    "day_start": "Day {round} begins. Talk it through and find the mafia.",
    "vote_open": "Time is up! Stop the discussion and cast your votes.",
    "eliminated": "{name} is out of the game, {how}. Their role: {role}.",
    "saved": "Dawn breaks, and nobody died last night.",
    "night_start": "Night falls. The town sleeps while the mafia choose a victim.",
    "game_over": "The game is over and the {winner} win. The mafia were: {mafia}.",
    "first_night": "Welcome to the village! Every night the mafia strike, the doctor protects and "
                   "the detective investigates; every day the town debates and votes. Now night "
                   "falls: everyone, close your eyes.",
    "first_day": "Welcome to the village! Day {round} begins. Talk it through and find the mafia.",
    "ask_mafia": "Mafia, wake up. Whom do you want to kill tonight?",
    "ask_doctor": "Doctor, wake up. Whom do you want to save tonight?",
    "ask_detective": "Detective, wake up. Which player are you doubtful about?",
}


class Moderator:

    def __init__(self, model, game_dir, voice=None):
        self.model = model
        self.game_dir = game_dir
        self.voice = voice
        self.logger = Logger(MODERATOR_NAME, game_dir)
        self.api_key = os.environ.get(OPENROUTER_API_KEY_KEYWORD)
        self.deepgram_key = os.environ.get(DEEPGRAM_API_KEY_KEYWORD)
        self.num_clips = 0

    def narrate(self, moment, **facts):
        """
        (line, audio) for `moment` (a key of TASKS): audio is the clip's path in the game dir,
        or None. Never raises: a failed model call gives the fixed line, a failed voice no audio.
        """
        text = self.write_line(moment, **facts)
        return text, self.speak(text)

    def speak(self, text):
        if not self.voice or not self.deepgram_key:
            return None
        self.num_clips += 1
        path = f"{NARRATION_AUDIO_DIR}/{self.num_clips:03d}.mp3"
        try:
            response = requests.post(
                DEEPGRAM_SPEAK_URL, params={"model": self.voice, "encoding": "mp3"},
                headers={"Authorization": f"Token {self.deepgram_key}"}, json={"text": text},
                timeout=REQUEST_TIMEOUT)
            response.raise_for_status()
            (self.game_dir / NARRATION_AUDIO_DIR).mkdir(exist_ok=True)
            (self.game_dir / path).write_bytes(response.content)
        except Exception as e:
            detail = e.response.text[:300] if isinstance(e, requests.HTTPError) else ""
            self.logger.log("voice error", f"{e!r} {detail}")
            return None
        return path

    def write_line(self, moment, **facts):
        fallback = FALLBACK_LINES[moment].format(**facts)
        if self.model == MOCK_MODEL_NAME or not self.api_key:
            return fallback
        prompt = "Facts:\n" + "".join(f"- {key.replace('_', ' ')}: {value}\n"
                                      for key, value in facts.items())
        if moment in MOMENTS_WITH_CHAT:
            recent_chat = (self.game_dir / PUBLIC_DAYTIME_CHAT_FILE).read_text().splitlines()
            if recent_chat:
                prompt += ("Latest public chat:\n" + "\n".join(recent_chat[-RECENT_CHAT_LINES:])
                           + "\n")
        prompt += TASKS[moment].format(**facts)
        try:
            response = requests.post(
                f"{BASE_URL}/chat/completions", timeout=REQUEST_TIMEOUT,
                headers={"Authorization": f"Bearer {self.api_key}", "X-Title": "LLMafia"},
                json={"model": self.model, "max_tokens": MAX_TOKENS, "usage": {"include": True},
                      "messages": [{"role": "system", "content": SYSTEM_PROMPT},
                                   {"role": "user", "content": prompt}]})
            data = response.json()
            choice = data["choices"][0]
            text = " ".join((choice["message"].get("content") or "").split())
        except Exception as e:  # an error status has no "choices": that lands here too
            self.logger.log(f"moderator error ({moment})", repr(e))
            return fallback
        self.logger.log_call(moment, text, choice["message"].get("reasoning") or "",
                             data.get("usage"))
        if choice.get("finish_reason") == "length":  # cut off mid-sentence
            self.logger.log(f"moderator line cut off ({moment})", text)
            return fallback
        return text or fallback
