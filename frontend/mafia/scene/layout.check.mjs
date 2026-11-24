// Checks scene/layout.js for every table size.   node scene/layout.check.mjs
import assert from 'node:assert/strict';
import { layout, TAU } from './layout.js';

const apart = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
for (let n = 0; n <= 16; n++) {
  const L = layout(n), where = `${n} seats`;
  for (const v of [L.Rp, L.Rplaza, L.Rr, L.Rh, L.back, L.graveAngle, L.alleyAngle, L.millAngle]) assert.ok(Number.isFinite(v), where);
  assert.ok(L.Rp < L.Rplaza && L.Rplaza < L.Rr && L.Rr < L.Rh, `${where}: rings in order`);
  assert.ok(apart(L.graveAngle, L.alleyAngle) > 0.6, `${where}: graveyard and alley apart`);
  assert.ok(apart(L.millAngle, L.graveAngle) > 0.5 && apart(L.millAngle, L.alleyAngle) > 0.5, `${where}: windmill clear of both`);
  for (let i = 0; i < n; i++) assert.ok(Number.isFinite(L.seatAngle(i)), where);
  if (n > 1) assert.ok(L.Rh * TAU / n >= 10.4, `${where}: houses at least 10.4 apart`);
  if (n >= 4) assert.equal(new Set(Object.values(L.gaps)).size, 4, `${where}: graveyard, alley, windmill and market in four different gaps`);
}
console.log('layout ok for 0 to 16 seats');
