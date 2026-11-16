import json
import random
import re
import sys
from game_constants import *  # incl. argparse, time, Path (from pathlib), colored (from termcolor)
from game_status_checks import is_nighttime, is_game_over, is_voted_out, is_time_to_vote, \
    all_players_joined, get_phase_status
from llm_players.factory import llm_player_factory
from llm_players.llm_constants import GAME_DIR_KEY, MAX_TIME_TO_WAIT, NIGHT_VOTE_TASKS


OPERATOR_COLOR = "yellow"  # the person running this file is the "operator" of the model
LLM_PLAYER_LOADED_MESSAGE = "The LLM PLayer was loaded successfully, " \
                            "now waiting for all other players to join..."
ALL_PLAYERS_JOINED_MESSAGE = "All players have joined, now the game can start."
LLM_VOTE_MESSAGE_FORMAT = "The LLM player has voted for: {}"
GAME_ENDED_MESSAGE = "Game has ended, without being voted out!"
GET_LLM_PLAYER_NAME_MESSAGE = "This game has multiple LLM players, which one you want to run now?"
ELIMINATED_MESSAGE = "This LLM player was eliminated from the game..."
MAX_MESSAGE_LENGTH = 300  # characters; the task asks for one short sentence


# global variable
game_dir = Path()  # will be updated in get_llm_player


def get_llm_player():
    """
    usage: llm_interface.py game_id [player_name]
    The player name is needed (or asked for) only when the game has several LLM players.
    """
    global game_dir
    game_dir = get_game_dir_from_argv()
    with open(game_dir / GAME_CONFIG_FILE) as f:
        config = json.load(f)
    llm_players_configs = [player for player in config[PLAYERS_KEY_IN_CONFIG] if player["is_llm"]]
    if not llm_players_configs:
        raise ValueError("No LLM player configured in this game")
    elif len(sys.argv) > 2:
        player_name = sys.argv[2]
    elif len(llm_players_configs) == 1:
        player_name = llm_players_configs[0]["name"]
    else:
        player_name = get_player_name_from_user([player["name"] for player in llm_players_configs],
                                                GET_LLM_PLAYER_NAME_MESSAGE, OPERATOR_COLOR)
    player_configs = [player for player in llm_players_configs if player["name"] == player_name]
    if not player_configs:
        raise ValueError(f"No LLM player named {player_name} in this game")
    player_config = player_configs[0]
    player_config[GAME_DIR_KEY] = game_dir
    llm_player = llm_player_factory(player_config)
    (game_dir / PERSONAL_STATUS_FILE_FORMAT.format(llm_player.name)).write_text(JOINED)
    return llm_player


def read_messages_from_file(message_history, file_name, num_read_lines):
    with open(game_dir / file_name, "r") as f:
        lines = f.readlines()[num_read_lines:]
    message_history.extend(lines)
    return len(lines)


def wait_writing_time(player, message):
    if player.num_words_per_second_to_wait > 0:
        num_words = len(message.split())
        time_to_wait = min(num_words // player.num_words_per_second_to_wait, MAX_TIME_TO_WAIT)
        if is_nighttime(game_dir):
            time_to_wait //= 2
        time.sleep(time_to_wait)
        # TODO: leave only working part
        # time.sleep(num_words // player.num_words_per_second_to_wait)
        # time.sleep(num_words // player.num_words_per_second_to_wait + 2)
        # # It was originally num words per second, but now I changed it to be treated as num chars per second
        # # treated as num chars per second to wait:
        # time.sleep(len(message) // player.num_words_per_second_to_wait)


def eliminate(player):
    # currently doesn't use player, but maybe in the future we can use player.logger for example
    print(colored(ELIMINATED_MESSAGE, OPERATOR_COLOR))


def get_vote_candidates(player, is_night, last_protected):
    """Who this player may name: in the Daytime vote, or in its role's Nighttime choice."""
    candidates = (game_dir / REMAINING_PLAYERS_FILE).read_text().splitlines()
    if is_night and player.is_mafia:  # the mafia eliminates a town player
        mafia_names = (game_dir / MAFIA_NAMES_FILE).read_text().splitlines()
        return [name for name in candidates if name not in mafia_names]
    if is_night and player.special_role == DOCTOR_ROLE:
        # may protect themselves, but not the same player on two consecutive nights
        return [name for name in candidates if name != last_protected]
    return [name for name in candidates if name != player.name]


def pick_voted_name(voting_message, candidate_vote_names):
    """The candidate that the answer names first, as a whole word (so "Ari" isn't "Ariel")."""
    mentions = [(matcher.start(), name) for name in candidate_vote_names
                if (matcher := re.search(rf"\b{re.escape(name)}\b", voting_message))]
    return min(mentions)[1] if mentions else None


def get_vote_from_llm(player, message_history, is_night, last_protected=None):
    candidate_vote_names = get_vote_candidates(player, is_night, last_protected)
    task = NIGHT_VOTE_TASKS.get(player.special_role) if is_night else None
    voting_message = player.get_vote(message_history, candidate_vote_names, task)
    vote = pick_voted_name(voting_message, candidate_vote_names)
    if not vote:
        player.logger.log(MODEL_VOTED_INVALIDLY_LOG, voting_message)
        print(colored(MODEL_VOTED_INVALIDLY_LOG + ": " + voting_message, OPERATOR_COLOR))
        vote = random.choice(candidate_vote_names)
        player.logger.log(MODEL_RANDOMLY_VOTED_LOG, vote)
    update_vote(vote, player)  # update game manger
    return vote


def update_vote(voted_name, player):
    time.sleep(player.vote_delay_seconds)
    with open(game_dir / PERSONAL_VOTE_FILE_FORMAT.format(player.name), "a") as f:
        f.write(voted_name + "\n")
    print(colored(LLM_VOTE_MESSAGE_FORMAT.format(voted_name), OPERATOR_COLOR))


def add_message_to_game(player, message_history):
    is_nighttime_at_start = is_nighttime(game_dir)
    message = player.generate_message(message_history).strip()[:MAX_MESSAGE_LENGTH]
    if is_time_to_vote(game_dir):
        return  # sometimes the messages is generated when it's already too late, so drop it
    if message:
        # artificially making the model taking time to write the message
        wait_writing_time(player, message)
        if is_nighttime(game_dir) != is_nighttime_at_start or is_time_to_vote(game_dir):
            return  # waited for too long
        with open(game_dir / PERSONAL_CHAT_FILE_FORMAT.format(player.name), "a") as f:
            f.write(format_message(player.name, message))
        print(colored(MODEL_CHOSE_TO_USE_TURN_LOG, OPERATOR_COLOR))
    else:
        print(colored(MODEL_CHOSE_TO_PASS_TURN_LOG, OPERATOR_COLOR))


def end_game(eliminated: bool):
    if not eliminated:
        print(colored(GAME_ENDED_MESSAGE, OPERATOR_COLOR))


def main():
    player = get_llm_player()
    print(colored(LLM_PLAYER_LOADED_MESSAGE, OPERATOR_COLOR))
    while not all_players_joined(game_dir):
        time.sleep(POLL_SECONDS)
    print(colored(ALL_PLAYERS_JOINED_MESSAGE, OPERATOR_COLOR))
    message_history = []
    num_read_lines_manager = num_read_lines_daytime = num_read_lines_nighttime = 0
    eliminated = False
    last_protected = None  # only the doctor uses it
    while not is_game_over(game_dir):
        num_read_lines_manager += read_messages_from_file(
            message_history, PUBLIC_MANAGER_CHAT_FILE, num_read_lines_manager)
        # only current phase file will have new messages, so no need to run expensive is_nighttime()
        num_read_lines_daytime += read_messages_from_file(
            message_history, PUBLIC_DAYTIME_CHAT_FILE, num_read_lines_daytime)
        if player.is_mafia:  # only mafia can see what happens during nighttime
            num_read_lines_nighttime += read_messages_from_file(
                message_history, PUBLIC_NIGHTTIME_CHAT_FILE, num_read_lines_nighttime)
        if is_voted_out(player.name, game_dir):
            eliminate(player)
            eliminated = True
            break
        phase_status = get_phase_status(game_dir)
        is_night = NIGHTTIME in phase_status
        # during Nighttime only the mafia talks, and only the mafia and the night roles choose
        if VOTING_TIME in phase_status:
            if not is_night or player.is_mafia or player.special_role in NIGHT_ROLES:
                vote = get_vote_from_llm(player, message_history, is_night, last_protected)
                if is_night and player.special_role == DOCTOR_ROLE:
                    last_protected = vote
            # Wait for this vote to end, which is when the status changes. Checking only for
            # "not voting" would miss a Nighttime that goes straight to its own vote (a single
            # mafia member has no discussion), and this player's Nighttime choice with it.
            while get_phase_status(game_dir) == phase_status and not is_game_over(game_dir):
                time.sleep(POLL_SECONDS)
        elif not is_night or player.is_mafia:
            add_message_to_game(player, message_history)
            # Every turn is a model call with the whole chat in it, so this pause sets how
            # much a game costs (and how fast a player can react). The default is no pause.
            time.sleep(player.seconds_between_turns)
        time.sleep(POLL_SECONDS)
    end_game(eliminated)


if __name__ == '__main__':
    main()
