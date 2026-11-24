// node frontend/poker/state.check.mjs
// Replays fixtures/demo through state.js in broadcast and players' view and asserts the state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { init, apply } from './state.js';

const demo = new URL('./fixtures/demo/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', demo), 'utf8'));
const events = readFileSync(new URL('events.jsonl', demo), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
let checks = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks++; };
const [A, B] = config.players.map((p) => p.name);

// State after the n-th event of the given type (1-based), in a view.
const view = (god) => events.filter((e) => god || !e.spoiler);
const at = (god, pred, nth = 1) => {
  let seen = 0;
  const evs = view(god), s = init(config);
  for (const e of evs) { apply(s, e); if (pred(e) && ++seen === nth) return s; }
  throw new Error('no such event');
};
const hand = (n) => (e) => e.type === 'hand_end' && e.hand === n;

// initial
const s0 = init(config);
eq([s0.stacks, s0.pot, s0.board, s0.over], [{ [A]: 200, [B]: 200 }, 0, [], null], 'initial');

// hand 1: blinds, whose turn, refund
let s = at(true, (e) => e.type === 'deal', 2);
eq([s.hand, s.button, s.pot, s.bets, s.turn], [1, A, 3, { [A]: 1, [B]: 2 }, A], 'after the blinds the button acts');
eq(s.hole, { [A]: ['Ah', '9d'], [B]: ['7c', '2s'] }, 'broadcast sees hole cards');
s = at(false, (e) => e.type === 'action' && e.action === 'blind', 2);
eq(s.hole, {}, "players' view has no hole cards");
s = at(true, (e) => e.type === 'refund');
eq([s.pot, s.stacks[A]], [4, 198], 'raise to 6, fold: 4 comes back');
s = at(true, hand(1));
eq([s.stacks, s.totals, s.result.winners, s.turn], [{ [A]: 202, [B]: 198 }, { [A]: 2, [B]: -2 }, [A], null], 'hand 1 end');

// hand 2: showdown cards are public in both views
for (const god of [true, false]) {
  s = at(god, (e) => e.type === 'showdown', 2);
  eq([s.hole[A], s.hole[B], s.shown, s.handName[B]], [['Ah', 'Kd'], ['9c', '9d'], { [A]: true, [B]: true }, 'a pair of nines'], `showdown public, god=${god}`);
  eq(s.board, ['Kc', '7s', '2d', '4h', 'Jc'], 'full board');
}
s = at(false, (e) => e.type === 'hand_start', 2);
eq([s.hole, s.button, s.hand], [{}, B, 2], "hand 2 players' view: cards unknown, button alternates");
s = at(true, (e) => e.type === 'street', 1 + 0);   // hand 2 flop is the first street of the match
eq([s.street, s.turn, s.bets], ['flop', A, { [A]: 0, [B]: 0 }], 'postflop the non-button acts first');
s = at(true, (e) => e.type === 'action' && e.action === 'bet', 1);
eq([s.turn, s.pot, s.say.text], [B, 8, 'A small one.'], 'bet: turn passes, say shown');
s = at(true, hand(2));
eq([s.totals, s.series.length], [{ [A]: 14, [B]: -14 }, 2], 'hand 2 totals');

// hand 3: all-in, nobody to act on the remaining streets
s = at(true, (e) => e.type === 'action' && e.all_in, 1);
eq([s.stacks[B], s.turn, s.pot], [0, A, 260], 'shove: the other player is to act');
s = at(true, (e) => e.type === 'action' && e.all_in, 2);
eq([s.turn, s.pot, s.stacks], [null, 400, { [A]: 0, [B]: 0 }], 'call all-in: nobody to act');
s = at(true, (e) => e.type === 'street' && e.name === 'turn', 2);
eq([s.turn, s.board.length], [null, 4], 'streets run out with no one to act');
s = at(true, hand(3));
eq([s.stacks, s.totals], [{ [A]: 0, [B]: 400 }, { [A]: -186, [B]: 186 }], 'hand 3 end');

// hand 4: split pot
s = at(true, hand(4));
eq([s.result.winners, s.result.deltas, s.stacks], [[A, B], { [A]: 0, [B]: 0 }, { [A]: 200, [B]: 200 }], 'split pot');

// hand 5: bet refunded on a flop fold
s = at(true, (e) => e.type === 'refund', 2);
eq([s.pot, s.bets[A]], [12, 0], 'flop bet 8 returned');
s = at(true, hand(5));
eq(s.totals, { [A]: -180, [B]: 180 }, 'hand 5 totals');

// hand 6 and the end
s = at(true, hand(6));
eq([s.stacks, s.series.length, s.results.map((r) => r.hand)], [{ [A]: 184, [B]: 216 }, 6, [1, 2, 3, 4, 5, 6]], 'hand 6 end');
s = view(true).reduce(apply, init(config));
eq([s.over.winner, s.totals, s.hand], [B, { [A]: -196, [B]: 196 }, 6], 'game over');
const sp = view(false).reduce(apply, init(config));
eq([sp.over.winner, sp.totals, sp.hole[A]], [B, { [A]: -196, [B]: 196 }, undefined], "players' view reaches the same end");
// every hand's deltas sum to zero and totals are their running sum
let run = 0;
for (const r of s.results) { eq(r.deltas[A] + r.deltas[B], 0, `hand ${r.hand} zero-sum`); run += r.deltas[A]; }
eq(run, s.totals[A], 'totals are the running sum');
console.log(`poker state check: ${checks} assertions ok`);
