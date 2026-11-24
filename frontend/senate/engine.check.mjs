// Replays every finished real Senate engine game in a games dir through the viewer's reducer, in god and
// town view:  node engine.check.mjs <games dir>   (make some with arena.run senate <mock table>).
// Ground truth: each `round` event's piles and tracker, each `enact`'s counts, game_over.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const { init, apply } = await import('./state.js');
const root = process.argv[2];
if (!root) { console.error('usage: node engine.check.mjs <games dir>'); process.exit(2); }
let n = 0, problems = 0, games = 0;
const SECRET = /"(laws|result|roles)"/;
for (const id of readdirSync(root).filter((d) => /^\d+$/.test(d))) {
  const config = JSON.parse(readFileSync(`${root}/${id}/config.json`, 'utf8'));
  const text = existsSync(`${root}/${id}/events.jsonl`) ? readFileSync(`${root}/${id}/events.jsonl`, 'utf8').trim() : '';
  const events = text ? text.split('\n').map((l) => JSON.parse(l)) : [];   // a game may never have started
  if (events.at(-1)?.type !== 'game_over') continue;   // still running, or aborted
  games++;
  for (const god of [true, false]) {
    let s = init(config);
    for (const ev of events) {
      if (!god && ev.spoiler) continue;
      try {
        if (!ev.spoiler && ev.type !== 'game_over') assert.ok(!SECRET.test(JSON.stringify(ev)), 'secret field in a public event');
        if (ev.type === 'round') {
          assert.equal(s.drawPile, ev.draw_pile, 'draw pile before round');
          assert.equal(s.discardPile, ev.discard_pile, 'discard pile before round');
          assert.equal(s.tracker, ev.tracker, 'tracker before round');
        }
        s = apply(s, ev);
        if (ev.type === 'enact') assert.deepEqual([s.reforms, s.decrees, s.tracker], [ev.reforms, ev.decrees, ev.tracker], 'counts after enact');
        if (!god && ev.type !== 'game_over') assert.equal(Object.keys(s.roles).length, 0, 'roles before game_over');
        if (!god) assert.ok(!s.hand?.cards, 'face-up cards in town view');
      } catch (e) { if (problems++ < 8) console.log(id, god ? 'god ' : 'town', ev.type, e.message.split('\n')[0]); }
      n++;
    }
    assert.equal(s.over?.winner, events.at(-1).winner);
    // final piles: every law is in the deck, the discards or enacted (usurper_elected once left 3 out)
    if (s.drawPile + s.discardPile + s.reforms + s.decrees !== 17) { problems++; console.log(id, god ? 'god ' : 'town', 'final piles', s.drawPile, s.discardPile, s.reforms, s.decrees); }
  }
}
console.log(`${games} games, ${n} event applications, ${problems} problems`);
if (!games || problems) process.exit(1);
