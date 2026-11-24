// Replays every real engine game in a games dir:  node engine.check.mjs <games dir>
// (make some with arena.run poker <mock table>). It runs real engine games through the Poker viewer's reducer, both views.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const { init, apply } = await import('./state.js');
const root = process.argv[2];
if (!root) { console.error('usage: node engine.check.mjs <games dir>'); process.exit(2); }
let n = 0, problems = 0;
for (const id of readdirSync(root).filter((d) => /^\d+$/.test(d))) {
  if (!existsSync(`${root}/${id}/events.jsonl`)) continue;   // a game that never started
  const config = JSON.parse(readFileSync(`${root}/${id}/config.json`, 'utf8'));
  const text = existsSync(`${root}/${id}/events.jsonl`) ? readFileSync(`${root}/${id}/events.jsonl`, 'utf8').trim() : '';
  const events = text ? text.split('\n').map((l) => JSON.parse(l)) : [];   // a game may never have started
  if (events.at(-1)?.type !== 'game_over') continue;   // still running, or aborted
  for (const god of [true, false]) {
    let s = init(config);
    for (const ev of events) {
      if (!god && ev.spoiler) continue;
      try {
        s = apply(s, ev);
        if (ev.type === 'action') { assert.equal(s.pot, ev.pot, 'pot'); assert.equal(s.stacks[ev.player], ev.stack, 'stack'); }
        if (ev.type === 'hand_end') assert.deepEqual(s.totals, ev.totals, 'totals');
        if (!god) assert.equal(Object.keys(s.hole).length && !Object.keys(s.shown).length ? 'leak' : 'ok', 'ok', 'hole cards in players view');
      } catch (e) { if (problems++ < 5) console.log(id, god ? 'god' : 'town', ev.type, ev.hand ?? '', e.message.split('\n')[0]); }
      n++;
    }
    assert.deepEqual(s.totals, events.at(-1).totals);
  }
}
console.log(`${n} event applications, ${problems} problems`);
if (!n || problems) process.exit(1);
