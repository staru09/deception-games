// node frontend/senate/state.check.mjs
// Replays fixtures/demo through the reducer in town view (spoilers skipped) and god view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { init, apply, powerSlots } from './state.js';

const dir = new URL('./fixtures/demo/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', dir), 'utf8'));
const events = readFileSync(new URL('events.jsonl', dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let checks = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const ok = (c, m) => { assert.ok(c, m); checks++; };

// state after the first event matching pred, in town or god view
const at = (god, pred) => {
  const end = events.findIndex(pred);
  ok(end >= 0, 'fixture lacks an expected event');
  return events.slice(0, end + 1).filter((e) => god || !e.spoiler).reduce(apply, init(config));
};
const alive = (s) => s.players.filter((p) => p.alive).map((p) => p.name);
const type = (t, k = 0) => { let i = -1; return (e) => e.type === t && ++i === k; };

// power slots
eq(powerSlots(5), [null, null, 'peek', 'execution', 'execution', null], '5-6 players');
eq(powerSlots(7), [null, 'investigate', 'special_election', 'execution', 'execution', null], '7-8 players');
eq(powerSlots(10), ['investigate', 'investigate', 'special_election', 'execution', 'execution', null], '9-10 players');

// the draw/discard/enacted counts always add up, in both views
for (const god of [false, true]) {
  let s = init(config);
  for (const ev of events) {
    if (ev.type === 'round') {
      eq(s.drawPile, ev.draw_pile, `draw pile before round ${ev.n} (god ${god})`);
      eq(s.discardPile, ev.discard_pile, `discard pile before round ${ev.n} (god ${god})`);
      eq(ev.draw_pile + ev.discard_pile + s.reforms + s.decrees, 17, 'deck adds up to 17');
    }
    if (god || !ev.spoiler) apply(s, ev);
  }
}

// start
const s0 = init(config);
eq([s0.reforms, s0.decrees, s0.tracker, s0.step.kind], [0, 0, 0, 'start'], 'initial');
eq(s0.players.length, 7, 'seven seats');
ok(!JSON.stringify(s0).includes('usurper') && !JSON.stringify(s0).includes('mock'), 'no roles or models in the state');

// failed votes and the chaos law
let s = at(false, type('vote_result', 0));
eq([s.tracker, s.step.passed, s.players.filter((p) => p.vote === false).length], [1, false, 4], 'first vote fails');
s = at(false, type('vote_result', 2));
eq(s.tracker, 3, 'third failed vote');
s = at(false, type('enact', 0));
eq([s.decrees, s.tracker, s.step.by, s.consul], [1, 0, 'chaos', 'Cato'], 'chaos law resets the tracker');

// a passed government: town view has three face-down cards, god view the real laws
s = at(false, type('vote_result', 3));
eq(s.hand, { cards: null, n: 3 }, 'town: face-down');
eq(s.tracker, 0, 'tracker stays 0 here');
s = at(true, type('draw', 0));
eq(s.hand, { cards: ['reform', 'decree', 'decree'], n: 3 }, 'god: drawn laws');
s = at(true, type('discard', 0));
eq(s.hand, { cards: ['reform', 'decree'], n: 2 }, 'god: after the Consul discards');
s = at(true, type('discard', 1));
eq(s.hand.n, 1, 'god: the Prefect discards');
s = at(false, type('enact', 1));
eq([s.hand, s.decrees, s.step.law], [null, 2, 'decree'], 'enacted law is face-up');

// investigate: public that it happened, the result only in god view
s = at(false, type('power', 0));
eq([s.step.power, s.players[2].investigated, s.players.map((p) => p.checked).join('')], ['investigate', false, ''], 'town: target not yet marked');
s = at(false, (e) => e.type === 'power' && e.kind === 'investigate');
eq([s.players[6].investigated, s.players[6].checked], [true, null], 'town: investigated, no result');
s = at(true, type('power_result', 0));
eq(s.players[6].checked, 'loyalist', 'god: the result');

// special election, reshuffle, executions
s = at(false, (e) => e.type === 'power' && e.kind === 'special_election');
eq(s.step.target, 'Brutus', 'special election target');
s = at(false, type('round', 6));
eq([s.round, s.consul], [7, 'Brutus'], 'the special election Consul');
s = at(false, type('executed', 0));
eq([alive(s).length, s.players[5].alive, s.step.executed], [6, false, 'Marcus'], 'Marcus executed');
s = at(false, type('reshuffle', 0));
eq([s.drawPile, s.discardPile], [8, 0], 'reshuffle: 11 cards, 3 of them already drawn by the government');
s = at(false, type('executed', 1));
eq(alive(s), ['Aurelia', 'Brutus', 'Drusus', 'Livia', 'Octavia'], 'Cato executed too');

// vetoes
s = at(false, type('veto', 0));
eq([s.step.accepted, s.tracker, s.hand, s.decrees], [true, 1, null, 5], 'veto accepted');
s = at(false, type('veto', 1));
eq([s.step.accepted, s.hand.n], [false, 3], 'veto refused, the Prefect must enact');

// transcript
s = at(false, (e) => e.type === 'game_over');
ok(s.log.some((l) => l.k === 'msg' && l.stage === 'report'), 'report messages');
ok(s.log.some((l) => l.k === 'msg' && l.stage === 'debate'), 'debate messages');
ok(s.log.every((l) => !l.secret), 'town view has no secret lines');

// roles: hidden until game_over
s = at(false, type('executed', 1));
eq(s.roles, {}, 'no roles before the end');
s = at(false, (e) => e.type === 'game_over');
eq([s.over, s.roles.Drusus, s.reforms, s.decrees], [{ winner: 'conspiracy', reason: 'decrees' }, 'usurper', 2, 6], 'game over');
s = at(true, (e) => e.type === 'game_over');
ok(s.log.some((l) => l.secret), 'god view has secret lines');
s = apply(init(config), { type: 'mystery' });
eq(s.round, 0, 'unknown events are ignored');
console.log(`state.check: ${checks} checks ok`);
