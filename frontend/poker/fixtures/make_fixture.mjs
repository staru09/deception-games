// Writes fixtures/demo/{config.json,events.jsonl}: a hand-scripted six-hand match that follows
// docs/ARENA_CONTRACT.md §5 (preflop fold + refund, showdown, all-in before the river, split pot,
// table talk, alternating buttons, game_over). Run: node frontend/poker/fixtures/make_fixture.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const out = new URL('./demo/', import.meta.url);
const [A, B] = ['Mira', 'Dax'];
const other = (p) => (p === A ? B : A);
const config = {
  game: 'poker', players: [{ name: A, model: 'mock', llm_config: { model_name: 'mock' } },
    { name: B, model: 'mock', llm_config: { model_name: 'mock' } }],
  hands: 6, blinds: [1, 2], stack: 200, seed: 7, pair: null, mirror: false, table_talk: true,
};
const events = [];
let ts = 1_700_000_000;
const emit = (type, f) => events.push({ ts: (ts += 1.5), type, ...f });
const totals = { [A]: 0, [B]: 0 };
let s, pot, bets, inv, board;   // the hand in progress

function start(hand, button, cards) {
  s = { [A]: 200, [B]: 200 }; pot = 0; bets = { [A]: 0, [B]: 0 }; inv = { [A]: 0, [B]: 0 }; board = [];
  emit('hand_start', { hand, button, seed: 7 * 1000 + hand, stacks: { ...s } });
  put(button, 'blind', 1);
  put(other(button), 'blind', 2);
  for (const p of [A, B]) emit('deal', { player: p, cards: cards[p], spoiler: true });
}
function put(p, action, to, say) {
  const max = Math.max(...Object.values(bets));
  if (action === 'call') to = max;
  if (action === 'check' || action === 'fold') to = bets[p];
  const amount = to - bets[p];
  s[p] -= amount; pot += amount; inv[p] += amount; bets[p] = to;
  emit('action', { player: p, action, amount, to, pot, stack: s[p], all_in: s[p] === 0, ...(say && { say }) });
  if (action === 'fold') refund(other(p));
}
function refund(p) {   // an uncalled bet goes back
  const amount = bets[p] - bets[other(p)];
  if (amount <= 0) return;
  s[p] += amount; pot -= amount; inv[p] -= amount; bets[p] -= amount;
  emit('refund', { player: p, amount, pot });
}
function street(name, cards) {
  board = [...board, ...cards]; bets = { [A]: 0, [B]: 0 };
  emit('street', { name, board: [...board] });
}
function showdown(p, cards, hand_name, best) { emit('showdown', { player: p, cards, hand_name, best }); }
function end(hand, winners) {
  const deltas = {};
  for (const p of [A, B]) { deltas[p] = (winners.includes(p) ? pot / winners.length : 0) - inv[p]; totals[p] += deltas[p]; }
  emit('hand_end', { hand, winners, pot, deltas, totals: { ...totals }, board: [...board] });
}

// 1: Mira (button) raises, Dax folds; 4 of the 6 are returned.
start(1, A, { [A]: ['Ah', '9d'], [B]: ['7c', '2s'] });
put(A, 'raise', 6, 'Blinds are mine tonight.');
put(B, 'fold', 0);
end(1, [A]);
// 2: to showdown.
start(2, B, { [A]: ['Ah', 'Kd'], [B]: ['9c', '9d'] });
put(B, 'call', 2); put(A, 'check', 2);
street('flop', ['Kc', '7s', '2d']); put(A, 'check', 0); put(B, 'check', 0);
street('turn', ['4h']); put(A, 'bet', 4, 'A small one.'); put(B, 'call', 4);
street('river', ['Jc']); put(A, 'check', 0); put(B, 'bet', 6, 'Show me.'); put(A, 'call', 6);
showdown(A, ['Ah', 'Kd'], 'a pair of kings', ['Kc', 'Kd', 'Ah', 'Jc', '7s']);
showdown(B, ['9c', '9d'], 'a pair of nines', ['9c', '9d', 'Kc', 'Jc', '7s']);
end(2, [A]);
// 3: all-in before the flop; the board runs out.
start(3, A, { [A]: ['Qs', 'Qh'], [B]: ['Ad', 'Kd'] });
put(A, 'raise', 6); put(B, 'raise', 20, 'Let us make it interesting.');
put(A, 'raise', 60); put(B, 'raise', 200, 'All of it.'); put(A, 'call', 200, 'Fine. Call.');
street('flop', ['Kc', '8h', '3d']); street('turn', ['5s']); street('river', ['Kh']);
showdown(A, ['Qs', 'Qh'], 'two pair, kings and queens', ['Kc', 'Kh', 'Qs', 'Qh', '8h']);
showdown(B, ['Ad', 'Kd'], 'three of a kind, kings', ['Kd', 'Kc', 'Kh', 'Ad', '8h']);
end(3, [B]);
// 4: both play the board, so the pot is split.
start(4, B, { [A]: ['2h', '3d'], [B]: ['4c', '5s'] });
put(B, 'call', 2); put(A, 'check', 2);
street('flop', ['As', 'Kd', 'Qh']); put(A, 'check', 0); put(B, 'bet', 4, 'Nothing to bluff here.'); put(A, 'call', 4, 'Same board, same hand.');
street('turn', ['Jc']); put(A, 'check', 0); put(B, 'check', 0);
street('river', ['Tc']); put(A, 'check', 0); put(B, 'check', 0);
showdown(A, ['2h', '3d'], 'a straight, ace high', ['As', 'Kd', 'Qh', 'Jc', 'Tc']);
showdown(B, ['4c', '5s'], 'a straight, ace high', ['As', 'Kd', 'Qh', 'Jc', 'Tc']);
end(4, [A, B]);
// 5: a flop bet nobody calls; the bet is returned.
start(5, A, { [A]: ['Jh', 'Jd'], [B]: ['8s', '6s'] });
put(A, 'raise', 6); put(B, 'call', 6);
street('flop', ['Ts', '4d', '2c']); put(B, 'check', 0); put(A, 'bet', 8, 'Pay to see the turn.'); put(B, 'fold', 0);
end(5, [A]);
// 6: a river raise wins it; the unmatched part is returned.
start(6, B, { [A]: ['Kh', 'Qd'], [B]: ['5h', '5d'] });
put(B, 'raise', 6); put(A, 'call', 6);
street('flop', ['9c', '3h', 'Js']); put(A, 'check', 0); put(B, 'check', 0);
street('turn', ['2d']); put(A, 'check', 0); put(B, 'check', 0);
street('river', ['8s']); put(A, 'bet', 10); put(B, 'raise', 30, 'I do not believe you.'); put(A, 'fold', 0);
end(6, [B]);

const winner = totals[A] === totals[B] ? 'draw' : totals[A] > totals[B] ? A : B;
emit('game_over', { winner, reason: 'hands_played', hands: 6, totals: { ...totals } });

mkdirSync(out, { recursive: true });
writeFileSync(new URL('config.json', out), JSON.stringify(config, null, 1) + '\n');
writeFileSync(new URL('events.jsonl', out), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`${events.length} events, totals`, totals);
