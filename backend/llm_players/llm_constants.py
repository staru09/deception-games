from game_constants import get_current_timestamp, RULES_OF_THE_GAME, strip_special_chars, \
    DETECTIVE_ROLE, DOCTOR_ROLE

MODEL_NAMES = [
    "meta-llama/Llama-3.3-70B-Instruct-Turbo-Free",
    "meta-llama/Llama-3.1-8B-Instruct",
    "microsoft/Phi-3-mini-4k-instruct"
]
DEFAULT_MODEL_NAME = MODEL_NAMES[0]

# prompts patterns:
INSTRUCTION_INPUT_RESPONSE_PATTERN = "instruction-input-response prompt pattern"
LLAMA3_PATTERN = "Llama 3 pattern"
DEFAULT_PROMPT_PATTERN = "default"

# pipeline formats:
TEXT_GENERATION_TASK = "text-generation"
TASK2OUTPUT_FORMAT = {TEXT_GENERATION_TASK: "generated_text"}

# text constants:
INITIAL_GENERATION_PROMPT = "Do you understand the rules?"
SPECIAL_TOKEN_FORMATS = ["<{}>", "[[{}]]", "{}"]
PASS_TURN_KEYWORD = ["wait", "pass", "quiet"]
PASS_TURN_TOKEN_OPTIONS = [pattern.format(keyword) for keyword in PASS_TURN_KEYWORD
                           for pattern in SPECIAL_TOKEN_FORMATS]
USE_TURN_KEYWORD = ["send", "speak", "use"]
USE_TURN_TOKEN_OPTIONS = [pattern.format(keyword) for keyword in USE_TURN_KEYWORD
                          for pattern in SPECIAL_TOKEN_FORMATS]
DEFAULT_PASS_TURN_TOKEN = PASS_TURN_TOKEN_OPTIONS[0]
DEFAULT_USE_TURN_TOKEN = USE_TURN_TOKEN_OPTIONS[0]
GENERAL_SYSTEM_INFO = f"You are a bot player in an online version of the party game Mafia. " \
                      f"You have an outgoing personality, and you like to participate in games, " \
                      f"but you also don't want everyone to have their eyes on you all the time." \
                      f"\nThe rules of the game: {RULES_OF_THE_GAME}"
# I removed the following because it didn't choose to wait: "You have a very outgoing personality"

# LLM players type names:
SCHEDULE_THEN_GENERATE_TYPE = "schedule_then_generate"
GENERATE_THEN_SCHEDULE_TYPE = "generate_then_schedule"
FINE_TUNED_TYPE = "fine_tuned"
EVERY_X_MESSAGES_TYPE = "every_x_messages"
ASYNC_TYPES = [SCHEDULE_THEN_GENERATE_TYPE, GENERATE_THEN_SCHEDULE_TYPE,
               FINE_TUNED_TYPE, EVERY_X_MESSAGES_TYPE]
DEFAULT_ASYNC_TYPE = ASYNC_TYPES[0]

# API keys and secrets
SECRETS_DICT_FILE_PATH = ".secrets_dict.txt"
TOGETHER_API_KEY_KEYWORD = "TOGETHER_API_KEY"
SLEEPING_TIME_FOR_API_GENERATION_ERROR = 3
OPENROUTER_API_KEY_KEYWORD = "OPENROUTER_API_KEY"  # read only from the environment

# config keys:
LLM_CONFIG_KEY = "llm_config"  # should match the key in PlayerConfig dataclass
GAME_DIR_KEY = "game_dir"  # should match key word in LLMPlayer
MODEL_NAME_KEY = "model_name"
USE_TOGETHER_KEY = "use_together"
USE_PIPELINE_KEY = "use_pipeline"
PIPELINE_TASK_KEY = "pipeline_task"
WORDS_PER_SECOND_WAITING_KEY = "num_words_per_second_to_wait"
PASS_TURN_TOKEN_KEY = "pass_turn_token"
USE_TURN_TOKEN_KEY = "use_turn_token"
ASYNC_TYPE_KEY = "async_type"
# autonomous games (all seats are LLMs, see run_autonomous.py):
USE_OPENROUTER_KEY = "use_openrouter"
USE_MOCK_KEY = "use_mock"  # offline stand-in for a model, for dry runs without API calls
MOCK_MODEL_NAME = "mock"
REASONING_KEY = "reasoning"  # OpenRouter reasoning options, e.g. {"effort": "low"}
PROVIDER_KEY = "provider"  # OpenRouter provider routing options
LET_OTHERS_OPEN_KEY = "let_others_open"  # False when no human is there to speak first
OPENING_JITTER_KEY = "opening_jitter_seconds"
VOTE_DELAY_KEY = "vote_delay_seconds"
SECONDS_BETWEEN_TURNS_KEY = "seconds_between_turns"  # pause after each turn: the cost knob
# generation hyper parameters:
MAX_NEW_TOKENS_KEY = "max_new_tokens"
NUM_BEAMS_KEY = "num_beams"
REPETITION_PENALTY_KEY = "repetition_penalty"
DO_SAMPLE_KEY = "do_sample"
TEMPERATURE_KEY = "temperature"
NO_REPEAT_NGRAM_KEY = "no_repeat_ngram_size"
MAX_TOKENS_KEY = "max_tokens"
HUGGINGFACE_GENERATION_PARAMETERS = [MAX_NEW_TOKENS_KEY, NUM_BEAMS_KEY, REPETITION_PENALTY_KEY,
                                     DO_SAMPLE_KEY, TEMPERATURE_KEY, NO_REPEAT_NGRAM_KEY]
TOGETHER_GENERATION_PARAMETERS = [MAX_TOKENS_KEY, REPETITION_PENALTY_KEY]
# GENERATION_PARAMETERS = HUGGINGFACE_GENERATION_PARAMETERS
GENERATION_PARAMETERS = TOGETHER_GENERATION_PARAMETERS

INT_CONFIG_KEYS = [MAX_NEW_TOKENS_KEY, MAX_TOKENS_KEY, NUM_BEAMS_KEY, WORDS_PER_SECOND_WAITING_KEY,
                   NO_REPEAT_NGRAM_KEY]
FLOAT_CONFIG_KEYS = [REPETITION_PENALTY_KEY, TEMPERATURE_KEY]
BOOL_CONFIG_KEYS = [USE_TOGETHER_KEY, USE_PIPELINE_KEY, DO_SAMPLE_KEY]

# default values
DEFAULT_MAX_NEW_TOKENS = 25
DEFAULT_NUM_BEAMS = 1  # 4
DEFAULT_REPETITION_PENALTY = 1.25
DEFAULT_DO_SAMPLE = True
DEFAULT_TEMPERATURE = 1.3
DEFAULT_NO_REPEAT_NGRAM = 8

DEFAULT_NUM_WORDS_PER_SECOND_TO_WAIT = 1  # simulates number of words written normally per second

VOTING_WAITING_TIME = 5  # seconds
MAX_TIME_TO_WAIT = 10
# With nobody to speak first, each player waits a random time up to this many seconds
# before considering to open a phase, so the table doesn't open with one message each.
DEFAULT_OPENING_JITTER = 10

DEFAULT_LLM_CONFIG = {
    MODEL_NAME_KEY: DEFAULT_MODEL_NAME,
    USE_TOGETHER_KEY: True,
    USE_PIPELINE_KEY: False,
    PIPELINE_TASK_KEY: TEXT_GENERATION_TASK,
    MAX_NEW_TOKENS_KEY: DEFAULT_MAX_NEW_TOKENS,
    MAX_TOKENS_KEY: DEFAULT_MAX_NEW_TOKENS,
    NUM_BEAMS_KEY: DEFAULT_NUM_BEAMS,
    REPETITION_PENALTY_KEY: DEFAULT_REPETITION_PENALTY,
    DO_SAMPLE_KEY: DEFAULT_DO_SAMPLE,
    TEMPERATURE_KEY: DEFAULT_TEMPERATURE,
    NO_REPEAT_NGRAM_KEY: DEFAULT_NO_REPEAT_NGRAM,
    WORDS_PER_SECOND_WAITING_KEY: DEFAULT_NUM_WORDS_PER_SECOND_TO_WAIT,
    PASS_TURN_TOKEN_KEY: DEFAULT_PASS_TURN_TOKEN,
    USE_TURN_TOKEN_KEY: DEFAULT_USE_TURN_TOKEN,
    ASYNC_TYPE_KEY: DEFAULT_ASYNC_TYPE
}

LLM_CONFIG_KEYS_OPTIONS = {
    MODEL_NAME_KEY: MODEL_NAMES,
    PIPELINE_TASK_KEY: [TEXT_GENERATION_TASK],
    PASS_TURN_TOKEN_KEY: PASS_TURN_TOKEN_OPTIONS,
    USE_TURN_TOKEN_KEY: USE_TURN_TOKEN_OPTIONS,
    ASYNC_TYPE_KEY: ASYNC_TYPES
}

HUGGINGFACE_SCHEDULING_GENERATION_PARAMETERS = {
    MAX_NEW_TOKENS_KEY: 7,  # [[speak]] for example requires 5, <speak> requires 4, and there is also <|end_of_text|>
    REPETITION_PENALTY_KEY: 0.9  # reward tokens it has already seen, like the special tokens
}
TOGETHER_SCHEDULING_GENERATION_PARAMETERS = {
    MAX_TOKENS_KEY: 6,  # [[speak]] for example requires 5, <speak> requires 4
}
# SCHEDULING_GENERATION_PARAMETERS = HUGGINGFACE_SCHEDULING_GENERATION_PARAMETERS
SCHEDULING_GENERATION_PARAMETERS = TOGETHER_SCHEDULING_GENERATION_PARAMETERS


# prompts
ROLE_INFO = {
    DETECTIVE_ROLE: "As the detective, every Nighttime you secretly pick one player you are "
                    "doubtful about, and the game manager privately tells you whether they are "
                    "mafia. Only you know the results. You must NEVER say in the chat that you "
                    "are the detective, that you investigated anyone, or what you learned. "
                    "Instead, use what you know to convince the other players with logical "
                    "arguments based on what was said in the chat and how people voted.",
    DOCTOR_ROLE: "As the doctor, every Nighttime you secretly pick one player to protect from "
                 "the mafia. You may protect yourself, but you can't protect the same player "
                 "on two consecutive nights.",
}
# The "misinformation" variant: the rules every player is told, and the role instructions that
# differ from plain Mafia (the detective may share or bluff, since nothing is certain anyway).
MISINFORMATION_RULES = ("This game uses the misinformation rules: information is unreliable, "
                        "and anyone may lie. Town players may also bluff about their role or "
                        "about what they learned, if they think it helps the town.")
MISINFORMATION_ROLE_INFO = {
    **ROLE_INFO,
    DETECTIVE_ROLE: "As the detective, every Nighttime you secretly pick one player you are "
                    "doubtful about, and the game manager privately tells you whether they are "
                    "mafia. You may share what you learn, keep it to yourself, or bluff, "
                    "whatever helps the town most.",
}
VOTE_ANSWER_FORMAT = "Reply with only one name from the list, and nothing but that name: "
NIGHT_VOTE_TASKS = {
    DETECTIVE_ROLE: "It is Nighttime and you are the detective. Which of the following "
                    "remaining players do you want to investigate tonight, to learn whether "
                    "they are mafia? Base your answer on the conversation as seen in the "
                    "message history and on your private notes. " + VOTE_ANSWER_FORMAT,
    DOCTOR_ROLE: "It is Nighttime and you are the doctor. Which of the following remaining "
                 "players do you want to protect tonight from being eliminated by the mafia? "
                 "Base your answer on the conversation as seen in the message history. "
                 + VOTE_ANSWER_FORMAT,
}
TALKATIVE_PROMPT = "Make sure to say something every once in a while, and make yourself heard. " \
                   "Remember you like to be active in the game, so participate and be " \
                   "as talkative as other players! "
QUIETER_PROMPT = "Don't overflow the discussion with your messages! " \
                 "Pay attention to the amount of messages with your name compared to the amount " \
                 "of messages with names of other players and let them have their turn too! " \
                 "Check the speaker name in the last few messages, and decide accordingly " \
                 "based on whether you talked too much. "


def turn_task_into_prompt(task, message_history):
    prompt = f"The current time is [{get_current_timestamp()}].\n"
    if not message_history:
        prompt += "No player has sent a message yet.\n"
    else:
        prompt += "Here is the message history so far, including [timestamps]:\n"
        prompt += "".join(message_history)  # each one already ends with "\n"
    prompt += task.strip() + "\n"
    # not necessarily needed with all models, seemed relevant to Llama3.1:
    prompt += "Don't add the time, the timestamp or the [timestamp] in your answer!\n"
    return prompt


def make_more_human_like(message):
    if message.endswith(".") and not message.endswith(".."):
        # remove the formal style of ending sentences with ".", with no effect over multiple dots
        message = message[:-1]
    # return message.capitalize()  # Leaves only the first character in caps (which is still common)
    return strip_special_chars(message).lower()
