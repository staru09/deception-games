# LLMafia - Asynchronous LLM Agent

Our Mafia games code for an **Asynchronous LLM Agent** playing games of *Mafia* with multiple human players.

<p align="center">
    🌐 <a href="https://niveck.github.io/Time-to-Talk/" target="_blank">Project</a> | 📃 <a href="https://aclanthology.org/2025.findings-emnlp.608/" target="_blank">Paper</a> | 📚 <a href="https://huggingface.co/datasets/niveck/LLMafia" target="_blank">Dataset</a><br>
</p>


![](https://raw.githubusercontent.com/niveck/LLMafia/main/figures/llmafia_cover_figure.gif)
*A virtual game of Mafia, played by human players and an LLM agent player. The agent integrates in the asynchronous group conversation by constantly simulating the decision to send a message.*
___

> **Time to Talk: 🕵️‍♂️ LLM Agents for Asynchronous Group Communication in Mafia Games**<br>
> Niv Eckhaus, Uri Berger, Gabriel Stanovsky<br>
> <a href="https://aclanthology.org/2025.findings-emnlp.608/" target="_blank">https://aclanthology.org/2025.findings-emnlp.608/</a><br>
>
>**Abstract:** LLMs are used predominantly in *synchronous* communication, where a human user and a model communicate in alternating turns. In contrast, many real-world settings are *asynchronous*. For example, in group chats, online team meetings, or social games, there is no inherent notion of turns. In this work, we develop an adaptive asynchronous LLM agent consisting of two modules: a generator that decides *what to say*, and a scheduler that decides *when to say it*. To evaluate our agent, we collect a unique dataset of online Mafia games, where our agent plays with human participants. Overall, our agent performs on par with human players, both in game performance metrics and in its ability to blend in with the other human players. Our analysis shows that the agent's behavior in deciding when to speak closely mirrors human patterns, although differences emerge in message content. We make all of our code and data publicly available. This work paves the way for integration of LLMs into realistic human group settings, from assistance in team discussions to educational and professional environments where complex social dynamics must be navigated.

In our paper we propose an agent designed for asynchronous conversations. Our agent consists of two modules: the *scheduler*, deciding whether to post a message to the chat at a given moment, and the *generator*, which composes the message content.

## Asynchronous Agent

![](https://raw.githubusercontent.com/niveck/LLMafia/main/figures/agent_logic_design_figure.gif)
*Schematic display of the agent's logic design. A detailed overview of the agent's structure can be found in our paper.*

## The Game of Mafia

<img align="right"  width="250"  src="https://raw.githubusercontent.com/niveck/LLMafia/main/figures/game_rules.png">

We choose to set our evaluation of asynchrony modeling for LLMs in a game setting.

Games give each participant an objective. Winning the game is a proxy metric of whether the communication was successful. It sets the conversation under a frame of rules, where each participant needs to use the communication to advance to their target.

We choose *Mafia*, a social deduction game in which each player is secretly assigned a role, either *mafia* or *bystander*. Only mafia players are aware of all players' roles. Every round starts with a daytime phase, where all players discuss who they think the mafia players might be, and vote out one player. Then the game moves to a nighttime phase, where only mafia players interact and vote to decide which bystander they want to eliminate. In the next round's daytime, the mafia's victim is revealed. The game continues until one of the teams achieves their objective: the mafia's goal is to outnumber the bystanders, and the bystanders' goal is to vote out all mafia.

We choose the game of Mafia for evaluating our several reasons. First, it can be based solely on textual interaction, which allows LLMs to play together with human players. Second, it requires collaboration under uncertainty, making communication between participants a fundamental aspect of the game. Third, it centers around suspicion of other players, so both extreme strategies of constantly speaking or not speaking at all can be seen as suspicious. Therefore, the timing of communication is crucial for the player's success.


## LLMafia Dataset

The collected data of games is available in the `games` directory of the [original LLMafia repository](https://github.com/niveck/LLMafia).
Each game subdirectory contains files with the messages sent by all players, human and LLM, in addition to game-management messages, metadata, results and each game's configuration (after being anonymized).

For a detailed overview of the dataset and files and for accessible download, [visit the dataset page on HuggingFace](https://huggingface.co/datasets/niveck/LLMafia).   

Analysis of the dataset is described thoroughly in our paper, with a focus on our LLM agent performance in the game from different perspectives.


## Autonomous games: every seat is an LLM

This copy of the repository can also play games with no humans at all, to study whether stronger models out-deceive weaker ones. Every seat is a model served through [OpenRouter](https://openrouter.ai), the town gets a detective and a doctor, and a 3D viewer shows the games live or as replays.

The code is split into `backend/` (the game engines and launchers, and `server.py`) and `frontend/` (the dashboard and one viewer per game, static files). Run everything from `backend/`:

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install termcolor requests pandas

# dry run with mock players: plays a full game without any API call
.venv/bin/python run_autonomous.py configurations/mock_6p.json

# real games: first put OpenRouter model ids into the table config
export OPENROUTER_API_KEY=...
.venv/bin/python run_autonomous.py configurations/autonomous_6p.json --games 10

.venv/bin/python analyze_autonomous.py   # win rate per model; writes seats.csv and games.csv
.venv/bin/python server.py               # the viewer, on http://127.0.0.1:8000
.venv/bin/python selfcheck.py            # checks the engine end to end with mock players
python ../frontend/mafia/fixtures/make_fixture.py && node ../frontend/mafia/state.check.mjs   # checks the viewer
```

- **Table config:** one entry per seat with a `role` (`mafia`, `detective`, `doctor`, `villager`) and a `model`. Any other key of a seat (`reasoning`, `temperature`, `max_tokens`, `provider`) is sent to OpenRouter for that seat. `"shuffle_roles": true` deals the roles to the models anew every game.
- **Order of play:** a game starts at night, after the moderator's welcome, so nobody votes before anyone has died. Each night the moderator asks the mafia whom to kill, then the doctor whom to save, then the detective whom they doubt (the detective privately learns whether that player is mafia, and must never reveal their role or results in the chat). The three choose at the same time, but for spectators the night is told one step at a time: each question is heard before its answer shows (`"night_pacing": false` in the table config turns this off). Each day everyone discusses, then votes one player out.
- **Moderator:** an LLM (`"moderator"` in the table config, Claude Haiku by default, `null` for none) welcomes the players, runs the night's questions, opens each day with an agenda, calls the vote and declares every result. With `DEEPGRAM_API_KEY` set, a Deepgram voice speaks its lines (`"voice"` in the table config, `flux-hannah-en` by default, `null` for none); the viewer plays them at 1× speed and has a button to mute them. Its lines go only to the viewer (`narration` events); the players never see them, so they play exactly as before.
- **Cost:** on every turn a player asks its model, with the whole chat so far, whether to speak. `"llm_defaults": {"seconds_between_turns": 2}` in the table config is the pause after each turn, so it sets how many calls a game makes; without it a player asks again right away. Each call's token usage and cost is saved in `<Name>_reasoning.jsonl`.
- **Output:** each game gets a directory in `backend/autonomous_games/`, with the files of the original format plus `events.jsonl` (everything that happened, in order) and `<Name>_reasoning.jsonl` (the reasoning trace, output and token usage of every model call).
- **Elo:** `analyze_autonomous.py` reads the models' ratings from `configurations/model_elo.json` (`{"<model id>": <elo>}`).
- **Viewer:** the server listens on localhost only, because the game directories hold full prompts and reasoning traces. From another machine, open an SSH tunnel first: `ssh -L 8000:127.0.0.1:8000 <host>`. The 3D village is at `/mafia/` and `/misinformation/`; `LLMAFIA_GAMES_DIR` shows another games directory.



## The arena: four games, one dashboard

Two more deception games run next to Mafia, and a dashboard starts and lists runs of all four. Every game has its own viewer, live or as a replay, and the viewers show player names only, never model names.

| Game | Engine | Viewer |
|---|---|---|
| Mafia | `run_autonomous.py` | `/mafia/` (3D village) |
| Misinformation Mafia | `run_autonomous.py`, `"variant": "misinformation"` | `/misinformation/` (the village, re-themed) |
| Senate: an original hidden-role game (Loyalists vs a hidden Conspiracy and its Usurper, Secret Hitler's mechanics) | `senate/` | `/senate/` |
| Heads-up no-limit Hold'em, in duplicate pairs (same cards, seats swapped) | `poker/` | `/poker/` |

```bash
# the dashboard: start the server with the OpenRouter key in its environment, then open http://127.0.0.1:8000/
.venv/bin/python server.py

# or from the command line (mock tables play offline; real tables need OPENROUTER_API_KEY)
.venv/bin/python -m arena.run senate configurations/senate/mock_7p.json --games 3 --parallel 3
.venv/bin/python -m arena.run poker configurations/poker/experiment.json --games 5   # 5 duplicate pairs
.venv/bin/python analyze_arena.py senate        # win rate per model and team, with the win reasons
.venv/bin/python analyze_arena.py poker         # bb/100 per model, duplicate pairs combined

# checks (mock players only, no API calls)
.venv/bin/python -m senate.selfcheck && .venv/bin/python -m poker.selfcheck && .venv/bin/python server.check.py
node ../frontend/senate/state.check.mjs && node ../frontend/poker/state.check.mjs
```

- **Dashboard:** pick a game to see its runs (with Watch links), start a new run from a saved table or by editing the seats and their models, and stop a running launcher. Before any run with a real model it shows the models and a cost estimate (the average of that game's past runs) and asks for confirmation. Only one launcher runs per data directory (Mafia and Misinformation Mafia share one). Launchers keep running when the server stops or restarts; stop them from the dashboard.
- **Contract:** [docs/ARENA_CONTRACT.md](docs/ARENA_CONTRACT.md) fixes the events, data layout and API that the engines, viewers and server share.
- **Output:** `backend/senate_games/` and `backend/poker_games/` (or `SENATE_GAMES_DIR`, `POKER_GAMES_DIR`), in the same format as Mafia's: `index.json`, and per game `config.json`, `events.jsonl` and each seat's `<Name>_log.txt` and `<Name>_reasoning.jsonl`.

## Citation
If you find this useful for your research, please use the following:

```
@inproceedings{eckhaus-etal-2025-time,
  title = "Time to Talk: {LLM} Agents for Asynchronous Group Communication in Mafia Games",
  author = "Eckhaus, Niv and Berger, Uri and Stanovsky, Gabriel",
  booktitle = "Findings of the Association for Computational Linguistics: EMNLP 2025",
  year = "2025",
  publisher = "Association for Computational Linguistics",
  url = "https://aclanthology.org/2025.findings-emnlp.608/",
  pages = "11356--11368"
}
```
