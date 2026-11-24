// Pure game-state reducer for the viewer. No DOM, no Three.js: runs in the browser and under Node.
// apply() never mutates its input, so a state can be kept and replayed from at any time.

export const PALETTE = ['#f2c14e', '#4ea8de', '#b388eb', '#ff8c42', '#3ddbd9', '#f78fb3', '#a3d977', '#c9ada7'];

export const roleOf = (p) => (p.is_mafia ? 'mafia' : p.special_role || 'villager');

// CONTRACT.md's spoiler table: events that town view must not see (the mafia's night and private actions).
// The detective's check is not one: spectators see whom it asked about and what it was told
// (which role it really has, and whether the answer was false, stays for god view).
export const isSpoiler = (ev, phase = ev.phase) =>
  ev.type === 'protect'
  || (phase === 'night' && (ev.type === 'message' || ev.type === 'vote_open' || ev.type === 'vote'));

export function initialState(config) {
  const order = [];
  const players = {};
  (config?.players ?? []).forEach((p, seat) => {
    const name = String(p.name);
    order.push(name);
    players[name] = {
      name, seat,
      model: String(p.llm_config?.model_name ?? 'unknown'),
      role: roleOf(p),
      color: PALETTE[seat % PALETTE.length],
      alive: true,
      cause: null,       // null | 'vote' | 'night'
      diedIn: null,      // { phase, round } of the elimination
      cast: [],          // [{ phase, round, target }]  votes this player cast
      received: [],      // [{ phase, round, voter }]   votes cast against this player
    };
  });
  return {
    order, players,
    started: false,      // true once the first phase event has arrived
    phase: 'day', round: 1,
    phaseTs: null, duration: 0,   // ts and discussion seconds of the current phase event
    discussion: false,   // true from a phase event until its vote opens
    voting: false, votes: [],     // the open vote
    protect: null, investigate: null,   // this night's private actions
    winner: null,
    entries: [],         // the chat thread, see add() below
    count: 0,            // events applied so far
  };
}

export function apply(prev, ev) {
  const s = { ...prev, count: prev.count + 1 };
  const patch = (name, change) => {
    if (!Object.hasOwn(s.players, name)) return;   // names are LLM output; ignore strangers
    if (s.players === prev.players) s.players = { ...prev.players };
    s.players[name] = { ...s.players[name], ...change(s.players[name]) };
  };
  const night = (ev.phase ?? s.phase) === 'night';
  // A thread entry. `spoiler` entries are shown only in god view or after game_over.
  // `i` counts the events applied before this one (its line in events.jsonl when every line parsed).
  const add = (kind, data) => {
    const spoiler = isSpoiler(ev, night ? 'night' : 'day');
    s.entries = [...prev.entries, { i: prev.count, ts: ev.ts, kind, phase: s.phase, round: s.round, spoiler, ...data }];
  };
  const closeVote = () => { s.voting = false; s.votes = []; s.discussion = false; };

  switch (ev.type) {
    case 'phase':
      s.started = true;
      s.phase = ev.phase === 'night' ? 'night' : 'day';
      s.round = Number(ev.round) || s.round;
      s.phaseTs = ev.ts;
      s.duration = Number(ev.duration) || 0;
      s.protect = null;
      s.investigate = null;
      closeVote();
      s.discussion = true;
      add('phase', {});
      break;
    case 'message':
      add('message', { name: ev.name, text: String(ev.text ?? '') });
      break;
    case 'vote_open':
      s.voting = true;
      s.votes = [];
      s.discussion = false;
      add('vote_open', {});
      break;
    case 'vote': {
      const { voter, target } = ev;
      const at = { phase: night ? 'night' : 'day', round: s.round };
      s.votes = [...s.votes, { voter, target }];
      patch(voter, (p) => ({ cast: [...p.cast, { ...at, target }] }));
      patch(target, (p) => ({ received: [...p.received, { ...at, voter }] }));
      add('vote', { voter, target });
      break;
    }
    case 'investigate':
      s.investigate = { detective: ev.detective, target: ev.target, is_mafia: !!ev.is_mafia };
      // misled: the answer was false (misinformation variant); the chat marks it in god view only
      add('investigate', { ...s.investigate, misled: !!ev.misled });
      break;
    case 'protect':
      s.protect = { doctor: ev.doctor, target: ev.target };
      add('protect', s.protect);
      break;
    case 'eliminated': {
      const cause = ev.cause === 'night' ? 'night' : 'vote';
      patch(ev.name, () => ({ alive: false, cause, diedIn: { phase: s.phase, round: s.round } }));
      closeVote();
      add('eliminated', { name: ev.name, role: prev.players[ev.name]?.role ?? ev.role, cause });
      break;
    }
    case 'saved':
      closeVote();
      // Public as "nobody died"; the name is only for god view.
      add('saved', { name: ev.name });
      break;
    case 'tie':   // misinformation variant: the day's vote was tied, nobody is out
      closeVote();
      add('tie', {});
      break;
    case 'narration': {   // the moderator, for spectators; built from public facts, so never a spoiler
      // One voice: when it announces the day's vote, a death or a save, the plain line for that event
      // (the latest one since the phase began; late messages can sit between) folds into this entry
      // as `fact` and is marked `absorbed`, so the thread says it once.
      const moment = String(ev.moment ?? '');
      let j = -1;
      if (['vote_open', 'eliminated', 'saved', 'tie'].includes(moment)) {
        for (let k = prev.entries.length - 1; k >= 0 && prev.entries[k].kind !== 'phase'; k--) {
          const e = prev.entries[k];
          if (e.kind === moment && !e.spoiler && !e.absorbed) { j = k; break; }
        }
      }
      add('narration', { text: String(ev.text ?? ''), moment, ...(j >= 0 && { fact: prev.entries[j] }) });
      if (j >= 0) s.entries[j] = { ...prev.entries[j], absorbed: true };
      break;
    }
    case 'game_over':
      s.winner = ev.winner === 'mafia' ? 'mafia' : 'town';
      closeVote();
      add('game_over', { winner: s.winner });
      break;
    default:   // unknown event types are ignored
  }
  return s;
}

// The shape scene.sync() takes (CONTRACT.md).
export function toSnapshot(s) {
  const players = {};
  for (const name of s.order) players[name] = { alive: s.players[name].alive, cause: s.players[name].cause };
  return {
    phase: s.phase,
    round: s.round,
    voting: s.voting,
    players,
    votes: s.votes.map((v) => ({ ...v })),
    protect: s.protect && { ...s.protect },
    investigate: s.investigate && { ...s.investigate },
    winner: s.winner,
  };
}

export function aliveCounts(s) {
  let town = 0, mafia = 0;
  for (const name of s.order) {
    const p = s.players[name];
    if (p.alive) p.role === 'mafia' ? mafia++ : town++;
  }
  return { town, mafia };
}

// Is the game still being played? CONTRACT.md gives two signs that it is not: a game_over event, and a
// winner in the game's index.json entry (written by the launcher, also when it aborts a game). A game
// index.json does not list has no launcher to speak for it, so it is given up on once it has been
// silent for quietS seconds. Returns 'live' | 'over' | 'aborted' | 'quiet'.
export function liveness({ lastEvent, entry, idleS, quietS }) {
  if (lastEvent?.type === 'game_over') return 'over';   // the events are the truth, whatever the index says
  if (entry?.winner === 'aborted') return 'aborted';
  if (entry?.winner != null) return 'over';
  return entry == null && idleS > quietS ? 'quiet' : 'live';
}

// Lines of a JSONL file that may still be being appended to: a last line only counts once it ends in "\n".
export const completeLines = (text) =>
  text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter((line) => line.trim());
