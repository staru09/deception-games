// Overlays and effects: name labels, speech bubbles, vote arcs, shield, spotlight, toasts, confetti.
// All text that comes from the game is written with textContent only.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Particles } from './particles.js';
import { HS } from './world.js';
import { TAU, lerp } from './layout.js';

const CSS = `
.scn-root{position:relative;isolation:isolate;width:100%;height:100%;overflow:hidden;font-family:Inter,system-ui,sans-serif;-webkit-user-select:none;user-select:none;background:#0d1322}
.scn-root canvas{display:block;outline:none;touch-action:none}
.scn-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.scn-layer [hidden]{display:none!important}
.scn-label{display:flex;flex-direction:column;align-items:center;white-space:nowrap;pointer-events:none;padding-bottom:var(--scn-lift,0px)}
.scn-tag{display:flex;flex-direction:column;align-items:center;gap:2px;transition:opacity .3s}
.scn-name{display:flex;align-items:center;gap:5px;padding:2px 9px 2px 7px;border-radius:999px;background:rgba(14,17,27,.8);border:1px solid rgba(255,255,255,.16);color:#fff;font-size:12.5px;font-weight:600;line-height:1.35;box-shadow:0 1px 6px rgba(0,0,0,.35)}
.scn-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--scn-c)}
.scn-model{max-width:128px;overflow:hidden;text-overflow:ellipsis;padding:0 7px;border-radius:999px;background:var(--scn-c);color:#12141c;font-size:10px;font-weight:600;line-height:1.5;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.scn-role{margin-right:-4px;padding:0 6px;border-radius:999px;color:#fff;font-size:9.5px;font-weight:700;letter-spacing:.04em;line-height:1.6;text-transform:uppercase;background:#6b7385}
.scn-role[data-role=mafia]{background:#d93a45}
.scn-role[data-role=detective]{background:#3b7fe6}
.scn-role[data-role=doctor]{background:#149e6b}
.scn-dead .scn-tag{opacity:.8}
.scn-dead .scn-name{color:#c5cad6;background:rgba(30,33,44,.82)}
.scn-dead .scn-name>span:nth-child(2){text-decoration:line-through;text-decoration-color:rgba(255,255,255,.55)}
.scn-dead .scn-dot,.scn-dead .scn-model{filter:saturate(.35)}
.scn-grave .scn-model{display:none}
.scn-compact .scn-name{gap:4px;padding:1px 7px 1px 5px;font-size:11px}
.scn-compact .scn-dot{width:7px;height:7px}
.scn-compact .scn-model{display:none}
.scn-compact .scn-role{font-size:8.5px}
.scn-compact .scn-votes{font-size:10.5px}
.scn-compact .scn-bubble{max-width:190px;padding:5px 9px;font-size:11.5px}
.scn-votes{margin-bottom:3px;padding:1px 9px;border-radius:999px;background:#f5b942;color:#241a03;font-size:11.5px;font-weight:700;line-height:1.5;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.scn-votes.scn-night{background:#d93a45;color:#fff}
.scn-bump{animation:scn-bump .3s ease-out}
.scn-bubble{position:relative;box-sizing:border-box;max-width:232px;margin-bottom:8px;padding:7px 11px;border-radius:13px;background:#fdfcf7;color:#1b1e29;font-size:12.5px;font-weight:500;line-height:1.38;white-space:normal;overflow-wrap:anywhere;text-align:left;box-shadow:0 4px 18px rgba(0,0,0,.36);transform-origin:50% 100%;animation:scn-pop .18s ease-out;transition:opacity .3s}
.scn-bubble::after{content:"";position:absolute;left:calc(50% - var(--scn-shift,0px));bottom:-5px;width:11px;height:11px;margin-left:-5.5px;background:inherit;border-radius:2px;transform:rotate(45deg)}
.scn-bubble>span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5;overflow:hidden}
.scn-bubble.scn-old{opacity:.62}
.scn-bubble.scn-private{background:#3b1319;color:#ffe6e6;box-shadow:0 0 0 1px #c5424c,0 4px 18px rgba(0,0,0,.4)}
.scn-bubble>b{display:block;margin-bottom:1px;color:#ff8d95;font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.scn-pill{padding:3px 11px;border-radius:999px;background:rgba(14,17,27,.86);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:12px;font-weight:700;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.4);animation:scn-pop .2s ease-out}
.scn-pill[data-kind=mafia]{background:#d93a45;border-color:#ff9aa1}
.scn-pill[data-kind=clear]{background:#149e6b;border-color:#8fe8c3}
.scn-pill[data-kind=saved]{background:#0f6b4a;border-color:#8fe8c3;font-size:13.5px;padding:5px 15px}
.scn-pill[data-kind=quiet]{font-size:13.5px;padding:5px 15px}
.scn-banner{padding:9px 26px;border-radius:14px;color:#fff;font-size:21px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap;box-shadow:0 6px 28px rgba(0,0,0,.45);animation:scn-pop .35s ease-out}
.scn-banner[data-winner=town]{background:linear-gradient(135deg,#2f7de0,#17a673);border:1px solid #bfe3ff}
.scn-banner[data-winner=mafia]{background:linear-gradient(135deg,#8f1420,#e04652);border:1px solid #ffb3b8}
.scn-flash{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(255,30,30,.12) 30%,rgba(190,0,0,.6) 100%)}
@keyframes scn-pop{from{transform:scale(.6);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes scn-bump{0%{transform:scale(1)}40%{transform:scale(1.35)}100%{transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.scn-bubble,.scn-pill,.scn-banner,.scn-bump{animation:none}}
`;

/** The scene's stylesheet as an element, to be placed inside the scene's own root. */
export function styleElement() {
  const s = document.createElement('style'); s.textContent = CSS;
  return s;
}

let said = 0;   // counts speech bubbles, to order them
const el = (cls, text) => { const e = document.createElement('div'); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const span = (cls, text) => { const e = document.createElement('span'); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** Name label with model badge, role chip, vote count and speech bubble, anchored above a character. */
export function createLabel(player) {
  const root = el('scn-label'), bubble = el('scn-bubble'), votes = el('scn-votes'), tag = el('scn-tag');
  const name = el('scn-name'), role = span('scn-role'), model = el('scn-model', String(player.model ?? '').split('/').pop());
  root.style.setProperty('--scn-c', player.color);
  name.append(span('scn-dot'), span('', player.name), role); tag.append(name, model); root.append(bubble, votes, tag);
  bubble.hidden = votes.hidden = role.hidden = true; model.hidden = !model.textContent;
  const obj = new CSS2DObject(root); obj.center.set(0.5, 1);
  let count = 0, size = null, lift = 0, bubbleW = 0, bubbleH = 0, shift = 0, spoken = 0;
  return {
    obj, private: false,
    setRole(r) { role.hidden = !r; role.textContent = r || ''; role.dataset.role = r || ''; size = null; },
    setDead(d) { root.classList.toggle('scn-dead', d); size = null; },
    /** The view changed size or density: measure again. */
    resized() { size = null; if (!bubble.hidden) { bubbleW = bubble.offsetWidth; bubbleH = bubble.offsetHeight; } },
    /** On a grave the label drops the model badge. */
    setGrave(on) { root.classList.toggle('scn-grave', on); size = null; },
    /** Width and height in pixels of the name tag (with the vote count, without the bubble). Cached until the content changes. */
    get size() {
      if (size) return size;
      const w = Math.max(tag.offsetWidth, votes.offsetWidth);
      if (!w) return [0, 0];   // not laid out (off screen); try again next frame
      return (size = [w, tag.offsetHeight + (votes.hidden ? 0 : votes.offsetHeight + 3)]);
    },
    /** Width and height of everything the label shows right now: the tag, plus the bubble while speaking. */
    get extent() { const [w, h] = this.size; return bubble.hidden || !w ? [w, h] : [Math.max(w, bubbleW), h + bubbleH + 8]; },
    /** Raise the label by this many pixels so that it clears a neighbour's label; eased unless `snap`. */
    raise(px, snap) {
      const next = snap || Math.abs(px - lift) < 0.5 ? px : lift + (px - lift) * 0.2;
      if (next !== lift) { lift = next; root.style.setProperty('--scn-lift', lift.toFixed(1) + 'px'); }
    },
    say(text, priv) {
      bubble.replaceChildren(); bubble.classList.toggle('scn-private', !!priv);
      if (priv) { const b = document.createElement('b'); b.textContent = 'mafia only'; bubble.append(b); }
      bubble.append(span('', text));
      bubble.hidden = false; bubble.style.animation = 'none'; bubbleW = bubble.offsetWidth; bubbleH = bubble.offsetHeight; bubble.style.animation = '';
      this.private = !!priv; obj.renderOrder = 10 + (spoken = ++said);   // the newest bubble is drawn on top
      bubble.classList.remove('scn-old');
    },
    /** Somebody else spoke after this one: step back. */
    age() { if (spoken !== said) bubble.classList.add('scn-old'); },
    hush() { bubble.hidden = true; this.private = false; obj.renderOrder = count ? 5 : 0; },
    get speaking() { return !bubble.hidden; },
    /** Is this client point on the name tag or the bubble? */
    hit(x, y) {
      return [tag, bubble].some(e => { if (e.hidden) return false; const r = e.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
    },
    /** Slide the bubble sideways so it stays inside a view `width` wide when its owner is at screen x; the tail stays on the owner. */
    keepInside(x, width) {
      if (bubble.hidden) return;
      const half = bubbleW / 2, reach = Math.max(0, half - 14);   // how far it may slide before the tail falls off
      const next = Math.round(Math.max(-reach, Math.min(reach, Math.max(0, 6 + half - x) + Math.min(0, width - 6 - x - half))));
      if (next !== shift) { shift = next; bubble.style.left = shift + 'px'; bubble.style.setProperty('--scn-shift', shift + 'px'); }
    },
    setVotes(n, night, bump) {
      votes.hidden = !n; votes.textContent = n === 1 ? '1 vote' : `${n} votes`; votes.classList.toggle('scn-night', !!night);
      if (bump && n !== count) { votes.classList.remove('scn-bump'); void votes.offsetWidth; votes.classList.add('scn-bump'); }
      count = n; size = null; if (bubble.hidden) obj.renderOrder = n ? 5 : 0;
    },
  };
}

/** A floating text. CSS2DRenderer positions the holder; the visible box is its child, so that the pop-in
 *  animation (which animates `transform`) cannot override the position. */
function floating(cls, order) {
  const box = el(cls), holder = document.createElement('div');
  holder.append(box);
  const obj = new CSS2DObject(holder); obj.center.set(0.5, 1); obj.visible = false; obj.renderOrder = order;
  return { obj, box };
}

const arcGeo = { head: new THREE.ConeGeometry(0.3, 0.75, 10).rotateX(Math.PI / 2), pulse: new THREE.SphereGeometry(0.22, 10, 8) };
const up = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3();

export function createFx({ scene, world, overlay }) {
  const group = new THREE.Group(); scene.add(group);
  const arcs = new Map();
  const bright = (c, k) => new THREE.Color(c).multiplyScalar(k);

  // ---- vote arcs ------------------------------------------------------------------------------
  function removeArc(key) {
    const a = arcs.get(key); if (!a) return;
    group.remove(a.obj); a.tube.geometry.dispose(); a.mat.dispose(); arcs.delete(key);
  }
  /** Glowing arc from one head to another. A second arc with the same key replaces the first. */
  function setArc(key, from, to, color, instant, lift = 0) {
    removeArc(key);
    const a = from.clone(), b = to.clone(), d = a.distanceTo(b);
    if (d < 0.5) { a.x -= 0.5; b.x += 0.5; }   // a vote for oneself: a small loop overhead
    const mid = a.clone().lerp(b, 0.5); mid.y += (d < 0.5 ? 3.2 : 2.2 + d * 0.24) + lift;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const mat = new THREE.MeshBasicMaterial({ color: bright(color, 2.1), transparent: true, opacity: 0.95, fog: false });
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.1, 6), mat);
    const head = new THREE.Mesh(arcGeo.head, mat), pulse = new THREE.Mesh(arcGeo.pulse, mat);
    head.position.copy(b); head.lookAt(tmp.copy(b).add(curve.getTangent(1)));
    const obj = new THREE.Group(); obj.add(tube, head, pulse); group.add(obj);
    const arc = { obj, tube, head, pulse, mat, curve, t: instant ? 1 : 0, phase: Math.random(), total: tube.geometry.index.count };
    arcs.set(key, arc); drawArc(arc);
  }
  function drawArc(a) {
    a.tube.geometry.setDrawRange(0, Math.floor(a.total * a.t / 36) * 36);   // 6 radial quads = 36 indices per ring
    a.head.visible = a.t >= 1;
  }

  // ---- doctor's shield ------------------------------------------------------------------------
  const shield = new THREE.Group(); shield.visible = false; group.add(shield);
  const shieldMat = new THREE.MeshBasicMaterial({ color: 0x35f09a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const cageMat = new THREE.LineBasicMaterial({ color: bright(0x6dffc0, 1.4), transparent: true, opacity: 0.55, depthWrite: false, fog: false });
  const ringMat = new THREE.MeshBasicMaterial({ color: bright(0x4dffb0, 1.5), transparent: true, opacity: 0.8, depthWrite: false, fog: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.97, 1.03, 48).rotateX(-Math.PI / 2), ringMat); ring.position.y = 0.08;
  shield.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), shieldMat), new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 2)), cageMat), ring);
  const sh = { k: 0, goal: 0, burst: 0, size: new THREE.Vector3(1, 1, 1) };
  function setShield(seat, instant) {
    if (!seat) { sh.goal = 0; if (instant) { sh.k = 0; sh.burst = 0; shield.visible = false; } return; }
    const r = seat.spec.half * HS * 1.8;
    shield.position.copy(seat.group.position); sh.size.set(r, seat.top * 1.14, r);
    sh.goal = 1; sh.burst = 0; if (instant) sh.k = 1;
    shield.visible = true;
  }
  /** The shield takes the hit: it flares, expands and is gone. */
  function breakShield() {
    if (!shield.visible) return;
    sh.burst = 0.001; sh.goal = 0;
    burst(tmp.copy(shield.position).setY(sh.size.y * 0.6), [0.35, 1, 0.65], 9);
  }

  // ---- detective's spotlight ------------------------------------------------------------------
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 1, 1, 24, 1, true).translate(0, -0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xbfd9ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  const spot = new THREE.SpotLight(0xcfe2ff, 0, 0, 0.3, 0.6, 1.1);
  beam.visible = false; group.add(beam, spot, spot.target);   // the light itself stays on the list at intensity 0: adding a light later would recompile every lit shader
  const mark = floating('scn-pill', 6); group.add(mark.obj);
  const sp = { k: 0, goal: 0 };
  function setSpotlight(from, to, isMafia, instant) {
    if (!from || !to) { sp.goal = 0; mark.obj.visible = false; if (instant) { sp.k = 0; spot.intensity = 0; beam.visible = false; } return; }
    const a = from.roof.clone(), b = to.group.position.clone().setY(to.top * 0.45);
    if (from === to) a.y += 9;
    const len = a.distanceTo(b), w = to.spec.half * HS * 1.35;
    beam.position.copy(a); beam.scale.set(w, len, w);
    beam.quaternion.setFromUnitVectors(up, tmp.copy(a).sub(b).normalize());
    spot.position.copy(a); spot.target.position.copy(b); spot.distance = len * 1.6; spot.angle = Math.atan2(w, len) * 1.15;
    mark.obj.position.copy(to.group.position).setY(to.top + 1.6);
    mark.box.textContent = isMafia ? '✗ Mafia' : '✓ Not mafia'; mark.box.dataset.kind = isMafia ? 'mafia' : 'clear';
    mark.obj.visible = true; beam.visible = true;
    sp.goal = 1; if (instant) sp.k = 1;
  }

  // ---- bursts and confetti --------------------------------------------------------------------
  const sparks = new Particles(70, { additive: true }); sparks.opacity = 0; group.add(sparks);
  const sv = new Float32Array(70 * 3); let sparkT = 0;
  /** One burst of sparks at a time: a new one restarts the same 70 particles. */
  function burst(pos, color, power = 6) {
    sparkT = 1;
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * TAU, e = Math.random() * 1.3, v = power * (0.35 + Math.random() * 0.65);
      sv[i * 3] = Math.sin(a) * Math.cos(e) * v; sv[i * 3 + 1] = Math.sin(e) * v + 1.5; sv[i * 3 + 2] = Math.cos(a) * Math.cos(e) * v;
      sparks.set(i, pos.x, pos.y, pos.z, color[0], color[1], color[2], 1, 0.28 + Math.random() * 0.25);
    }
    sparks.opacity = 1;
  }
  const confetti = new Particles(240, { square: true }); confetti.opacity = 0; group.add(confetti);
  const cf = [...Array(240)].map((_, i) => ({ a: (i * 2.399) % TAU, r: Math.sqrt((i * 0.618) % 1), ph: (i * 0.731) % 1, sp: 0.16 + ((i * 0.37) % 1) * 0.14 }));
  let confettiColors = null;
  const PALETTES = { town: [[1, 0.78, 0.25], [0.3, 0.66, 0.95], [0.4, 0.9, 0.6], [1, 1, 1], [0.97, 0.56, 0.7]], mafia: [[0.9, 0.12, 0.16], [0.55, 0.05, 0.1], [1, 0.45, 0.4], [0.15, 0.05, 0.07]] };
  function setConfetti(winner) { confettiColors = PALETTES[winner] || null; confetti.opacity = confettiColors ? 1 : 0; }

  // ---- toasts above the plaza -----------------------------------------------------------------
  const toast = floating('scn-pill', 20), banner = floating('scn-banner', 21);
  toast.obj.position.set(0, 10.5, 0); banner.obj.position.set(0, 14, 0); group.add(toast.obj, banner.obj);
  const flashEl = el('scn-flash'); overlay.appendChild(flashEl);
  let flash = 0;   // 1 at a night kill, back to 0 in under a second of scene time

  return {
    setArc, clearArcs() { for (const k of [...arcs.keys()]) removeArc(k); },
    setShield, breakShield, setSpotlight, burst, setConfetti,
    toast(text, kind = 'quiet') {
      toast.obj.visible = !!text; if (!text) return;
      const e = toast.box; e.textContent = text; e.dataset.kind = kind; e.style.animation = 'none'; void e.offsetWidth; e.style.animation = '';
    },
    banner(winner) { banner.obj.visible = !!winner; banner.box.textContent = winner ? `${winner} wins` : ''; banner.box.dataset.winner = winner || ''; },
    flash() { flash = 1; },
    update(dt, t, speed) {
      if (flash > 0) { flash = Math.max(0, flash - dt * 1.2 * speed); flashEl.style.opacity = flash ? (flash * flash).toFixed(3) : ''; }
      for (const a of arcs.values()) {
        if (a.t < 1) { a.t = Math.min(1, a.t + dt * 2.6 * speed); drawArc(a); }
        a.pulse.position.copy(a.curve.getPoint(Math.min(a.t, (t * 0.7 + a.phase) % 1)));
      }
      const ease = 1 - Math.exp(-dt * 6 * speed);
      if (shield.visible) {
        sh.k += (sh.goal - sh.k) * ease;
        if (sh.burst) sh.burst = Math.min(1, sh.burst + dt * 2.2 * speed);
        // growing in: scale follows k. breaking: it swells and fades out.
        const vis = sh.burst ? 1 - sh.burst : sh.k, pulse = 0.85 + 0.15 * Math.sin(t * 2.4);
        shield.scale.copy(sh.size).multiplyScalar(sh.burst ? 1 + sh.burst * 0.45 : lerp(0.55, 1, sh.k));
        shieldMat.opacity = (sh.burst ? 0.5 : 0.17) * vis * pulse; cageMat.opacity = 0.55 * vis; ringMat.opacity = 0.8 * vis;
        if (sh.goal === 0 && (sh.burst >= 1 || (!sh.burst && sh.k < 0.01))) { shield.visible = false; sh.burst = 0; sh.k = 0; }
      }
      if (beam.visible) {
        sp.k += (sp.goal - sp.k) * ease;
        beam.material.opacity = 0.14 * sp.k * (0.9 + 0.1 * Math.sin(t * 3)); spot.intensity = 900 * sp.k;
        if (sp.goal === 0 && sp.k < 0.01) { spot.intensity = 0; beam.visible = false; }
      }
      if (sparkT > 0) {
        sparkT = Math.max(0, sparkT - dt * 0.9 * Math.min(speed, 3));
        const p = sparks.pos, h = dt * Math.min(speed, 3);
        for (let i = 0; i < 70; i++) {
          sv[i * 3 + 1] -= 9 * h;
          p[i * 3] += sv[i * 3] * h; p[i * 3 + 1] = Math.max(0.05, p[i * 3 + 1] + sv[i * 3 + 1] * h); p[i * 3 + 2] += sv[i * 3 + 2] * h;
          sparks.col[i * 4 + 3] = sparkT;
        }
        sparks.commit(); sparks.opacity = sparkT > 0 ? 1 : 0;
      }
      if (confettiColors) {
        const R = world.L.Rplaza + 5;
        cf.forEach((c, i) => {
          const fall = (t * c.sp + c.ph) % 1, col = confettiColors[i % confettiColors.length];
          confetti.set(i, Math.sin(c.a) * c.r * R + Math.sin(t * 1.3 + i) * 0.5, 15 * (1 - fall), Math.cos(c.a) * c.r * R + Math.cos(t * 1.1 + i) * 0.5, col[0], col[1], col[2], Math.min(1, (1 - fall) * 6) * Math.min(1, fall * 10), 0.17);
        });
        confetti.commit();
      }
    },
  };
}
