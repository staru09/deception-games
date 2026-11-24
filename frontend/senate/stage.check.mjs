// node frontend/senate/stage.check.mjs
// The 3D chamber's layout and spoiler rules (stage.js), on fixtures/demo replayed in town and god view.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { init, apply } from './state.js';
import { seatSpots, spotOf, tableCards, peekCards, roleOf, ROSTRA, TABLE, SEAT_R } from './stage.js';

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };

// seats: on the arc, symmetric, far enough apart for a character and its name, clear of the rostra and table
for (let n = 5; n <= 10; n++) {
  const s = seatSpots(n);
  ok(s.length === n, `${n} seats`);
  for (let i = 0; i < n; i++) {
    ok(Math.abs(Math.hypot(s[i].x, s[i].z) - SEAT_R) < 1e-9 && s[i].z < 0, `seat ${i} of ${n} on the back arc`);
    ok(Math.abs(s[i].x + s[n - 1 - i].x) < 1e-9, `seats of ${n} symmetric`);
    if (i) ok(Math.hypot(s[i].x - s[i - 1].x, s[i].z - s[i - 1].z) > 3, `seats of ${n} apart`);
    if (i) ok(s[i].x > s[i - 1].x, `seats of ${n} run left to right`);
    for (const r of Object.values(ROSTRA)) ok(Math.hypot(s[i].x - r.x, s[i].z - r.z) > 4, `seat clear of a rostrum`);
    const toTable = Math.atan2(TABLE.x - s[i].x, TABLE.z - s[i].z);
    ok(Math.abs(s[i].yaw - toTable) < 1e-9, 'seat faces the table');
  }
}

// replay the fixture: what the chamber shows must never say more than the view knows
const dir = new URL('./fixtures/demo/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('config.json', dir), 'utf8'));
const events = readFileSync(new URL('events.jsonl', dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
for (const god of [false, true]) {
  let s = init(config), sawFaces = false, sawPeek = false;
  for (const ev of events) {
    if (!god && ev.spoiler) continue;
    s = apply(s, ev);
    const cards = tableCards(s);
    ok(cards.length === (s.hand?.n ?? 0), 'one card per law in hand');
    if (!god) ok(cards.every((c) => c === null), 'town view: the table cards are face down');
    if (god && s.hand?.cards) { ok(cards.every((c) => c === 'reform' || c === 'decree'), 'god view: faces after the draw'); sawFaces = true; }
    const peek = peekCards(s);
    if (peek.length) { sawPeek = true; ok(peek.length === 3 && (god || peek.every((c) => c === null)), 'peek shows three cards, face down in town view'); }
    for (const p of s.players) {
      const spot = spotOf(s, p.name);
      ok(spot === (!p.alive ? 'gone' : p.name === s.consul ? 'consul' : p.name === s.prefect ? 'prefect' : 'seat'), 'spot');
      ok((roleOf(s, god, config, p.name) !== null) === (god || !!s.over), 'roles only in god view or after the game');
    }
  }
  ok(!god || sawFaces, 'god view saw a face-up hand');
  ok(sawPeek || !events.some((e) => e.type === 'power' && e.kind === 'peek'), 'a peek was shown');
}
console.log(`stage.check: ${checks} checks passed`);
