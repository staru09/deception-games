// The Senate chamber, built once from Three.js primitives and canvas-painted textures: a polished
// marble floor with an inlaid rosette, three curved tiers of benches with purple cushions, a colonnade
// under a gilded entablature, cypresses and hills beyond, the Consul's and the Prefect's rostra with
// their standards, the law table with the deck and the discards, a plinth per senator, and the boards
// of the two law tracks with the failed-vote plaque. scene.js moves what changes; this file builds.
import * as THREE from 'three';
import { rng, lerp, TAU } from '../mafia/scene/layout.js';
import { REFORMS_TO_WIN, DECREES_TO_WIN, CHAOS_AT, powerSlots } from './state.js';
import { seatSpots, ROSTRA, TABLE } from './stage.js';

export const CARD = { w: 1.3, h: 1.85, t: 0.035 };
export const TABLE_TOP = 1.37;         // height of the cloth on the table, where the laws lie
export const STACK = { deck: -3.25, discard: 3.25, per: 0.045 };   // x of the two piles on the table; height per law
export const SLOT_SCALE = 1.3;         // a law on a track board is drawn this much larger than in hand
const RAISE = { rostrum: 0.9, rostrumR: 1.85, plinth: 0.22, plinthR: 1.0 };   // what the senators stand on
const FLOOR_R = 27;
const TIER = { r0: 14.8, depth: 2.0, rise: 0.8, n: 3, half: 1.95 };
const COL = { r: 24.6, n: 15, half: 2.0 };
const BOARD = { z: -16.6, y: 6.5, h: 5.0, slot: 2.2, pad: 0.6, gap: 1.0, px: 100 };
const SLOT_Y = -0.62;   // slot centre below the board centre: the title takes the top
const PLAQUE = { y: 10.3, w: 6.4, h: 1.66, px: 100 };
const LAMP_GAP = 80;   // pixels between the failed-vote lamps on the plaque
const HEAD = '"Cinzel", "Trajan Pro", "Times New Roman", serif', BODY = 'Inter, system-ui, sans-serif';
const GOLD = '#e6bd62';
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const POWER_NAME = { peek: 'Peek', investigate: 'Investigate', special_election: 'Special election', execution: 'Execution' };
// 24-unit icon paths (the same pictures as the 2D board's), drawn with Path2D
const ICON = {
  peek: ['M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z', 'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0'],
  investigate: ['M16 10a6 6 0 1 1-12 0a6 6 0 1 1 12 0', 'M15 15l7 7'],
  special_election: ['M3 18l2-11 5 5 2-8 2 8 5-5 2 11z'],
  execution: ['M5 5l14 14M19 5L5 19', 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0'],
  dagger: ['M12 2l2.2 4v9h-4.4V6z', 'M6.5 15h11', 'M12 15v5', 'M9.5 21h5'],
};

const V = (x, y, z) => new THREE.Vector3(x, y, z);
/** Point at radius r, t radians from the back of the chamber (-z) toward +x. */
const arc = (r, t, y = 0) => V(r * Math.sin(t), y, -r * Math.cos(t));

// ---------------------------------------------------------------------------------------------
// Canvas painting

function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function texture(c, aniso = 8) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso;
  return t;
}
const repeated = (t, x, y) => { t = t.clone(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(x, y); t.needsUpdate = true; return t; };

/** Marble veins: wandering lines, each drawn on all sides so the texture tiles without seams. */
function veins(g, w, h, rand, color, count, alpha) {
  g.save(); g.strokeStyle = color; g.lineCap = g.lineJoin = 'round';
  for (let i = 0; i < count; i++) {
    let x = rand() * w, y = rand() * h, a = rand() * TAU;
    const pts = [[x, y]];
    for (let k = 0; k < 46; k++) { a += (rand() - 0.5) * 0.8; x += Math.cos(a) * w / 44; y += Math.sin(a) * h / 70; pts.push([x, y]); }
    g.globalAlpha = alpha * (0.35 + rand() * 0.65); g.lineWidth = 0.5 + rand() * rand() * 3;
    for (const ox of [-w, 0, w]) for (const oy of [-h, 0, h]) {
      g.beginPath(); pts.forEach(([px, py], k) => (k ? g.lineTo(px + ox, py + oy) : g.moveTo(px + ox, py + oy))); g.stroke();
    }
  }
  g.restore();
}

function marbleCanvas(base, vein, seed, size = 512) {
  const [c, g] = canvas(size, size), rand = rng(seed);
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 26; i++) {   // soft clouds of a slightly different tone
    const x = rand() * size, y = rand() * size, r = 40 + rand() * 140;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      gr.addColorStop(0, rand() < 0.5 ? 'rgba(255,255,255,0.10)' : 'rgba(120,96,70,0.07)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  veins(g, size, size, rand, vein, 16, 0.5);
  return c;
}

function laurel(g, cx, cy, r, color, leaves = 8) {
  g.save(); g.fillStyle = color; g.strokeStyle = color; g.lineWidth = Math.max(1.5, r * 0.05);
  for (const side of [-1, 1]) {
    const a0 = Math.PI / 2 + side * 0.22, a1 = Math.PI / 2 + side * (Math.PI - 0.5);
    g.beginPath(); g.arc(cx, cy, r, Math.min(a0, a1), Math.max(a0, a1)); g.stroke();
    for (let i = 0; i < leaves; i++) {
      const a = lerp(a0, a1, (i + 0.6) / leaves), x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      for (const out of [1, -1]) {
        g.save(); g.translate(x + Math.cos(a) * out * r * 0.13, y + Math.sin(a) * out * r * 0.13);
        g.rotate(a + Math.PI / 2 + side * (out > 0 ? 0.55 : -0.55) * -1 + (side > 0 ? 0 : Math.PI));
        g.beginPath(); g.ellipse(0, 0, r * 0.2, r * 0.075, 0, 0, TAU); g.fill(); g.restore();
      }
    }
  }
  g.restore();
}

function icon(g, kind, cx, cy, size, color) {
  g.save(); g.translate(cx - size / 2, cy - size / 2); g.scale(size / 24, size / 24);
  g.strokeStyle = color; g.lineWidth = 1.8; g.lineCap = g.lineJoin = 'round';
  for (const d of ICON[kind]) g.stroke(new Path2D(d));
  g.restore();
}

function roundRect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

/** Fit a line of text into maxW by shrinking the font. */
function fitText(g, text, x, y, maxW, px, weight, family) {
  do { g.font = `${weight} ${px}px ${family}`; px -= 1; } while (g.measureText(text).width > maxW && px > 8);
  g.fillText(text, x, y);
}

/** The faces of a law card (reform, decree) and its back, 256 x 364 with rounded corners. */
function cardCanvas(kind) {
  const W = 256, H = 364, [c, g] = canvas(W, H);
  roundRect(g, 2, 2, W - 4, H - 4, 20); g.save(); g.clip();
  const gr = g.createLinearGradient(0, 0, W, H);
  const [c0, c1, ink, line] = {
    reform: ['#f7efda', '#e3d2a8', '#22553c', '#2f7a52'],
    decree: ['#9a2129', '#5c0e15', GOLD, GOLD],
    back: ['#2a2f45', '#151827', GOLD, '#b8913f'],
  }[kind];
  gr.addColorStop(0, c0); gr.addColorStop(1, c1); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  veins(g, W, H, rng(kind.length * 7), kind === 'reform' ? 'rgba(120,90,40,1)' : 'rgba(255,255,255,1)', 6, 0.12);
  g.strokeStyle = line; g.lineWidth = 7; roundRect(g, 12, 12, W - 24, H - 24, 12); g.stroke();
  g.lineWidth = 2; roundRect(g, 24, 24, W - 48, H - 48, 8); g.stroke();
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (kind === 'reform') {
    laurel(g, W / 2, 150, 66, ink, 8);
    g.beginPath(); g.arc(W / 2, 150, 20, 0, TAU); g.fillStyle = '#c99a3a'; g.fill();
    g.fillStyle = ink; fitText(g, 'REFORM', W / 2, 292, 200, 40, 700, HEAD);
  } else if (kind === 'decree') {   // a gilded seal
    g.save(); g.translate(W / 2, 150); g.fillStyle = ink;
    g.beginPath();
    for (let i = 0; i < 32; i++) { const r = i % 2 ? 50 : 70, a = i / 32 * TAU; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
    g.beginPath(); g.arc(0, 0, 40, 0, TAU); g.fillStyle = '#7a141c'; g.fill();
    g.lineWidth = 3; g.strokeStyle = ink; g.beginPath(); g.arc(0, 0, 33, 0, TAU); g.stroke();
    g.fillStyle = ink; g.font = `700 40px ${HEAD}`; g.fillText('D', 0, 3);
    g.restore();
    g.fillStyle = ink; fitText(g, 'DECREE', W / 2, 292, 200, 40, 700, HEAD);
  } else {
    laurel(g, W / 2, H / 2, 72, ink, 9);
    g.font = `700 64px ${HEAD}`; g.fillText('S', W / 2, H / 2 + 4);
  }
  g.restore();
  return c;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** A flat annular sector around the back of the chamber, `half` radians to each side, extruded up by h. */
function sector(r0, r1, half, h, segs = 64) {
  const a0 = Math.PI / 2 - half, a1 = Math.PI / 2 + half, s = new THREE.Shape();
  s.absarc(0, 0, r1, a0, a1, false);
  s.absarc(0, 0, r0, a1, a0, true);
  return new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: segs }).rotateX(-Math.PI / 2);
}

function mesh(geo, mat, { x = 0, y = 0, z = 0, ry = 0, cast = true, receive = true } = {}) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry;
  m.castShadow = cast; m.receiveShadow = receive;
  return m;
}

function instanced(geo, mat, matrices, cast = true) {
  const m = new THREE.InstancedMesh(geo, mat, matrices.length);
  matrices.forEach((x, i) => m.setMatrixAt(i, x));
  m.castShadow = cast; m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------------------------------------

export function buildChamber({ scene, n, anisotropy = 8 }) {
  const root = new THREE.Group(); scene.add(root);
  const rand = rng(11);

  // ---- materials ------------------------------------------------------------------------------
  const marbleC = marbleCanvas('#efe7d8', 'rgba(110,98,88,1)', 3);
  const marbleT = texture(marbleC, anisotropy);
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const marble = std({ map: repeated(marbleT, 1 / 7, 1 / 7), roughness: 0.42 });
  const marbleCol = std({ map: repeated(marbleT, 1, 1.6), roughness: 0.45, normalMap: fluting(), normalScale: new THREE.Vector2(0.9, 0.9) });
  const marbleWarm = std({ map: repeated(texture(marbleCanvas('#e2d2b4', 'rgba(130,100,70,1)', 4), anisotropy), 1 / 6, 1 / 6), roughness: 0.6 });
  const marbleDark = std({ map: repeated(texture(marbleCanvas('#4a4038', 'rgba(220,200,170,1)', 5), anisotropy), 1 / 3, 1 / 3), roughness: 0.35 });
  const gold = std({ color: 0xd9ad55, metalness: 1, roughness: 0.3 });
  const purple = std({ color: 0x5a2263, roughness: 0.85 });
  const cypress = new THREE.MeshLambertMaterial({ color: 0x2c4a2e, flatShading: true });
  const pine = new THREE.MeshLambertMaterial({ color: 0x3b5b34, flatShading: true });
  const bark = new THREE.MeshLambertMaterial({ color: 0x5b4030 });

  // ---- floor, paving, ground ------------------------------------------------------------------
  const floorT = texture(paintFloor(marbleC), anisotropy);
  const floor = mesh(new THREE.CircleGeometry(FLOOR_R, 128).rotateX(-Math.PI / 2), std({ map: floorT, roughness: 0.26 }), { y: 0.02, cast: false });
  const paving = mesh(new THREE.RingGeometry(FLOOR_R - 0.1, FLOOR_R + 11, 96, 1).rotateX(-Math.PI / 2), marbleWarm, { y: 0.01, cast: false });
  const rim = mesh(new THREE.TorusGeometry(FLOOR_R, 0.09, 6, 160).rotateX(Math.PI / 2), gold, { y: 0.03, cast: false });
  const ground = mesh(new THREE.CircleGeometry(900, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x9a9a63 }), { cast: false });
  root.add(floor, paving, rim, ground);

  // ---- tiers of benches -----------------------------------------------------------------------
  const r1 = TIER.r0 + TIER.depth * TIER.n;
  for (let k = 0; k < TIER.n; k++) {
    const r = TIER.r0 + TIER.depth * k, top = TIER.rise * (k + 1);
    root.add(mesh(sector(r, r1 + 0.6, TIER.half, top), marble));
    root.add(mesh(sector(r - 0.02, r + 0.1, TIER.half, 0.035), gold, { y: top, cast: false }));
    root.add(mesh(sector(r + 0.3, r + 1.3, TIER.half - 0.03, 0.16), purple, { y: top }));
  }

  // ---- colonnade, entablature, inscription ----------------------------------------------------
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = V(1, 1, 1);
  const colMats = (y) => Array.from({ length: COL.n }, (_, i) => {
    const t = -COL.half + (2 * COL.half) * i / (COL.n - 1), p = arc(COL.r, t, y);
    return m4.compose(p, q.setFromAxisAngle(V(0, 1, 0), -t), one).clone();
  });
  const SHAFT = 8.2;
  root.add(
    instanced(new THREE.BoxGeometry(1.8, 0.5, 1.8), marble, colMats(0.25)),
    instanced(new THREE.CylinderGeometry(0.82, 0.92, 0.3, 28), marble, colMats(0.65)),
    instanced(new THREE.CylinderGeometry(0.6, 0.7, SHAFT, 28, 1, true), marbleCol, colMats(0.8 + SHAFT / 2)),
    instanced(new THREE.TorusGeometry(0.62, 0.06, 8, 28).rotateX(Math.PI / 2), gold, colMats(0.8 + SHAFT - 0.06)),
    instanced(new THREE.CylinderGeometry(0.98, 0.62, 0.45, 28), marble, colMats(SHAFT + 1.03)),
    instanced(new THREE.BoxGeometry(2.05, 0.32, 2.05), marble, colMats(SHAFT + 1.41)),
  );
  const top = SHAFT + 1.57;
  root.add(
    mesh(sector(COL.r - 1.05, COL.r + 1.05, COL.half + 0.06, 0.75, 96), marble, { y: top }),
    mesh(sector(COL.r - 0.95, COL.r + 0.95, COL.half + 0.06, 0.85, 96), marbleWarm, { y: top + 0.75 }),
    mesh(sector(COL.r - 1.08, COL.r - 0.98, COL.half + 0.06, 0.12, 96), gold, { y: top + 0.72, cast: false }),
    mesh(sector(COL.r - 1.4, COL.r + 1.3, COL.half + 0.1, 0.4, 96), marble, { y: top + 1.6 }),
    mesh(sector(COL.r - 1.42, COL.r - 1.32, COL.half + 0.1, 0.08, 96), gold, { y: top + 1.62, cast: false }),
  );
  const ins = texture(inscription(), anisotropy); ins.wrapS = THREE.RepeatWrapping; ins.repeat.x = -1;   // seen from inside
  root.add(mesh(new THREE.CylinderGeometry(COL.r - 0.97, COL.r - 0.97, 0.7, 48, 1, true, Math.PI - 0.32, 0.64),
    std({ map: ins, roughness: 0.4, metalness: 0.2, side: THREE.BackSide }), { y: top + 1.17, cast: false }));

  // ---- cypresses, stone pines, hills ----------------------------------------------------------
  const cypressGeo = new THREE.LatheGeometry([[0, 0], [0.75, 0.6], [1.1, 2.4], [1.05, 4.8], [0.75, 7.2], [0.3, 9.2], [0, 10]].map(([x, y]) => new THREE.Vector2(x, y)), 9);
  const trees = [], spots = [];
  for (let tries = 0; trees.length < 34 && tries < 600; tries++) {
    const t = (rand() - 0.5) * 4.6, r = lerp(COL.r + 3.5, COL.r + 20, rand() ** 1.4), p = arc(r, t);
    if (spots.some((o) => o.distanceTo(p) < 3.2)) continue;
    spots.push(p);
    const s = lerp(0.85, 1.35, rand());
    trees.push(m4.compose(p, q.setFromAxisAngle(V(0, 1, 0), rand() * TAU), V(s, s * lerp(0.9, 1.25, rand()), s)).clone());
  }
  root.add(instanced(cypressGeo, cypress, trees));
  const pines = [], trunks = [];
  for (let i = 0; i < 9; i++) {
    const p = arc(lerp(48, 70, rand()), (i / 8 - 0.5) * 4.4 + (rand() - 0.5) * 0.3), h = lerp(8, 11, rand()), w = lerp(4.5, 6.5, rand());
    trunks.push(m4.compose(p.clone().setY(h / 2), q.identity(), V(1, h, 1)).clone());
    pines.push(m4.compose(p.clone().setY(h), q.setFromAxisAngle(V(0, 1, 0), rand() * TAU), V(w, w * 0.32, w)).clone());
  }
  root.add(instanced(new THREE.CylinderGeometry(0.22, 0.32, 1, 6), bark, trunks), instanced(new THREE.IcosahedronGeometry(1, 1), pine, pines));
  const hills = [];
  for (const [count, r0, r1h, h0, h1] of [[14, 170, 230, 14, 26], [12, 300, 380, 36, 62]]) {
    for (let i = 0; i < count; i++) {
      const w = lerp(50, 100, rand()), p = arc(lerp(r0, r1h, rand()), (i + rand() * 0.8) / count * TAU, -4);
      hills.push(m4.compose(p, q.setFromAxisAngle(V(0, 1, 0), rand() * TAU), V(w, lerp(h0, h1, rand()), w * lerp(0.6, 1, rand()))).clone());
    }
  }
  root.add(instanced(new THREE.IcosahedronGeometry(1, 2), new THREE.MeshLambertMaterial({ color: 0x7d8a58, flatShading: true }), hills, false));

  // ---- the rostra -----------------------------------------------------------------------------
  const drumGeo = new THREE.CylinderGeometry(RAISE.rostrumR - 0.1, RAISE.rostrumR + 0.1, RAISE.rostrum, 48);
  for (const [office, color] of [['consul', '#5a1f66'], ['prefect', '#1d3768']]) {
    const { x, z } = ROSTRA[office], g = new THREE.Group(); g.position.set(x, 0, z); root.add(g);
    g.add(mesh(drumGeo, marble, { y: RAISE.rostrum / 2 }));
    g.add(mesh(new THREE.TorusGeometry(RAISE.rostrumR - 0.08, 0.07, 8, 64).rotateX(Math.PI / 2), gold, { y: RAISE.rostrum, cast: false }));
    g.add(mesh(new THREE.TorusGeometry(RAISE.rostrumR + 0.1, 0.06, 8, 64).rotateX(Math.PI / 2), gold, { y: 0.05, cast: false }));
    g.add(mesh(new THREE.CylinderGeometry(RAISE.rostrumR - 0.2, RAISE.rostrumR - 0.2, 0.03, 48), purple, { y: RAISE.rostrum + 0.01, cast: false }));
    // the office's cloth hangs over the front of the drum (low, so it hides no senator behind)
    g.add(mesh(new THREE.CylinderGeometry(RAISE.rostrumR + 0.02, RAISE.rostrumR + 0.11, RAISE.rostrum - 0.06, 32, 1, true, -0.5, 1.0),
      std({ map: texture(bannerCanvas(office, color), anisotropy), alphaTest: 0.5, roughness: 0.8 }), { y: RAISE.rostrum / 2 + 0.02, cast: false }));
  }

  // ---- table, deck and discard ----------------------------------------------------------------
  const table = new THREE.Group(); table.position.set(TABLE.x, 0, TABLE.z); root.add(table);
  table.add(mesh(new THREE.BoxGeometry(8.2, 0.24, 2.8), marble, { y: TABLE_TOP - 0.13 }));
  table.add(mesh(new THREE.BoxGeometry(8.3, 0.07, 2.9), gold, { y: TABLE_TOP - 0.27 }));
  for (const sx of [-3, 3]) {
    table.add(mesh(new THREE.BoxGeometry(1.0, TABLE_TOP - 0.3, 2.0), marbleWarm, { x: sx, y: (TABLE_TOP - 0.3) / 2 }));
    table.add(mesh(new THREE.BoxGeometry(1.2, 0.12, 2.2), gold, { x: sx, y: 0.06 }));
  }
  table.add(mesh(new THREE.BoxGeometry(8.24, 0.02, 1.25), purple, { y: TABLE_TOP - 0.005, z: 0.05 }));
  const cards = cardMaterials(anisotropy);
  const stackGeo = new THREE.BoxGeometry(CARD.w, 1, CARD.h).translate(0, 0.5, 0);
  const stackMats = [cards.edge, cards.edge, cards.backFlat, cards.edge, cards.edge, cards.edge];
  const deck = mesh(stackGeo, stackMats, { x: STACK.deck, y: TABLE_TOP }); const discard = mesh(stackGeo, stackMats, { x: STACK.discard, y: TABLE_TOP });
  table.add(deck, discard);

  // ---- senators' plinths, with a broken column for the executed -------------------------------
  const plinthGeo = new THREE.CylinderGeometry(RAISE.plinthR - 0.05, RAISE.plinthR + 0.05, RAISE.plinth, 36);
  const ringGeo = new THREE.TorusGeometry(RAISE.plinthR - 0.04, 0.035, 6, 40).rotateX(Math.PI / 2);
  const stubGeo = brokenColumn();
  const seats = seatSpots(n);
  const memorials = seats.map((s) => {
    root.add(mesh(plinthGeo, marble, { x: s.x, y: RAISE.plinth / 2, z: s.z }), mesh(ringGeo, gold, { x: s.x, y: RAISE.plinth, z: s.z, cast: false }));
    const stub = mesh(stubGeo, marbleDark, { x: s.x, y: RAISE.plinth, z: s.z, ry: s.yaw }); stub.visible = false; root.add(stub);
    const anchor = new THREE.Object3D(); anchor.position.y = 1.9; stub.add(anchor);
    return { stub, anchor };
  });

  // ---- the law tracks and the failed-vote plaque ----------------------------------------------
  const slotsOf = { reform: Array(REFORMS_TO_WIN).fill(null), decree: powerSlots(n) };
  const widths = { reform: REFORMS_TO_WIN * BOARD.slot + 2 * BOARD.pad, decree: DECREES_TO_WIN * BOARD.slot + 2 * BOARD.pad };
  const total = widths.reform + BOARD.gap + widths.decree;
  const centre = { reform: -total / 2 + widths.reform / 2, decree: total / 2 - widths.decree / 2 };
  for (const law of ['reform', 'decree']) {
    const W = widths[law], x = centre[law], face = std({ map: texture(boardCanvas(law, slotsOf[law], W), anisotropy), roughness: 0.38, metalness: 0.05 });
    root.add(mesh(new THREE.BoxGeometry(W, BOARD.h, 0.24), [gold, gold, gold, gold, face, marbleDark], { x, y: BOARD.y, z: BOARD.z }));
    root.add(mesh(new THREE.BoxGeometry(W + 0.3, BOARD.h + 0.3, 0.16), gold, { x, y: BOARD.y, z: BOARD.z - 0.06 }));
    for (const side of [-1, 1]) {
      const h = BOARD.y - BOARD.h / 2;
      root.add(mesh(new THREE.BoxGeometry(0.62, h, 0.62), marble, { x: x + side * (W / 2 - 0.7), y: h / 2, z: BOARD.z - 0.05 }));
    }
  }
  const slotPos = (law, i) => V(centre[law] + (i - (slotsOf[law].length - 1) / 2) * BOARD.slot, BOARD.y + SLOT_Y, BOARD.z + 0.14 + CARD.t);
  const plaque = plaqueCanvas();
  root.add(mesh(new THREE.BoxGeometry(PLAQUE.w, PLAQUE.h, 0.2), [gold, gold, gold, gold, std({ map: plaque.tex, roughness: 0.4 }), marbleDark], { y: PLAQUE.y, z: BOARD.z }));
  root.add(mesh(new THREE.BoxGeometry(PLAQUE.w + 0.24, PLAQUE.h + 0.24, 0.14), gold, { y: PLAQUE.y, z: BOARD.z - 0.05 }));
  const lampGeo = new THREE.SphereGeometry(0.2, 20, 12);
  const lamps = Array.from({ length: CHAOS_AT }, (_, i) => {
    const m = mesh(lampGeo, std({ color: 0x5b4632, metalness: 0.6, roughness: 0.4, emissive: 0xff8a2a, emissiveIntensity: 0 }),
      { x: (i - 1) * LAMP_GAP / PLAQUE.px, y: PLAQUE.y - 3 / PLAQUE.px, z: BOARD.z + 0.12, cast: false });
    root.add(m);
    return m;
  });

  // ---- two bronze braziers framing the boards; scene.js makes their flames flicker -------------
  const bowlGeo = new THREE.LatheGeometry([[0, 0], [0.5, 0.05], [0.95, 0.35], [1.1, 0.7], [1.0, 0.72], [0.85, 0.45], [0, 0.4]].map(([x, y]) => new THREE.Vector2(x, y)), 28);
  const flameMap = texture(flameCanvas());
  const flames = [];
  for (const side of [-1, 1]) {
    const g = new THREE.Group(); g.position.set(side * 16.2, 0, BOARD.z + 0.6); root.add(g);
    g.add(mesh(new THREE.CylinderGeometry(0.75, 0.95, 0.4, 24), marble, { y: 0.2 }));
    g.add(mesh(new THREE.CylinderGeometry(0.16, 0.24, 3.6, 12), gold, { y: 2.2 }));
    g.add(mesh(bowlGeo, std({ color: 0x9a6a36, metalness: 0.9, roughness: 0.35 }), { y: 3.95 }));
    const fire = new THREE.Group(); fire.position.y = 4.35; g.add(fire);
    for (const [s, c] of [[1.9, 0xff6a10], [1.35, 0xffa040], [0.8, 0xfff2c0]]) {   // soft glowing tongues, outer to inner
      const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameMap, color: new THREE.Color(c).multiplyScalar(1.5), blending: THREE.AdditiveBlending, depthWrite: false }));
      f.center.set(0.5, 0.08); f.scale.set(s * 0.62, s, 1); f.userData.base = s; fire.add(f);
    }
    flames.push(fire);
  }

  // ---- shared ---------------------------------------------------------------------------------
  const rostra = Object.values(ROSTRA);
  /** Height of what stands at (x, z): a rostrum, a plinth, or the floor. */
  function groundAt(x, z) {
    for (const r of rostra) if (Math.hypot(x - r.x, z - r.z) < RAISE.rostrumR) return RAISE.rostrum;
    for (const s of seats) if (Math.hypot(x - s.x, z - s.z) < RAISE.plinthR) return RAISE.plinth;
    return 0;
  }
  let piles = '';
  return {
    root, seats, memorials, lamps, flames, cards, slotPos, groundAt,
    boardsCentre: V(0, BOARD.y, BOARD.z),
    deckTop: () => TABLE_TOP + deck.scale.y,
    discardTop: () => TABLE_TOP + discard.scale.y,
    /** Piles and the failed-vote plaque. */
    setCounts(drawPile, discardPile, tracker) {
      deck.scale.y = Math.max(0.001, drawPile * STACK.per); deck.visible = drawPile > 0;
      discard.scale.y = Math.max(0.001, discardPile * STACK.per); discard.visible = discardPile > 0;
      const key = `${drawPile}/${discardPile}`;
      if (key !== piles) { piles = key; plaque.draw(drawPile, discardPile); }
      lamps.forEach((m, i) => { m.userData.on = i < tracker; });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pieces painted on canvases

function paintFloor(marbleC) {
  const S = 2048, [c, g] = canvas(S, S), k = S / (2 * FLOOR_R), C = S / 2;
  for (let x = 0; x < S; x += 512) for (let y = 0; y < S; y += 512) g.drawImage(marbleC, x, y);
  const disc = (r, fill) => { g.beginPath(); g.arc(C, C, r * k, 0, TAU); g.fillStyle = fill; g.fill(); };
  const ring = (r0, r1, fill) => { g.beginPath(); g.arc(C, C, r1 * k, 0, TAU); g.arc(C, C, r0 * k, 0, TAU, true); g.fillStyle = fill; g.fill('evenodd'); };
  const line = (r, w, col) => { g.beginPath(); g.arc(C, C, r * k, 0, TAU); g.lineWidth = w * k; g.strokeStyle = col; g.stroke(); };
  const wedges = (r0, r1, count, fills, off = 0) => {
    for (let i = 0; i < count; i++) {
      const a0 = off + i / count * TAU, a1 = off + (i + 1) / count * TAU;
      g.beginPath(); g.arc(C, C, r1 * k, a0, a1); g.arc(C, C, r0 * k, a1, a0, true); g.closePath();
      g.fillStyle = fills[i % fills.length]; g.fill();
    }
  };
  const ROSSO = 'rgba(128,38,36,0.92)', VERDE = 'rgba(40,82,64,0.92)', GIALLO = 'rgba(214,170,84,0.9)', TRAV = 'rgba(200,180,140,0.55)', GOLDL = 'rgba(201,160,64,0.95)';
  // slabs of the outer field
  g.strokeStyle = 'rgba(120,100,76,0.35)'; g.lineWidth = 2;
  for (let r = 14.5; r < FLOOR_R; r += 3) { g.beginPath(); g.arc(C, C, r * k, 0, TAU); g.stroke(); }
  for (let i = 0; i < 48; i++) { const a = i / 48 * TAU; g.beginPath(); g.moveTo(C + Math.cos(a) * 12.3 * k, C + Math.sin(a) * 12.3 * k); g.lineTo(C + Math.cos(a) * FLOOR_R * k, C + Math.sin(a) * FLOOR_R * k); g.stroke(); }
  ring(FLOOR_R - 0.75, FLOOR_R - 0.2, ROSSO); line(FLOOR_R - 0.85, 0.07, GOLDL); line(FLOOR_R - 0.1, 0.07, GOLDL);
  // the senators' ring
  ring(11.6, 12.2, VERDE); line(12.25, 0.06, GOLDL);
  ring(9.2, 11.6, TRAV);
  for (let i = 0; i < 40; i++) {
    const a = i / 40 * TAU, x = C + Math.cos(a) * 10.4 * k, y = C + Math.sin(a) * 10.4 * k;
    g.save(); g.translate(x, y); g.rotate(a + Math.PI / 4); g.fillStyle = i % 2 ? ROSSO : VERDE; g.fillRect(-0.28 * k, -0.28 * k, 0.56 * k, 0.56 * k); g.restore();
  }
  ring(8.7, 9.2, VERDE); line(8.62, 0.06, GOLDL); line(9.25, 0.05, GOLDL);
  // the inner field and the rosette
  wedges(3.5, 8.6, 32, ['rgba(255,250,240,0.25)', TRAV]);
  for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; g.beginPath(); g.moveTo(C + Math.cos(a) * 3.5 * k, C + Math.sin(a) * 3.5 * k); g.lineTo(C + Math.cos(a) * 8.6 * k, C + Math.sin(a) * 8.6 * k); g.strokeStyle = 'rgba(201,160,64,0.55)'; g.lineWidth = 3; g.stroke(); }
  ring(2.75, 3.4, ROSSO); line(2.7, 0.06, GOLDL); line(3.45, 0.06, GOLDL);
  disc(2.7, VERDE);
  g.beginPath();
  for (let i = 0; i < 32; i++) { const r = (i % 2 ? 1.0 : i % 4 ? 2.1 : 2.6) * k, a = i / 32 * TAU; g.lineTo(C + Math.cos(a) * r, C + Math.sin(a) * r); }
  g.closePath(); g.fillStyle = GIALLO; g.fill();
  g.beginPath();
  for (let i = 0; i < 16; i++) { const r = (i % 2 ? 0.45 : 1.25) * k, a = i / 16 * TAU + TAU / 32; g.lineTo(C + Math.cos(a) * r, C + Math.sin(a) * r); }
  g.closePath(); g.fillStyle = ROSSO; g.fill();
  disc(0.35, GOLDL);
  return c;
}

/** A flame: a soft white teardrop on black, tinted by the sprites that use it. */
function flameCanvas() {
  const [c, g] = canvas(64, 128);
  g.save(); g.scale(1, 2.2);
  const gr = g.createRadialGradient(32, 42, 2, 32, 40, 30);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); g.restore();
  return c;
}

/** Normal map for the vertical flutes of a column shaft. */
function fluting(flutes = 20) {
  const [c, g] = canvas(512, 4), img = g.createImageData(512, 4);
  for (let x = 0; x < 512; x++) {
    const nx = Math.sin((x / 512 * flutes % 1) * TAU) * 0.75, nz = Math.sqrt(1 - nx * nx);
    for (let y = 0; y < 4; y++) img.data.set([128 + nx * 127, 128, 128 + nz * 127, 255], (y * 512 + x) * 4);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function inscription() {
  const [c, g] = canvas(1024, 112);
  g.fillStyle = '#3b3029'; g.fillRect(0, 0, 1024, 112);
  g.strokeStyle = GOLD; g.lineWidth = 4; g.strokeRect(6, 6, 1012, 100);
  g.fillStyle = GOLD; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 64px ${HEAD}`; g.fillText('S E N A T V S', 512, 60);
  laurel(g, 120, 56, 30, GOLD, 5); laurel(g, 904, 56, 30, GOLD, 5);
  return c;
}

/** The cloth on a rostrum's drum: the office's colour, a laurel, its name, a gold fringe and a scalloped hem. */
function bannerCanvas(office, color) {
  const W = 512, H = 256, [c, g] = canvas(W, H), hem = H - 34;
  g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, hem);
  for (let i = 8; i >= 0; i--) g.quadraticCurveTo(W * (i + 0.5) / 9, H + 6, W * i / 9, hem);   // scallops
  g.closePath();
  const gr = g.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0, '#00000055'); gr.addColorStop(0.5, '#ffffff1c'); gr.addColorStop(1, '#00000055');
  g.fillStyle = color; g.fill(); g.fillStyle = gr; g.fill();
  g.strokeStyle = GOLD; g.lineWidth = 8; g.beginPath(); g.moveTo(0, 6); g.lineTo(W, 6); g.stroke();
  g.lineWidth = 3; g.beginPath(); g.moveTo(0, hem - 4); g.lineTo(W, hem - 4); g.stroke();
  laurel(g, W / 2, 82, 50, GOLD, 7);
  g.fillStyle = GOLD; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 44px ${HEAD}`; g.fillText(office === 'consul' ? 'C' : 'P', W / 2, 87);
  fitText(g, office.toUpperCase().split('').join(' '), W / 2, 176, 400, 40, 700, HEAD);
  return c;
}

function boardCanvas(law, slots, W) {
  const px = BOARD.px, [c, g] = canvas(Math.round(W * px), Math.round(BOARD.h * px)), w = c.width, h = c.height, reform = law === 'reform';
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, reform ? '#2a6a50' : '#76212b'); gr.addColorStop(1, reform ? '#123425' : '#3a0c12');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  veins(g, w, h, rng(reform ? 21 : 22), 'rgba(255,255,255,1)', 22, 0.08);
  g.strokeStyle = GOLD; g.lineWidth = 8; g.strokeRect(12, 12, w - 24, h - 24); g.lineWidth = 2.5; g.strokeRect(28, 28, w - 56, h - 56);
  g.fillStyle = GOLD; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `700 ${Math.round(0.56 * px)}px ${HEAD}`;
  const title = reform ? 'REFORM' : 'DECREE';
  g.fillText(title, w / 2, 0.78 * px);
  const tw = g.measureText(title).width;
  laurel(g, w / 2 - tw / 2 - 0.45 * px, 0.78 * px, 0.25 * px, GOLD, 5); laurel(g, w / 2 + tw / 2 + 0.45 * px, 0.78 * px, 0.25 * px, GOLD, 5);
  const sw = CARD.w * SLOT_SCALE * px, sh = CARD.h * SLOT_SCALE * px, cy = (BOARD.h / 2 - SLOT_Y) * px;
  slots.forEach((power, i) => {
    const cx = (BOARD.pad + BOARD.slot * (i + 0.5)) * px, last = i === slots.length - 1;
    g.fillStyle = last ? 'rgba(230,189,98,0.16)' : 'rgba(0,0,0,0.22)';
    roundRect(g, cx - sw / 2, cy - sh / 2, sw, sh, 12); g.fill();
    g.setLineDash([10, 8]); g.strokeStyle = 'rgba(230,189,98,0.75)'; g.lineWidth = 3; g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(230,189,98,0.85)'; g.font = `700 24px ${HEAD}`; g.fillText(ROMAN[i], cx, cy - sh / 2 + 26);
    const kind = last ? (reform ? 'laurel' : 'dagger') : power;
    if (!kind) return;
    const label = last ? (reform ? 'Loyalists win' : 'Conspiracy wins') : POWER_NAME[power];
    if (kind === 'laurel') laurel(g, cx, cy - 14, 40, '#f3d68b', 6);
    else icon(g, kind, cx, cy - 14, 74, '#f3d68b');
    g.fillStyle = '#f6e6bd';
    const words = label.split(' ');
    words.forEach((word, k) => fitText(g, word, cx, cy + 56 + k * 30 - (words.length - 1) * 8, sw - 12, 27, 700, BODY));
  });
  return c;
}

function plaqueCanvas() {
  const px = PLAQUE.px, [c, g] = canvas(Math.round(PLAQUE.w * px), Math.round(PLAQUE.h * px)), w = c.width, h = c.height;
  const tex = texture(c);
  return {
    tex,
    draw(deck, discards) {
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#3d332b'); gr.addColorStop(1, '#231d18');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.strokeStyle = GOLD; g.lineWidth = 3; g.strokeRect(9, 9, w - 18, h - 18);
      g.fillStyle = GOLD; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 28px ${HEAD}`; g.fillText('FAILED VOTES', w / 2, 34);
      for (let i = 0; i < CHAOS_AT; i++) {
        const x = w / 2 + (i - 1) * LAMP_GAP, y = h / 2 + 3;
        g.beginPath(); g.arc(x, y, 24, 0, TAU); g.fillStyle = '#16110d'; g.fill(); g.lineWidth = 3; g.strokeStyle = GOLD; g.stroke();
      }
      g.font = `700 16px ${BODY}`; g.fillStyle = '#d9c9a5'; g.fillText('then chaos', w / 2 + LAMP_GAP + 92, h / 2 + 3);
      g.font = `600 21px ${BODY}`; g.fillStyle = '#efe2c4';
      g.fillText(`Deck ${deck}  ·  Discards ${discards}`, w / 2, h - 28);
      tex.needsUpdate = true;
    },
  };
}

function cardMaterials(anisotropy) {
  const make = (kind) => new THREE.MeshStandardMaterial({ map: texture(cardCanvas(kind), anisotropy), alphaTest: 0.5, roughness: 0.55 });
  const back = make('back');
  const flat = back.map.clone(); flat.needsUpdate = true;
  return { reform: make('reform'), decree: make('decree'), back, backFlat: new THREE.MeshStandardMaterial({ map: flat, roughness: 0.55 }), edge: new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.7 }) };
}

/** A short column, broken off at a slant: what is left of an executed senator's place. */
function brokenColumn() {
  const geo = new THREE.CylinderGeometry(0.3, 0.36, 1.4, 16, 1).translate(0, 0.7, 0), p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getY(i) > 1) p.setY(i, 1.4 - 0.32 + p.getX(i) * 0.45 + Math.sin(i * 2.3) * 0.06);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------
// Law cards (scene.js moves them)

const cardShape = (() => {
  const s = new THREE.Shape(), w = CARD.w / 2, h = CARD.h / 2, r = 0.1;
  s.moveTo(-w + r, -h); s.lineTo(w - r, -h); s.quadraticCurveTo(w, -h, w, -h + r); s.lineTo(w, h - r); s.quadraticCurveTo(w, h, w - r, h);
  s.lineTo(-w + r, h); s.quadraticCurveTo(-w, h, -w, h - r); s.lineTo(-w, -h + r); s.quadraticCurveTo(-w, -h, -w + r, -h);
  return s;
})();
const cardBody = new THREE.ExtrudeGeometry(cardShape, { depth: CARD.t, bevelEnabled: false, curveSegments: 4 }).translate(0, 0, -CARD.t / 2);
const cardFace = new THREE.PlaneGeometry(CARD.w, CARD.h);

/** A law card: its face toward local +z, its back toward -z. `card.front.material` says which law. */
export function makeCard(mats) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(cardBody, mats.edge); body.castShadow = true;
  const front = new THREE.Mesh(cardFace, mats.back); front.position.z = CARD.t / 2 + 0.003;
  const back = new THREE.Mesh(cardFace, mats.back); back.position.z = -CARD.t / 2 - 0.003; back.rotation.y = Math.PI;
  g.add(body, front, back); g.front = front;
  return g;
}
