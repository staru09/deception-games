// node frontend/state.check.mjs
// Replays the scripted fixture through state.js and asserts what the viewer relies on.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PALETTE, initialState, apply, toSnapshot, aliveCounts, completeLines, roleOf, isSpoiler, liveness } from './state.js';

const demo = new URL('./fixtures/games/demo/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', demo), 'utf8'));
const events = completeLines(readFileSync(new URL('events.jsonl', demo), 'utf8')).map((l) => JSON.parse(l));

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks++; };

const freeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(freeze); }
  return o;
};
const alive = (s) => s.order.filter((n) => s.players[n].alive);
// State after the first event matching `pred` (and everything before it).
const upTo = (pred) => {
  const end = events.findIndex(pred);
  assert.ok(end >= 0, 'fixture is missing an expected event');
  return events.slice(0, end + 1).reduce(apply, initialState(config));
};
const ALL = ['Riley', 'Morgan', 'Quinn', 'Sage', 'Harper', 'Ziggy', 'Eden'];

// --- palette and initial state ---
eq(PALETTE, ['#f2c14e', '#4ea8de', '#b388eb', '#ff8c42', '#3ddbd9', '#f78fb3', '#a3d977', '#c9ada7'], 'palette matches the contract');
const s0 = initialState(config);
eq(s0.order, ALL, 'seat order follows config.players');
eq(alive(s0), ALL, 'everyone starts alive');
eq([s0.phase, s0.round, s0.started, s0.winner], ['day', 1, false, null], 'before the first event: day 1, not started');
eq(ALL.map((n) => s0.players[n].role), ['villager', 'mafia', 'detective', 'villager', 'doctor', 'mafia', 'villager'], 'roles from is_mafia / special_role');
eq(roleOf({ is_mafia: false, special_role: '' }), 'villager', 'empty special_role is a villager');
ALL.forEach((n, seat) => eq(s0.players[n].color, PALETTE[seat % PALETTE.length], `colour of seat ${seat}`));
eq(s0.players.Morgan.model, 'anthropic/claude-opus-5.5', 'model from llm_config.model_name');
eq(initialState({ players: Array.from({ length: 9 }, (_, i) => ({ name: 'P' + i })) }).players.P8.color, PALETTE[0], 'palette wraps after 8 seats');

// --- every step: purity and snapshot shape ---
const SNAP_KEYS = ['phase', 'round', 'voting', 'players', 'votes', 'protect', 'investigate', 'winner'];
let s = s0;
for (const [i, ev] of events.entries()) {
  const next = apply(freeze(s), ev);   // a frozen input throws if apply mutates it
  assert.notStrictEqual(next, s);
  eq(next.count, i + 1, 'count is the number of events applied');
  const snap = toSnapshot(next);
  eq(Object.keys(snap), SNAP_KEYS, `snapshot keys after event ${i}`);
  ok(snap.phase === 'day' || snap.phase === 'night', 'snapshot.phase');
  ok(Number.isInteger(snap.round) && snap.round >= 1, 'snapshot.round');
  ok(typeof snap.voting === 'boolean', 'snapshot.voting');
  eq(Object.keys(snap.players), ALL, 'snapshot.players is keyed by name in seat order');
  for (const p of Object.values(snap.players)) {
    eq(Object.keys(p), ['alive', 'cause'], 'snapshot player shape');
    ok(p.alive ? p.cause === null : p.cause === 'vote' || p.cause === 'night', 'cause is set exactly when dead');
  }
  ok(Array.isArray(snap.votes) && snap.votes.every((v) => Object.keys(v).join() === 'voter,target'), 'snapshot.votes shape');
  ok(snap.voting || snap.votes.length === 0, 'no votes unless a vote is open');
  ok(snap.protect === null || Object.keys(snap.protect).join() === 'doctor,target', 'snapshot.protect shape');
  ok(snap.investigate === null || Object.keys(snap.investigate).join() === 'detective,target,is_mafia', 'snapshot.investigate shape');
  ok(snap.phase === 'night' || (snap.protect === null && snap.investigate === null), 'no night actions by day');
  ok([null, 'mafia', 'town'].includes(snap.winner), 'snapshot.winner');
  s = next;
}
const end = s;

// --- day 1 ---
let at = upTo((e) => e.type === 'phase');
eq([at.phase, at.round, at.started, at.phaseTs, at.duration, at.discussion], ['day', 1, true, 1763200000, 60, true], 'day 1 opens with its timer');
at = upTo((e) => e.type === 'vote' && e.voter === 'Sage');
eq([at.voting, at.votes.length, at.discussion], [true, 3, false], 'three votes into the day 1 vote');
eq(toSnapshot(at).votes, [{ voter: 'Morgan', target: 'Riley' }, { voter: 'Ziggy', target: 'Riley' }, { voter: 'Sage', target: 'Riley' }], 'open vote in the snapshot');
eq(alive(at), ALL, 'nobody is out while the vote is open');
at = upTo((e) => e.type === 'eliminated');
eq(alive(at), ALL.filter((n) => n !== 'Riley'), 'Riley is voted out on day 1');
eq(toSnapshot(at).players.Riley, { alive: false, cause: 'vote' }, 'Riley in the snapshot');
eq(at.players.Riley.diedIn, { phase: 'day', round: 1 }, 'when Riley died');
eq([at.voting, at.votes], [false, []], 'the vote closes on elimination');
eq(aliveCounts(at), { town: 4, mafia: 2 }, 'counts after day 1');

// --- night 1: mafia chat, doctor save, detective hit ---
at = upTo((e) => e.type === 'phase' && e.phase === 'night');
eq([at.phase, at.round, at.duration], ['night', 1, 30], 'night 1');
at = upTo((e) => e.type === 'protect');
eq(toSnapshot(at).investigate, { detective: 'Quinn', target: 'Morgan', is_mafia: true }, 'investigation in the snapshot');
eq(toSnapshot(at).protect, { doctor: 'Harper', target: 'Sage' }, 'protection in the snapshot');
eq(toSnapshot(at).votes, [{ voter: 'Morgan', target: 'Sage' }, { voter: 'Ziggy', target: 'Sage' }], 'mafia votes in the snapshot');
at = upTo((e) => e.type === 'saved');
ok(at.players.Sage.alive && at.players.Sage.cause === null, 'the doctor save leaves Sage alive');
eq(alive(at), ALL.filter((n) => n !== 'Riley'), 'nobody died on night 1');
eq([at.voting, at.discussion], [false, false], 'the night vote closes on the save');

// --- day 2, night 2, day 3 ---
at = upTo((e) => e.type === 'phase' && e.round === 2);
eq([at.phase, at.round, at.protect, at.investigate, at.votes], ['day', 2, null, null, []], 'day 2 clears the night actions');
at = upTo((e) => e.type === 'eliminated' && e.name === 'Morgan');
eq(alive(at), ['Quinn', 'Sage', 'Harper', 'Ziggy', 'Eden'], 'Morgan is voted out on day 2');
eq(aliveCounts(at), { town: 4, mafia: 1 }, 'counts after day 2');
at = upTo((e) => e.type === 'phase' && e.phase === 'night' && e.round === 2);
eq([at.phase, at.round, at.duration], ['night', 2, 0], 'night 2 has no discussion');
at = upTo((e) => e.type === 'eliminated' && e.name === 'Quinn');
eq(alive(at), ['Sage', 'Harper', 'Ziggy', 'Eden'], 'Quinn dies on night 2');
eq(toSnapshot(at).players.Quinn, { alive: false, cause: 'night' }, 'Quinn in the snapshot');
eq(at.winner, null, 'no winner yet');
at = upTo((e) => e.type === 'phase' && e.round === 3);
eq([at.phase, at.round], ['day', 3], 'day 3');

// --- end ---
eq(end.winner, 'town', 'town wins');
eq(toSnapshot(end).winner, 'town', 'winner in the snapshot');
eq(alive(end), ['Sage', 'Harper', 'Eden'], 'final alive set');
eq([end.phase, end.round, end.voting], ['day', 3, false], 'final phase');
eq(aliveCounts(end), { town: 3, mafia: 0 }, 'final counts');

// --- votes per player ---
eq(end.players.Riley.received.map((v) => v.voter), ['Morgan', 'Ziggy', 'Sage', 'Eden'], 'votes Riley received');
eq(end.players.Morgan.cast, [
  { phase: 'day', round: 1, target: 'Riley' }, { phase: 'night', round: 1, target: 'Sage' }, { phase: 'day', round: 2, target: 'Quinn' },
], 'votes Morgan cast, with the night one marked');
eq(end.players.Sage.received, [{ phase: 'night', round: 1, voter: 'Morgan' }, { phase: 'night', round: 1, voter: 'Ziggy' }], 'votes Sage received');

// --- the thread and its spoiler flags ---
for (const e of end.entries) {
  const ev = events[e.i];
  const want = ev.type === 'investigate' || ev.type === 'protect'
    || (['message', 'vote_open', 'vote'].includes(ev.type) && ev.phase === 'night');
  eq(e.spoiler, want, `spoiler flag of entry ${e.i} (${ev.type})`);
  eq(isSpoiler(ev), want, `isSpoiler of event ${e.i} (${ev.type})`);
  ok(e.ts === ev.ts && ['day', 'night'].includes(e.phase) && e.round >= 1, 'entry carries ts, phase and round');
}
eq(end.entries.length, events.length, 'one thread entry per fixture event');
const kindsOf = (pred) => [...new Set(end.entries.filter(pred).map((e) => e.kind))].sort();
eq(kindsOf((e) => e.spoiler), ['investigate', 'message', 'protect', 'vote', 'vote_open'], 'kinds of spoiler entries');
ok(end.entries.filter((e) => e.phase === 'day').every((e) => !e.spoiler), 'no day entry is a spoiler');
eq(end.entries.filter((e) => e.spoiler && e.kind === 'message').map((e) => e.name), ['Morgan', 'Ziggy', 'Morgan', 'Ziggy'], 'the mafia night chat');
eq(end.entries.filter((e) => e.spoiler && e.kind === 'vote').length, 3, 'three night votes');
const town = end.entries.filter((e) => !e.spoiler);   // what town view may show
ok(!town.some((e) => e.kind === 'message' && /that was clean|sage it is|onto us/.test(e.text)), 'town view has no mafia chat');
ok(!town.some((e) => e.kind === 'investigate' || e.kind === 'protect'), 'town view has no private actions');
eq(town.filter((e) => e.phase === 'night').map((e) => e.kind), ['phase', 'saved', 'phase', 'eliminated'], 'what town view sees of the nights');
eq(end.entries.find((e) => e.kind === 'saved').spoiler, false, 'the save is public (as "nobody died")');
eq(end.entries.filter((e) => e.kind === 'eliminated').map((e) => [e.name, e.role, e.cause]),
  [['Riley', 'villager', 'vote'], ['Morgan', 'mafia', 'vote'], ['Quinn', 'detective', 'night'], ['Ziggy', 'mafia', 'vote']], 'eliminations carry role and cause');
eq(end.entries.at(-1), { i: events.length - 1, ts: events.at(-1).ts, kind: 'game_over', phase: 'day', round: 3, spoiler: false, winner: 'town' }, 'last entry');

// --- robustness ---
const odd = [
  { ts: 1, type: 'weather', sky: 'rain' },
  { ts: 2, type: 'vote', voter: 'constructor', target: '__proto__', phase: 'day' },
  { ts: 3, type: 'eliminated', name: 'Nobody', role: 'villager', cause: 'vote' },
].reduce(apply, s0);
eq([alive(odd), odd.entries.length, odd.count], [ALL, 2, 3], 'unknown event types and unknown names are harmless');
eq(completeLines('{"a":1}\n{"b":2}\n{"c":'), ['{"a":1}', '{"b":2}'], 'a last line without a newline is ignored');
eq(completeLines('{"a":1}'), [], 'a lone partial line is ignored');
eq(completeLines(''), [], 'an empty file has no lines');

// --- is the game still being played? ---
const over = { type: 'game_over' }, msg = { type: 'message' };
const live = (lastEvent, entry, idleS = 0) => liveness({ lastEvent, entry, idleS, quietS: 600 });
eq(live(msg, { winner: null }), 'live', 'listed as running');
eq(live(undefined, { winner: null }, 9999), 'live', 'a listed game is never given up on for being quiet: the launcher will mark it');
eq(live(over, { winner: null }), 'over', 'game_over ends it before the launcher updates the index');
eq(live(msg, { winner: 'town' }), 'over', 'the index has the result');
eq(live(msg, { winner: 'aborted' }), 'aborted', 'the launcher aborted it');
eq(live(undefined, { winner: 'aborted' }), 'aborted', 'aborted before its first event');
eq(live(over, { winner: 'aborted' }), 'over', 'a game that reached game_over was not aborted');
eq(live(msg, undefined, 599), 'live', 'not in the index, recently active');
eq(live(msg, undefined, 601), 'quiet', 'not in the index and silent for too long');
eq(live(over, undefined, 601), 'over', 'not in the index but finished');

// --- moderator narration: a public chat entry, also at night, that changes nothing else ---
const atNight = upTo((e) => e.type === 'phase' && e.phase === 'night');
const narrated = apply(atNight, { ts: 1, type: 'narration', text: 'Night falls.', moment: 'night_start' });
eq(narrated.entries.at(-1), { i: atNight.count, ts: 1, kind: 'narration', phase: 'night', round: atNight.round,
  spoiler: false, text: 'Night falls.', moment: 'night_start' }, 'narration is a public entry, even at night');
eq({ ...narrated, entries: atNight.entries, count: atNight.count }, atNight, 'narration changes no game state');

// --- one voice: narration absorbs the plain line it announces ---
// The fixture with a moderator, in the order the backend writes; a late message sits between day 1's vote_open and its narration.
const NARRATE = { phase: (e) => e.phase + '_start', vote_open: (e) => (e.phase === 'night' ? 'ask_mafia' : 'vote_open'),
  eliminated: () => 'eliminated', saved: () => 'saved' };
const modded = events.flatMap((e, k) => {
  const nar = (moment) => ({ ts: e.ts, type: 'narration', text: moment + '!', moment });
  if (e.type === 'game_over') return [nar('game_over'), e];
  const out = [e];
  if (k === events.findIndex((x) => x.type === 'vote_open')) out.push({ ts: e.ts, type: 'message', name: 'Eden', text: 'late', phase: 'day' });
  if (NARRATE[e.type]) out.push(nar(NARRATE[e.type](e)));
  return out;
});
let m = s0;
for (const ev of modded) m = apply(freeze(m), ev);
eq({ ...m, entries: end.entries, count: end.count }, end, 'narration changes no game state over a whole game');
eq(m.entries.filter((e) => e.absorbed).map((e) => `${e.kind} ${e.phase} ${e.round}`), ['vote_open day 1', 'eliminated day 1', 'saved night 1',
  'vote_open day 2', 'eliminated day 2', 'eliminated night 2', 'vote_open day 3', 'eliminated day 3'], 'absorbed: day votes, deaths, the save; not the night vote');
for (const n of m.entries.filter((e) => e.kind === 'narration')) {
  const was = m.entries.find((e) => e.absorbed && e.i === n.fact?.i);
  if (['vote_open', 'eliminated', 'saved'].includes(n.moment)) eq({ ...n.fact, absorbed: true }, was, `narration ${n.moment} carries the line it absorbed`);
  else ok(!('fact' in n), `narration ${n.moment} absorbs nothing`);
  ok(!n.spoiler, 'a narration entry is never a spoiler');
}
const strip = ({ i, absorbed, ...e }) => e;
eq(m.entries.filter((e) => e.kind !== 'narration' && e.text !== 'late').map(strip), end.entries.map(strip), 'the plain entries are otherwise unchanged');
ok(end.entries.every((e) => !('absorbed' in e) && !('fact' in e)), 'a game without narration has nothing absorbed');

console.log(`state.check: ${checks} checks passed over ${events.length} fixture events`);
