// Where things go on the rings around the plaza, for any table size. No Three.js here, so
// `node scene/layout.check.mjs` can test it.
export const TAU = Math.PI * 2;
export const lerp = (a, b, k) => a + (b - a) * k;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Small seeded random generator, so the village looks the same on every load. */
export function rng(seed) {
  return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Radii and angles for a table of n seats. Angle 0 points to +z and grows toward +x. */
export function layout(n) {
  const Rp = clamp(n * 0.85, 6.4, 12);                 // ring the characters stand on by day
  const Rplaza = Rp + 3.4;                            // edge of the cobbles
  const Rr = Rplaza + 2.4;                            // ring road between plaza and houses
  const Rh = Math.max(Rplaza + 9.5, n * 10.5 / TAU);  // ring of house centres
  const m = Math.max(1, n), step = TAU / m, a0 = step / 2;
  const gapAngle = g => a0 + (g + 0.5) * step;         // gap g lies between seat g and seat g+1
  // Graveyard and alley sit about 100 degrees apart, so one camera angle shows both behind the plaza.
  const apart = Math.max(1, Math.round(1.75 / step));
  const grave = Math.floor(m * 0.62) % m, alley = (grave - apart + m) % m;
  const back = gapAngle(grave) - apart * step / 2;    // the far side of the default view
  const free = [...Array(m).keys()].filter(g => g !== grave && g !== alley);
  const pick = a => free.sort((x, y) => Math.abs(Math.sin((gapAngle(x) - a) / 2)) - Math.abs(Math.sin((gapAngle(y) - a) / 2))).shift();
  const mill = pick(back), market = pick(back + 1.9);
  // Directions of the landmarks. Below three seats there are too few gaps, so they are spread by hand.
  const graveAngle = gapAngle(grave), alleyAngle = alley === grave ? graveAngle - 1.75 : gapAngle(alley);
  const millAngle = mill === undefined ? (graveAngle + alleyAngle) / 2 : gapAngle(mill);
  return { n, Rp, Rplaza, Rr, Rh, step, back: alley === grave ? millAngle : back, seatAngle: i => a0 + i * step, gapAngle,
    gaps: { grave, alley, mill, market }, graveAngle, alleyAngle, millAngle };
}
