// Where things stand in the 3D Senate chamber, and what of the state the chamber may show. Pure, no
// Three.js and no DOM, so `node frontend/senate/stage.check.mjs` can test it. Units are world units;
// the chamber's centre is the origin, its open side (where the camera stands) is +z.

export const SEAT_R = 12.2;   // radius of the arc the senators stand on, facing the law table
export const TABLE = { x: 0, z: 2.4 };
// The rostra stand forward, by the table, so that from the camera they never hide a senator behind them.
export const ROSTRA = { consul: { x: -6.4, z: 2.9 }, prefect: { x: 6.4, z: 2.9 } };
const SPAN_PER_SEAT = 0.4, SPAN_MIN = 1.7, SPAN_MAX = 2.5;   // radians of arc: 5 seats 1.7, 8+ seats 2.5

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** Yaw (Actor convention: atan2(dx, dz)) for something at (x, z) to face (tx, tz). */
export const facing = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);

/** n spots on the back arc, seat 0 on the left as the camera sees it, each facing the table. */
export function seatSpots(n) {
  const span = clamp((n - 1) * SPAN_PER_SEAT, SPAN_MIN, SPAN_MAX);
  return Array.from({ length: n }, (_, i) => {
    const t = n > 1 ? -span / 2 + span * i / (n - 1) : 0;
    const x = SEAT_R * Math.sin(t), z = -SEAT_R * Math.cos(t);
    return { x, z, yaw: facing(x, z, TABLE.x, TABLE.z) };
  });
}

/** Where a player stands now: on a rostrum while in office, else at their seat; 'gone' once executed. */
export function spotOf(s, name) {
  if (!s.players.find((p) => p.name === name)?.alive) return 'gone';
  return s.consul === name ? 'consul' : s.prefect === name ? 'prefect' : 'seat';
}

/** The laws on the table: one entry per card, the law when this view knows it, null for a face-down card. */
export const tableCards = (s) => (s.hand ? Array.from({ length: s.hand.n }, (_, i) => s.hand.cards?.[i] ?? null) : []);

/** The top three laws a peek lifts from the deck, face down until (god view) the result is known. */
export const peekCards = (s) => (s.step.kind === 'power' && s.step.power === 'peek'
  ? (Array.isArray(s.step.result) ? [...s.step.result] : [null, null, null]) : []);

/** A player's role when the view may show it (god view, or after game_over), else null. */
export const roleOf = (s, god, config, name) =>
  (god || s.over ? s.roles[name] ?? config.players.find((p) => p.name === name)?.role ?? null : null);

export const sideOf = (role) => (role === 'loyalist' ? 'loyalists' : role ? 'conspiracy' : null);
