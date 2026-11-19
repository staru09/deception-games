import json
import random
import re
from game_constants import *  # incl. argparse, time, Path (from pathlib), colored (from termcolor)
from moderator import Moderator, clip_seconds


# global variable for the game dir
game_dir = Path()  # will be updated only if __name__ == __main__ (prevents new ones in imports)
moderator = None  # narrates for spectators when the config names a model (see moderator.py)
public_history = []  # what everyone knows: who is out and how, for the moderator
night_pacing = False  # set from the config in main(); see hear() and hold()
ANSWER_HOLD_SECONDS = 2.5  # how long a night answer stays alone on screen before the next question


def hear(line):
    """Night pacing: the moderator's question is heard (its clip) or read in full before its answer
    shows. The players are only waiting for the night's vote to close, so nothing in the game changes."""
    if night_pacing and line:
        text, audio = line
        time.sleep((clip_seconds(game_dir, audio) if audio else min(len(text) * 0.05, 5)) + 1)


def hold():
    """Night pacing: an answer stays on screen for a moment before the next question."""
    if night_pacing:
        time.sleep(ANSWER_HOLD_SECONDS)

PHASE_EVENT_NAMES = {DAYTIME: "day", NIGHTTIME: "night"}


def log_event(event_type, **data):
    # One ordered stream of everything that happens, for spectators (the 3D viewer) and
    # analysis. Only the manager writes it and no player process reads it, so it may hold
    # what players must not see (night actions).
    with open(game_dir / EVENTS_FILE, "a") as f:
        f.write(json.dumps({"ts": time.time(), "type": event_type, **data}) + "\n")


def moderator_line(moment, players, round_number, **facts):
    """
    What the moderator says, as (text, audio clip or None), or None without a moderator. Call it only while no discussion is running:
    the players wait for the manager meanwhile, so the moderator never eats into their time.
    """
    if moderator is None:
        return None
    return moderator.narrate(moment, round=round_number,
                             alive=", ".join(player.name for player in players),
                             out_so_far="; ".join(public_history) or "nobody", **facts)


def log_narration(line, moment):
    # Only in the spectator log: no player reads events.jsonl, so the agents never see it.
    if line:
        text, audio = line
        log_event("narration", text=text, moment=moment, **({"audio": audio} if audio else {}))


class Player:

    def __init__(self, name, is_mafia, special_role="", **kwargs):
        self.name = name
        self.is_mafia = is_mafia
        self.special_role = special_role
        self.role = get_role_string(is_mafia, special_role)
        self.personal_chat_file = game_dir / PERSONAL_CHAT_FILE_FORMAT.format(self.name)
        self.personal_chat_file_lines_read = 0
        self.personal_vote_file = game_dir / PERSONAL_VOTE_FILE_FORMAT.format(self.name)
        self.personal_vote_file_lines_read = 0
        # status is whether the player has joined and then whether was voted out
        self.personal_status_file = game_dir / PERSONAL_STATUS_FILE_FORMAT.format(self.name)
        self.private_notes_file = game_dir / PRIVATE_NOTES_FILE_FORMAT.format(self.name)

    def get_new_messages(self):
        with open(self.personal_chat_file, "r") as f:
            # the readlines method includes the "\n"
            lines = f.readlines()[self.personal_chat_file_lines_read:]
        self.personal_chat_file_lines_read += len(lines)
        return lines

    def get_voted_player(self):
        all_votes = self.personal_vote_file.read_text().splitlines()
        new_votes = all_votes[self.personal_vote_file_lines_read:]
        if new_votes:
            self.personal_vote_file_lines_read += len(new_votes)  # should be 1 if works correctly
            return new_votes[-1].strip()
        else:
            return None

    def wait_for_vote(self):
        while True:
            voted_for = self.get_voted_player()
            if voted_for:
                return voted_for
            time.sleep(POLL_SECONDS)

    def add_private_note(self, note):
        with open(self.private_notes_file, "a") as f:
            f.write(note + "\n")

    def eliminate(self):
        self.personal_status_file.write_text(VOTED_OUT)


def get_config():
    with open(game_dir / GAME_CONFIG_FILE, "r") as f:
        config = json.load(f)
    return config


def get_players(config):
    return [Player(**player_config) for player_config in config[PLAYERS_KEY_IN_CONFIG]]


def is_win_by_bystanders(mafia_players):
    if len(mafia_players) == 0:
        (game_dir / WHO_WINS_FILE).write_text(BYSTANDERS_WIN_MESSAGE)
        return True
    return False


def is_win_by_mafia(mafia_players, bystanders):
    if len(mafia_players) >= len(bystanders):
        (game_dir / WHO_WINS_FILE).write_text(MAFIA_WINS_MESSAGE)
        return True
    return False


def is_game_over(players):
    mafia_players = [player for player in players if player.is_mafia]
    bystanders = [player for player in players if not player.is_mafia]
    return is_win_by_bystanders(mafia_players) or is_win_by_mafia(mafia_players, bystanders)


def run_chat_round_between_players(players, chat_room, phase_name):
    for player in players:
        lines = player.get_new_messages()
        if not lines:
            continue
        with open(chat_room, "a") as f:
            f.writelines(lines)  # lines already include "\n"
        for line in lines:
            matcher = re.match(MESSAGE_PARSING_PATTERN, line)
            if matcher:
                log_event("message", name=matcher.group(4), text=matcher.group(5),
                          phase=PHASE_EVENT_NAMES[phase_name])


def notify_players_about_voting_time(phase_name, public_chat_file):
    phase_end_message = DAYTIME_VOTING_TIME_MESSAGE if phase_name == DAYTIME else NIGHTTIME_VOTING_TIME_MESSAGE
    with open(public_chat_file, "a") as f:  # only to the current phase's active players chat room
        f.write(format_message(GAME_MANAGER_NAME, phase_end_message))
    voting_phase_name = DAYTIME_VOTING_TIME if phase_name == DAYTIME else NIGHTTIME_VOTING_TIME
    (game_dir / PHASE_STATUS_FILE).write_text(voting_phase_name)


def get_voted_out_name(optional_votes_players, public_chat_file, voting_players, phase_name):
    votes = {player.name: 0 for player in optional_votes_players}
    while voting_players:
        voted_players = []
        for player in voting_players:
            voted_for = player.get_voted_player()
            if not voted_for:
                continue
            voted_players.append(player)
            if voted_for in votes:
                with open(public_chat_file, "a") as f:
                    voting_message = VOTING_MESSAGE_FORMAT.format(player.name, voted_for)
                    f.write(format_message(GAME_MANAGER_NAME, voting_message))
                log_event("vote", voter=player.name, target=voted_for,
                          phase=PHASE_EVENT_NAMES[phase_name])
                votes[voted_for] += 1
        for player in voted_players:
            voting_players.remove(player)
        time.sleep(POLL_SECONDS)
    # a tie (or no valid vote at all) is decided randomly among the most voted players
    most_votes = max(votes.values())
    return random.choice([name for name, count in votes.items() if count == most_votes])


def run_night_roles(players, round_number):
    """
    The detective and the doctor act in secret: their choices go only to their own private
    notes and to the spectator log, never to a chat file that another player reads.
    Returns the name the doctor protected (None without a living doctor).
    """
    players_by_name = {player.name: player for player in players}
    protected_name = None
    # The moderator asks the doctor, then the detective (the mafia were asked just before).
    # All of them choose at the same moment, as in the rules: the doctor never learns whom the
    # mafia picked, so the order only changes how the night is told, not how it ends.
    # With night pacing, each question is heard before its answer shows, one step after another.
    for player in [player for player in players if player.special_role == DOCTOR_ROLE]:
        line = moderator_line("ask_doctor", players, round_number)
        log_narration(line, "ask_doctor")
        hear(line)
        target = players_by_name.get(player.wait_for_vote())
        if target:
            protected_name = target.name
            player.add_private_note(f"Night {round_number}: you protected {target.name}.")
            log_event("protect", doctor=player.name, target=target.name)
            hold()
    # The detective, and in the misinformation variant the false detective too: both believe
    # they are the detective, so the moderator asks once and both answer.
    investigators = [player for player in players
                     if player.special_role in (DETECTIVE_ROLE, FALSE_DETECTIVE_ROLE)]
    if investigators:
        line = moderator_line("ask_detective", players, round_number)
        log_narration(line, "ask_detective")
        hear(line)
    for player in investigators:
        target = players_by_name.get(player.wait_for_vote())
        if target:
            told = target.is_mafia
            if player.special_role == FALSE_DETECTIVE_ROLE:  # the storyteller chooses its answer
                truth = "mafia" if target.is_mafia else "not mafia"
                told = storyteller_choice(
                    f"{player.name} is the false detective: a villager who believes they are the "
                    f"detective. Tonight they asked about {target.name}, who is really {truth}. "
                    f"What do you tell {player.name}?", ["mafia", "not mafia"],
                    players, round_number) == "mafia"
            result = "is MAFIA" if told else "is NOT mafia"
            player.add_private_note(f"Night {round_number}: you investigated {target.name} - "
                                    f"{target.name} {result}.")
            # misled: the answer was false (spectators see it in god view only)
            log_event("investigate", detective=player.name, target=target.name, is_mafia=told,
                      **({"misled": True} if told != target.is_mafia else {}))
            hold()
    return protected_name


def storyteller_choice(question, options, players, round_number):
    """
    A storyteller decision (misinformation variant): the moderator's model when there is one,
    otherwise a random choice. It knows every role, so it is never narrated.
    """
    if moderator is None:
        return random.choice(options)
    return moderator.decide(question, options, round=round_number,
                            living_players_and_roles="; ".join(f"{p.name}: {p.role}" for p in players),
                            out_so_far="; ".join(public_history) or "nobody")


def voting_sub_phase(phase_name, voting_players, optional_votes_players, public_chat_file, players,
                     round_number, unheard=None):
    """unheard: a moderator line just said with no discussion after it (a night with one mafia
    player), heard out here, once the vote is open and nobody can talk, before the questions."""
    notify_players_about_voting_time(phase_name, public_chat_file)
    log_event("vote_open", phase=PHASE_EVENT_NAMES[phase_name], round=round_number)
    # A player may have sent a message just before seeing the voting status. Relay it now:
    # left unread, it would surface at the start of a later phase.
    time.sleep(POLL_SECONDS)
    run_chat_round_between_players(voting_players, public_chat_file, phase_name)
    moment = "vote_open" if phase_name == DAYTIME else "ask_mafia"
    line = moderator_line(moment, players, round_number)
    if phase_name == NIGHTTIME:
        hear(unheard)  # "night falls" first, then the mafia's question
    log_narration(line, moment)
    if phase_name == NIGHTTIME:
        hear(line)
    voted_out_name = get_voted_out_name(optional_votes_players, public_chat_file,
                                        voting_players[:], phase_name)
    if phase_name == NIGHTTIME:
        hold()  # the mafia's choice, before the doctor is asked
    if phase_name == NIGHTTIME and run_night_roles(players, round_number) == voted_out_name:
        game_manager_announcement(NOBODY_ELIMINATED_MESSAGE)
        log_event("saved", name=voted_out_name)
        public_history.append(f"night {round_number}: nobody died")
        log_narration(moderator_line("saved", players, round_number), "saved")
        return
    # update info file of remaining players
    remaining_players = (game_dir / REMAINING_PLAYERS_FILE).read_text().splitlines()
    remaining_players.remove(voted_out_name)
    (game_dir / REMAINING_PLAYERS_FILE).write_text("\n".join(remaining_players))
    # update player object status
    voted_out_player = {player.name: player for player in optional_votes_players}[voted_out_name]
    voted_out_player.eliminate()
    players.remove(voted_out_player)
    announce_voted_out_player(voted_out_player, phase_name)
    how = "killed by the mafia during the night" if phase_name == NIGHTTIME else "voted out by the town"
    public_history.append(f"{voted_out_player.name} ({voted_out_player.role}), {how} "
                          f"in round {round_number}")
    log_narration(moderator_line("eliminated", players, round_number, name=voted_out_player.name,
                                 role=voted_out_player.role, how=how), "eliminated")


def game_manager_announcement(message):
    with open(game_dir / PUBLIC_MANAGER_CHAT_FILE, "a") as f:
        f.write(format_message(GAME_MANAGER_NAME, message))


def announce_voted_out_player(voted_out_player, phase_name):
    is_night = phase_name == NIGHTTIME
    message_format = NIGHT_KILL_MESSAGE_FORMAT if is_night else VOTED_OUT_MESSAGE_FORMAT
    game_manager_announcement(message_format.format(voted_out_player.name, voted_out_player.role))
    log_event("eliminated", name=voted_out_player.name, role=voted_out_player.role,
              cause="night" if is_night else "vote")


def run_phase(players, voting_players, optional_votes_players, public_chat_file,
              time_limit_seconds, phase_name, round_number, opening=None):
    is_discussion = len(voting_players) > 1
    log_event("phase", phase=PHASE_EVENT_NAMES[phase_name], round=round_number,
              duration=time_limit_seconds if is_discussion else 0)
    log_narration(opening, PHASE_EVENT_NAMES[phase_name] + "_start")
    if is_discussion:
        start_time = time.time()
        while time.time() - start_time < time_limit_seconds:
            run_chat_round_between_players(voting_players, public_chat_file, phase_name)
            time.sleep(POLL_SECONDS)
    else:
        game_manager_announcement(CUTTING_TO_VOTE_MESSAGE)
    print("Now voting starts...")
    voting_sub_phase(phase_name, voting_players, optional_votes_players, public_chat_file, players,
                     round_number, None if is_discussion else opening)


def run_nighttime(players, nighttime_minutes, round_number, opening=None):
    (game_dir / PHASE_STATUS_FILE).write_text(NIGHTTIME)
    mafia_players = [player for player in players if player.is_mafia]
    bystanders = [player for player in players if not player.is_mafia]
    print(colored(NIGHTTIME_START_MESSAGE_FORMAT.format(nighttime_minutes), NIGHTTIME_COLOR))
    game_manager_announcement(NIGHTTIME_START_MESSAGE_FORMAT.format(nighttime_minutes))
    run_phase(players, mafia_players, bystanders, game_dir / PUBLIC_NIGHTTIME_CHAT_FILE,
              minutes_to_seconds(nighttime_minutes), NIGHTTIME, round_number, opening)


def run_daytime(players, daytime_minutes, round_number, opening=None):
    (game_dir / PHASE_STATUS_FILE).write_text(DAYTIME)
    print(colored(DAYTIME_START_MESSAGE_FORMAT.format(daytime_minutes), DAYTIME_COLOR))
    game_manager_announcement(DAYTIME_START_MESSAGE_FORMAT.format(daytime_minutes))
    run_phase(players, players, players, game_dir / PUBLIC_DAYTIME_CHAT_FILE,
              minutes_to_seconds(daytime_minutes), DAYTIME, round_number, opening)


def wait_for_players(players):
    havent_joined_yet = [player for player in players]
    print("Waiting for all players to connect and start running their programs to join:")
    print(",  ".join([player.name for player in havent_joined_yet]))
    while havent_joined_yet:
        joined = []
        for player in havent_joined_yet:
            if bool(player.personal_status_file.read_text()):  # file isn't empty once joined
                joined.append(player)
                print(f"{player.name} has joined!")
        for player in joined:
            havent_joined_yet.remove(player)
        time.sleep(POLL_SECONDS)
    (game_dir / GAME_START_TIME_FILE).write_text(get_current_timestamp())
    print("Game is now running! Its content is displayed to players.")


def get_all_player_out_of_voting_time():
    current_phase = (game_dir / PHASE_STATUS_FILE).read_text()
    (game_dir / PHASE_STATUS_FILE).write_text(current_phase.replace(VOTING_TIME, ""))


def end_game(players, round_number):
    get_all_player_out_of_voting_time()
    is_mafia_win = MAFIA_WINS_MESSAGE in (game_dir / WHO_WINS_FILE).read_text()
    winner = "mafia" if is_mafia_win else "town"
    mafia_names = (game_dir / MAFIA_NAMES_FILE).read_text().splitlines()
    log_narration(moderator_line("game_over", players, round_number, winner=winner,
                                 mafia=", ".join(mafia_names)), "game_over")
    log_event("game_over", winner=winner)
    print("Game has finished.")


def main():
    global game_dir, moderator, night_pacing
    game_dir = get_game_dir_from_argv()
    config = get_config()
    players = get_players(config)
    if config.get(MODERATOR_MODEL_KEY):
        moderator = Moderator(config[MODERATOR_MODEL_KEY], game_dir, config.get(MODERATOR_VOICE_KEY))
    night_pacing = config.get(NIGHT_PACING_KEY, False)
    # A round is Daytime then Nighttime, or with night_first (autonomous games) Nighttime then
    # Daytime: the first discussion then has a night's result to work with, and nobody votes
    # before anyone has died.
    is_night_first = config.get(NIGHT_FIRST_KEY, False)
    first, second = (run_nighttime, run_daytime) if is_night_first else (run_daytime, run_nighttime)
    first_minutes, second_minutes = (
        (config[NIGHTTIME_MINUTES_KEY], config[DAYTIME_MINUTES_KEY]) if is_night_first
        else (config[DAYTIME_MINUTES_KEY], config[NIGHTTIME_MINUTES_KEY]))
    first_moment, second_moment = ("night_start", "day_start") if is_night_first \
        else ("day_start", "night_start")
    if is_night_first:  # before anyone joins: no town player may talk in the first moments
        (game_dir / PHASE_STATUS_FILE).write_text(NIGHTTIME)
    round_number = 1
    # Each opening line is asked for before its phase starts: here while the players are still
    # joining, later while they wait for the last vote to close.
    opening = moderator_line("first_night" if is_night_first else "first_day", players, round_number)
    wait_for_players(players)
    while True:
        first(players, first_minutes, round_number, opening)
        if is_game_over(players):
            break
        second(players, second_minutes, round_number,
               moderator_line(second_moment, players, round_number))
        if is_game_over(players):
            break
        round_number += 1
        opening = moderator_line(first_moment, players, round_number)
    end_game(players, round_number)


if __name__ == '__main__':
    main()
