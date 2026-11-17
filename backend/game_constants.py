import os
import re
import argparse
import random
import time
from pathlib import Path
from termcolor import colored


# new game preparation constants
# DEFAULT_GAME_CONFIG = "configurations/minimalist_game_with_llm.json"
DEFAULT_GAME_CONFIG = "configurations/minimalist_game_no_llm.json"
GAME_ID_NUM_DIGITS = 4
NOTES_FILE = "notes.txt"  # for our use, post-game

# files that host writes to and players read from
# working directory must be the repo; autonomous games set LLMAFIA_GAMES_DIR to keep
# their output apart from the published human dataset in ./games
DIRS_PREFIX = os.environ.get("LLMAFIA_GAMES_DIR", "./games")
GAMES_INDEX_FILE = "index.json"  # list of autonomous games, for the viewer's game picker
EVENTS_FILE = "events.jsonl"  # ordered spectator log written by the game manager
# game config key: the model of the moderator who narrates for spectators (see moderator.py)
MODERATOR_MODEL_KEY = "moderator_model"
MODERATOR_VOICE_KEY = "moderator_voice"  # a Deepgram voice that speaks its lines, or none
# game config key: start with a Nighttime (autonomous games) instead of a Daytime (the paper's
# human games), so the first discussion has a night's result to work with
NIGHT_FIRST_KEY = "night_first"
# game config key: pause between the night's steps (question, answer, next question) so that
# spectators can follow them; the players only wait meanwhile, so it changes nothing in the game
NIGHT_PACING_KEY = "night_pacing"
GAME_CONFIG_FILE = "config.json"
PLAYER_NAMES_FILE = "player_names.txt"
REMAINING_PLAYERS_FILE = "remaining_players.txt"
MAFIA_NAMES_FILE = "mafia_names.txt"
REAL_NAMES_FILE = "real_names.txt"  # mapping of real names to code names
PHASE_STATUS_FILE = "phase_status.txt"
WHO_WINS_FILE = "who_wins.txt"
GAME_START_TIME_FILE = "game_start_time.txt"
PUBLIC_MANAGER_CHAT_FILE = "public_manager_chat.txt"
PUBLIC_DAYTIME_CHAT_FILE = "public_daytime_chat.txt"
PUBLIC_NIGHTTIME_CHAT_FILE = "public_nighttime_chat.txt"
ALL_MESSAGES_FILE = "all_messages.txt"
# file that is initial used for players to write "joined", and then for host to write "eliminated"
PERSONAL_STATUS_FILE_FORMAT = "{}_status.txt"
# files that hosts read from and players write to
PERSONAL_CHAT_FILE_FORMAT = "{}_chat.txt"
PERSONAL_VOTE_FILE_FORMAT = "{}_vote.txt"
PERSONAL_SURVEY_FILE_FORMAT = "{}_survey.txt"
LLM_LOG_FILE_FORMAT = "{}_log.txt"
REASONING_FILE_FORMAT = "{}_reasoning.jsonl"  # one JSON line per LLM call
# file that host writes to and only that player reads: detective results, doctor history
PRIVATE_NOTES_FILE_FORMAT = "{}_private.txt"

# constant strings for info files
NIGHTTIME = "Nighttime"
DAYTIME = "Daytime"
VOTING_TIME = "Voting"
NIGHTTIME_VOTING_TIME = NIGHTTIME + "_" + VOTING_TIME  # keeps the is_nighttime function mechanism
DAYTIME_VOTING_TIME = DAYTIME + "_" + VOTING_TIME
JOINED = "JOINED\n"
VOTED_OUT = "VOTED_OUT\n"
MAFIA_ROLE = "mafia"
BYSTANDER_ROLE = "bystander"  # a non-mafia player in a game without special roles
VILLAGER_ROLE = "villager"
DETECTIVE_ROLE = "detective"
DOCTOR_ROLE = "doctor"
NIGHT_ROLES = (DETECTIVE_ROLE, DOCTOR_ROLE)  # non-mafia roles that act during Nighttime
TOWN_ROLES = (VILLAGER_ROLE, DETECTIVE_ROLE, DOCTOR_ROLE)
MAFIA_WINS_MESSAGE = "Mafia wins!"
BYSTANDERS_WIN_MESSAGE = "Bystanders win!"
GAME_MANAGER_NAME = "Game-Manager"
RULES_OF_THE_GAME_TITLE = "Rules of the game:"
RULES_OF_THE_GAME = "In this game each player is secretly assigned a role, and each role " \
                    "belongs to one of two teams. The mafia team knows who its members are. " \
                    "Everyone else is on the town team: villagers (also called bystanders), " \
                    "and possibly one detective and one doctor. The game alternates between " \
                    "Daytime and Nighttime phases. In a Daytime phase, all remaining players " \
                    "discuss together who they think the mafia players might be, and then " \
                    "vote out one player, whose role is then revealed. Mafia players take part " \
                    "in the Daytime discussion while pretending to be innocent town members. " \
                    "In a Nighttime phase, only mafia players interact and vote to decide " \
                    "which town player they want to eliminate (town players aren't exposed to " \
                    "the mafia identities or interaction). Also during Nighttime, the " \
                    "detective secretly picks one player and privately learns whether that " \
                    "player is mafia, and the doctor secretly picks one player to protect: if " \
                    "the mafia chose that same player, nobody is eliminated that night. The " \
                    "doctor may protect themselves, but can't protect the same player on two " \
                    "consecutive nights. The mafia wins when the remaining mafia players are " \
                    "at least as many as the remaining town players, and the town wins when " \
                    "all mafia players are eliminated."

# formats for saving texts
TIME_FORMAT_FOR_TIMESTAMP = "%H:%M:%S"
MESSAGE_FORMAT = "[{timestamp}] {name}: {message}"
MESSAGE_PARSING_PATTERN = r"\[(\d\d):(\d\d):(\d\d)\] ([^:]+): (.+)"  # depends on MESSAGE_FORMAT
VOTING_MESSAGE_FORMAT = "{} voted for {}"
VOTED_OUT_MESSAGE_FORMAT = "{} was voted out. Their role was {}"
NIGHT_KILL_MESSAGE_FORMAT = "{} was eliminated by the mafia during the night. Their role was {}"
NOBODY_ELIMINATED_MESSAGE = "Nobody was eliminated tonight."
REAL_NAME_CODENAME_DELIMITER = ": "  # <real name>: <codename>

# game constants
DAYTIME_START_PREFIX = "Now it's Daytime"  # used for analysis
DAYTIME_START_MESSAGE_FORMAT = DAYTIME_START_PREFIX + " for {} minutes, " \
                               "everyone can communicate and see messages and votes."
NIGHTTIME_START_PREFIX = "Now it's Nighttime"  # used for analysis
NIGHTTIME_START_MESSAGE_FORMAT = NIGHTTIME_START_PREFIX + " for {} minutes, " \
                                 "only mafia can communicate and see messages and votes."
VOTING_TIME_MESSAGE_FORMAT = "{} has ended, now it's time to vote! " \
                             "Waiting for all players to vote..."
CUTTING_TO_VOTE_MESSAGE = "There is only one mafia member left, so no need for discussion" \
                          " - cutting straight to voting!"
DAYTIME_VOTING_TIME_MESSAGE = VOTING_TIME_MESSAGE_FORMAT.format(DAYTIME)
NIGHTTIME_VOTING_TIME_MESSAGE = VOTING_TIME_MESSAGE_FORMAT.format(NIGHTTIME)

# new configuration preparation constants
PLAYERS_KEY_IN_CONFIG = "players"
DEFAULT_CONFIG_DIR = "./configurations"
DEFAULT_NUM_MAFIA = 2
MINIMUM_NUM_PLAYERS_FOR_ONE_MAFIA = 5
MINIMUM_NUM_PLAYERS_FOR_MULT_MAFIA = 7
DEFAULT_NUM_PLAYERS = MINIMUM_NUM_PLAYERS_FOR_MULT_MAFIA
WARNING_LIMIT_NUM_MAFIA = 3
OPTIONAL_CODE_NAMES = [  # I've tried using mainly unisex names, as suggest by Claud + additions
    "Addison", "Adrian", "Alex", "Angel", "Ari", "Ariel", "Ashton", "Avery", "Bailey", "Blake",
    "Brook", "Cameron", "Casey", "Charlie", "Dakota", "Drew", "Dylan", "Eden", "Elliot", "Emerson",
    "Finley", "Frankie", "Gray", "Harley", "Harper", "Hayden", "Jackie", "Jamie", "Jordan", "Kai",
    "Kennedy", "Lee", "Lennon", "Logan", "Mickey", "Morgan", "Noah", "Parker", "Peyton", "Quinn",
    "Ray", "Reese", "Remi", "Riley", "River", "Robin", "Ronny", "Rowan", "Sage", "Sam", "Sidney",
    "Skylar", "Stevie", "Sutton", "Terry", "Tyler", "Whitney", "Winter", "Ziggy"]
random.shuffle(OPTIONAL_CODE_NAMES)  # without it some names are sampled too often...
DEFAULT_NIGHTTIME_MINUTES = 0.75  # 1  # like in Ibraheem et al. 2022
DEFAULT_DAYTIME_MINUTES = 2  # 2.5  # 3  # it was 2:30 in Ibraheem et al. 2022
DAYTIME_MINUTES_KEY = "daytime_minutes"
NIGHTTIME_MINUTES_KEY = "nighttime_minutes"
POLL_SECONDS = 0.2  # pause between file polls; without it every process pins a CPU core

# human player interface constants
MANAGER_COLOR = "green"
DAYTIME_COLOR = "light_blue"
NIGHTTIME_COLOR = "red"
CONSENT_COLOR = "light_grey"
PARTICIPATION_CONSENT_MESSAGE = "Thank you for participating in our research. By participating " \
                                "you are giving consent to use your input for research purposes, " \
                                "such as analyzing the conversations text and publishing it as a " \
                                "public dataset. Your true identity will remain anonymous, and " \
                                "all personal details will not be saved! Please refrain from " \
                                "using personal information, to secure your privacy."
WELCOME_MESSAGE = "Welcome to the game of Mafia!"
GET_USER_NAME_MESSAGE = "Who are you? Enter the name's number:"
VOTE_FLAG = "VOTE"
NOT_TIME_TO_VOTE_MESSAGE = "This is not the time to vote yet."
GET_CHAT_INPUT_MESSAGE = "> "  # f"Enter a message to the public chat: "
VOTE_INSTRUCTION_MESSAGE = f"We are now waiting for everyone to cast their vote!\n" \
                           f"Enter '{VOTE_FLAG}' as your input to vote..."
GET_VOTED_NAME_MESSAGE_FORMAT = "It's time to make your vote, {}!\nEnter your vote's number:"
CODE_NAME_REVELATION_MESSAGE_FORMAT = "\nHi {}! Your name for this game will be:"
ROLE_REVELATION_MESSAGE = "\nYour role in the game is:"
MAFIA_REVELATION_MESSAGE = "Mafia members were:"
YOU_CANT_WRITE_MESSAGE = "You were voted out and can no longer write messages.\n" \
                         "Please wait for the end of the game for our short survey.\n" \
                         "You can meanwhile still read the game's chat and see what happens.\n"
HOW_MANY_MAFIA_MESSAGE_START = "The current game has"
HOW_MANY_MAFIA_MESSAGE_END = "players in the mafia team."
ONLY_ONE_MAFIA_MESSAGE_START = "The current game has"
ONLY_ONE_MAFIA_MESSAGE_BOLD = "only 1"
ONLY_ONE_MAFIA_MESSAGE_END = "player in the mafia team."
OTHER_MAFIA_NAMES_MESSAGE = "The other mafia members are:"
MAFIA_KNOW_EACH_OTHER_MESSAGE = "The mafia members know each other's identities."
WAITING_FOR_ALL_PLAYERS_TO_JOIN_MESSAGE = "Waiting for all players to join to start the game..."
WELCOME_INPUT_INTERFACE_MESSAGE = "This interface will only serve you to enter your messages and " \
                                  "votes.\nAll other game info, messages and chat will be " \
                                  "visible in the chat interface (run by `player_chat.py`)"
GET_CODE_NAME_FROM_USER_MESSAGE = "Enter the name you were given for this game " \
                                  "(in the chat interface) - choose the name's number:\n" \
                                  "ATTENTION! They do NOT have the same numbers and order!"
YOU_CAN_START_WRITING_MESSAGE = "You can now start writing messages to game!"

# post game survey constants
LLM_IDENTIFICATION = "Was the LLM identified"
HUMAN_SIMILARITY = "similarity to human behavior"
TIMING = "timing of messaging"
RELEVANCE = "relevance of messages"
METRICS_TO_SCORE = [HUMAN_SIMILARITY, TIMING, RELEVANCE]
METRIC_NAME_AND_SCORE_DELIMITER = " - "
DEFAULT_SCORE_LOW_BOUND = 1
DEFAULT_SCORE_HIGH_BOUND = 5
SURVEY_QUESTION_FORMAT = "How would you score {}'s"
NUMERIC_SURVEY_QUESTION_FORMAT = "Please provide an *integer* answer between " \
                                 "{} (worst) and {} (best), including: "
LLM_IDENTIFICATION_SURVEY_MESSAGE = "Which of the players do you think the LLM was?"
CORRECT_GUESS_MESSAGE = "This is correct!"
WRONG_GUESS_MESSAGE = "This is wrong!"
LLM_REVELATION_MESSAGE = "In this game, the LLM player was:"
NO_LLM_IN_GAME_MESSAGE = "This game was a simulation with no LLM player, " \
                         "so we don't have many survey questions."
ASK_USER_FOR_COMMENTS_MESSAGE = "Please add any additional comments if you have for us: "
SURVEY_COMMENTS_TITLE = "Comments:"
THANK_YOU_GOODBYE_MESSAGE = "Thank you very much for participating! Goodbye"

# LLM log strings
SCHEDULING_DECISION_LOG = "scheduling decision"
MODEL_CHOSE_TO_USE_TURN_LOG = "The LLM player has chosen to use its turn and generate a message!"
MODEL_CHOSE_TO_PASS_TURN_LOG = "The LLM player has chosen to pass its turn " \
                               "without generating a message!"
MODEL_VOTED_INVALIDLY_LOG = "The LLM player has generated a message with no valid vote..."
MODEL_RANDOMLY_VOTED_LOG = "random vote selected for the LLM player"


def minutes_to_seconds(num_minutes):
    return int(num_minutes * 60)


def get_current_timestamp():
    return time.strftime(TIME_FORMAT_FOR_TIMESTAMP)


def format_message(name, message):
    timestamp = get_current_timestamp()
    return MESSAGE_FORMAT.format(timestamp=timestamp, name=name, message=message) + "\n"


def strip_special_chars(content):
    return re.search(r"^[^a-zA-Z0-9]*(.*?)[^a-zA-Z0-9]*$", content).group(1)


def get_role_string(is_mafia, special_role=""):
    return MAFIA_ROLE if is_mafia else (special_role or BYSTANDER_ROLE)


def get_game_dir_from_argv():
    parser = argparse.ArgumentParser()
    parser.add_argument("game_id", help=f"{GAME_ID_NUM_DIGITS}-digit game ID")
    args, _ = parser.parse_known_args()  # llm_interface.py takes a player name after the id
    game_dir = Path(DIRS_PREFIX) / args.game_id
    if not game_dir.exists():
        raise ValueError(f"The provided game ID {args.game_id} doesn't belong to a configured game")
    return game_dir


def get_player_names_by_id(player_names):
    return {f"{i + 1}": name for i, name in enumerate(player_names) if name}


def get_player_name_from_user(optional_player_names, input_message, message_color=MANAGER_COLOR):
    player_names_by_id = get_player_names_by_id(optional_player_names)
    name_id = ""
    enumerated_names = ",   ".join([f"{i}: {name}" for i, name in player_names_by_id.items()])
    while name_id not in player_names_by_id:
        name_id = input(colored(f"{input_message}\n{enumerated_names}\n", message_color))
    name = player_names_by_id[name_id]
    return name


def get_player_name_and_real_name_from_user(game_dir):
    real_names_to_codenames_str = (game_dir / REAL_NAMES_FILE).read_text().splitlines()
    real_names_to_codenames = dict([real_to_code.split(REAL_NAME_CODENAME_DELIMITER)
                                    for real_to_code in real_names_to_codenames_str])
    real_name = get_player_name_from_user(real_names_to_codenames.keys(), GET_USER_NAME_MESSAGE)
    name = real_names_to_codenames[real_name]
    return name, real_name
