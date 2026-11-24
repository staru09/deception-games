// The 3D Senate chamber. It follows the viewer's reducer (state.js) the way the Mafia viewer's village
// follows its snapshot and events:
//
//   const scene = await createScene(container, { players: config.players });   // throws without WebGL
//   scene.update(state, ctx);   // from replay.js render(): ctx.fired animates, a seek or a view switch jumps
//   scene.dispose();
//
// The characters, name labels, sky and particles are the Mafia scene's (../mafia/scene/). Spoilers: the
// scene draws only what the state holds for this view; roles come from stage.js roleOf().
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadAssets } from '../mafia/scene/assets.js';
import { Actor } from '../mafia/scene/actors.js';
import { createLabel, styleElement } from '../mafia/scene/fx.js';
import { createSky } from '../mafia/scene/world.js';
import { Particles, pointScale, pointPx } from '../mafia/scene/particles.js';
import { lerp, clamp, TAU } from '../mafia/scene/layout.js';
import { buildChamber, makeCard, CARD, TABLE_TOP, STACK, SLOT_SCALE } from './chamber.js';
import { spotOf, tableCards, peekCards, roleOf, sideOf, facing, ROSTRA, TABLE } from './stage.js';

// toga colours: none is the green or red the sides use
const COLORS = ['#efe4cc', '#7d5ba6', '#4ea8de', '#f2a93b', '#3aa8a0', '#d98bb0', '#6c7a96', '#c9a227', '#b388eb', '#c9ada7'];
const POWER = {   // beam colour and the word over the target
  investigate: { color: 0x9fd3ff, pill: 'Investigated' },
  special_election: { color: 0xffd66b, pill: 'Next Consul' },
  execution: { color: 0xff3b3b, pill: 'Condemned' },
};
const SENATOR_SCALE = 1.15;              // the characters a little larger than in the village, to carry the chamber
const TILT = 0.75;                        // a law on the table leans back this far from upright, toward the camera
const CARD_GAP = 1.62;                    // between the laws on the table
const DAY = 0.06;                         // createSky's blend: a touch of late-afternoon warmth
const HOME = { target: new THREE.Vector3(0, 4.0, -3.4), halfW: 14.8, halfH: 8.6, el: 0.42 };
const IDLE_RETURN = 20;                   // seconds after the user lets go of the camera before it drifts back
const CSS = `
.scn-role[data-role=loyalist]{background:#25804f}
.scn-role[data-role=conspirator]{background:#b4262f}
.scn-role[data-role=usurper]{background:#6e0c18;box-shadow:0 0 0 1px #f3d27a}
.sen-office{margin-left:1px;padding:0 6px;border-radius:999px;font-size:9.5px;font-weight:800;letter-spacing:.06em;line-height:1.6;text-transform:uppercase;color:#2b1d04;background:linear-gradient(#f6dc8e,#c9953a)}
.sen-office[data-office=prefect]{color:#18203a;background:linear-gradient(#eef1f8,#9ea9c4)}
.sen-chk{padding:0 7px;border-radius:999px;font-size:9.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;line-height:1.55;color:#fff;background:rgba(14,17,27,.78);border:1px solid rgba(255,255,255,.25)}
.sen-chk[data-side=loyalist]{background:#25804f}.sen-chk[data-side=conspiracy]{background:#b4262f}
.sen-pill{margin-bottom:5px;padding:3px 11px;border-radius:999px;color:#fff;font-size:12px;font-weight:700;white-space:nowrap;background:rgba(14,17,27,.88);border:1px solid rgba(255,255,255,.3);box-shadow:0 2px 10px rgba(0,0,0,.4);animation:scn-pop .2s ease-out}
.sen-pill[data-kind=execution]{background:#a3141f;border-color:#ff9aa1}
.sen-pill[data-kind=special_election]{background:#8a6414;border-color:#f6dc8e}
.sen-pill[data-kind=loyalist]{background:#25804f;border-color:#8fe8c3}
.sen-pill[data-kind=conspiracy]{background:#b4262f;border-color:#ff9aa1}
.sen-flash{position:absolute;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(255,30,30,.08) 30%,rgba(150,0,0,.55) 100%)}
.scn-compact .sen-office,.scn-compact .sen-chk{font-size:8.5px;padding:0 5px}
`;

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const smooth = (k) => k * k * (3 - 2 * k);
const qx = (a) => new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), a);
const Q = { upright: new THREE.Quaternion(), table: qx(-TILT), flat: qx(-Math.PI / 2), peek: qx(-0.3) };
const FLIP = new THREE.Quaternion(), Y = V(0, 1, 0);

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A coin held up by a voter: Aye or Nay. */
function tokenTexture(aye) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(54, 48, 6, 64, 64, 60);
  gr.addColorStop(0, aye ? '#5fd08e' : '#f0626b'); gr.addColorStop(1, aye ? '#17633a' : '#7d121b');
  g.beginPath(); g.arc(64, 64, 58, 0, TAU); g.fillStyle = gr; g.fill();
  const rim = g.createLinearGradient(0, 0, 128, 128); rim.addColorStop(0, '#fbe6a6'); rim.addColorStop(0.5, '#b8862e'); rim.addColorStop(1, '#f3d27a');
  g.lineWidth = 8; g.strokeStyle = rim; g.stroke();
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 34px "Cinzel", "Times New Roman", serif'; g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 4;
  g.fillText(aye ? 'AYE' : 'NAY', 64, 68);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A gold or silver laurel wreath, open at the brow. */
function wreath(color) {
  const g = new THREE.Group(), leaf = new THREE.SphereGeometry(1, 8, 6);
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 1, roughness: 0.28, emissive: color, emissiveIntensity: 0.18 });
  const R = 0.62;
  for (const side of [-1, 1]) for (let i = 0; i < 9; i++) {   // tied at the back (-z), the tips running forward to the brow
    const a = Math.PI + side * (0.3 + i * 0.29);
    for (const row of [-1, 1]) {
      const pivot = new THREE.Object3D(), m = new THREE.Mesh(leaf, mat);
      pivot.position.set(Math.sin(a) * (R + row * 0.04), 0.02 + row * 0.035, Math.cos(a) * (R + row * 0.04));
      pivot.rotation.y = a + side * (Math.PI / 2 - 0.3 * row);   // along the ring, splayed out or in
      m.scale.set(0.075, 0.025, 0.18); m.rotation.x = -0.25 - 0.2 * row;   // tip up a little
      pivot.add(m); g.add(pivot);
    }
  }
  const band = new THREE.Mesh(new THREE.TorusGeometry(R, 0.025, 6, 32).rotateX(Math.PI / 2), mat);
  g.add(band);
  return g;
}

export async function createScene(container, { players = [] } = {}) {
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }); }
  catch { throw new Error('WebGL is not available, so the 3D chamber cannot be shown.'); }
  const root = document.createElement('div'); root.className = 'scn-root';
  const labels = new CSS2DRenderer(); labels.domElement.className = 'scn-layer';
  const style = document.createElement('style'); style.textContent = CSS;
  const flashEl = document.createElement('div'); flashEl.className = 'sen-flash';
  root.append(styleElement(), style, renderer.domElement, labels.domElement, flashEl);
  container.prepend(root);

  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 0.94;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 6000);
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 8, maxDistance: 70, maxPolarAngle: 1.42, minPolarAngle: 0.15, minAzimuthAngle: -1.3, maxAzimuthAngle: 1.3, zoomSpeed: 0.8 });

  let assets, chamber;
  try {
    [assets] = await Promise.all([
      loadAssets(new URL('../mafia/assets/', import.meta.url).href),
      Promise.race([document.fonts.load('700 40px Cinzel'), new Promise((r) => setTimeout(r, 2500))]).catch(() => {}),
    ]);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.35;
    pmrem.dispose();
    chamber = buildChamber({ scene, n: players.length, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  } catch (e) {
    controls.dispose(); renderer.dispose(); root.remove();
    throw e;
  }
  const sky = createSky(scene, 34); sky.set(DAY);
  // less sky fill and a warmer sun than the village, so the marble shows its shadows
  sky.hemi.intensity = 0.7; sky.sun.intensity = 3.4; sky.sun.color.set(0xffe0b2);

  // ---- senators -------------------------------------------------------------------------------
  const actors = players.map((p, i) => {
    const color = COLORS[i % COLORS.length], a = new Actor({ name: String(p.name), role: 'loyalist', color }, { i }, assets);
    a.seatSpot = chamber.seats[i]; a.i = i;
    for (const r of Object.values(a.rigs)) r.object.scale.multiplyScalar(SENATOR_SCALE);   // the figure, not its name tag's height
    a.label = createLabel({ name: a.name, color }); a.anchor.add(a.label.obj);
    const nameEl = a.label.obj.element.querySelector('.scn-name'), tag = a.label.obj.element.querySelector('.scn-tag');
    a.officeEl = document.createElement('span'); a.officeEl.className = 'sen-office'; a.officeEl.hidden = true;
    nameEl.insertBefore(a.officeEl, nameEl.lastChild);
    a.chkEl = document.createElement('span'); a.chkEl.className = 'sen-chk'; a.chkEl.hidden = true; tag.append(a.chkEl);
    a.pillEl = document.createElement('div'); a.pillEl.className = 'sen-pill'; a.pillEl.hidden = true; tag.before(a.pillEl);
    a.where = null; a.dead = false; a.saying = null; a.marks = '';
    a.token = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false })); a.token.visible = false; a.token.vote = null; a.token.pop = 1;
    scene.add(a.group, a.token);
    return a;
  });
  const byName = new Map(actors.map((a) => [a.name, a]));
  const tokenMats = { true: tokenTexture(true), false: tokenTexture(false) };
  const laurels = { consul: wreath(0xe2b04a), prefect: wreath(0xd9dee8) };
  for (const w of Object.values(laurels)) { w.visible = false; scene.add(w); }

  // ---- effects: speaker light, glow under feet, power beam, flash, sparks, confetti -----------
  const glow = glowTexture();
  const spot = new THREE.SpotLight(0xffe2ad, 0, 40, 0.32, 0.6, 1.2);
  scene.add(spot, spot.target);   // always in the scene at intensity 0: adding a light later recompiles every shader
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: glow, color: 0xffc25a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  pool.scale.setScalar(3.6); scene.add(pool);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.32, 1, 16, 1, true).translate(0, 0.5, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.15, 48).rotateX(-Math.PI / 2), beam.material.clone());
  beam.visible = halo.visible = false; scene.add(beam, halo);
  const sparks = new Particles(80, { additive: true }); sparks.opacity = 0; scene.add(sparks);
  const sv = new Float32Array(80 * 3); let sparkT = 0, flash = 0;
  function burst(pos, color, power = 5) {
    sparkT = 1;
    for (let i = 0; i < 80; i++) {
      const a = Math.random() * TAU, e = Math.random() * 1.3, v = power * (0.35 + Math.random() * 0.65);
      sv.set([Math.sin(a) * Math.cos(e) * v, Math.sin(e) * v + 1.5, Math.cos(a) * Math.cos(e) * v], i * 3);
      sparks.set(i, pos.x, pos.y, pos.z, color[0], color[1], color[2], 1, 0.22 + Math.random() * 0.2);
    }
  }
  const confetti = new Particles(260, { square: true }); confetti.opacity = 0; scene.add(confetti);
  const cf = [...Array(260)].map((_, i) => ({ a: (i * 2.399) % TAU, r: Math.sqrt((i * 0.618) % 1), ph: (i * 0.731) % 1, sp: 0.14 + ((i * 0.37) % 1) * 0.12 }));
  const PALETTE = { loyalists: [[0.25, 0.75, 0.45], [1, 0.84, 0.4], [1, 1, 1], [0.55, 0.9, 0.65]], conspiracy: [[0.85, 0.1, 0.15], [0.45, 0.04, 0.08], [1, 0.82, 0.35], [0.12, 0.05, 0.07]] };
  let confettiColors = null;

  // ---- law cards: one pool, each card on the table, peeked, flying or going to a pile ---------
  const cards = [], spare = [];
  const table = [], peeking = [];
  const pending = new Set();   // track slots a flying law has not reached yet
  const slotCards = { reform: [], decree: [] };
  for (const law of ['reform', 'decree']) {
    for (let i = 0; i < (law === 'reform' ? 5 : 6); i++) {
      const c = makeCard(chamber.cards); c.front.material = chamber.cards[law];
      c.position.copy(chamber.slotPos(law, i)); c.scale.setScalar(SLOT_SCALE); c.visible = false;
      scene.add(c); slotCards[law].push(c);
    }
  }
  function take() {
    const c = spare.pop() ?? (() => { const o = { obj: makeCard(chamber.cards), q: new THREE.Quaternion(), flip: 0, anim: null, law: null, key: '' }; scene.add(o.obj); cards.push(o); return o; })();
    c.obj.visible = true; c.anim = null; c.key = ''; setLaw(c, null);
    return c;
  }
  const release = (c) => { c.obj.visible = false; c.anim = null; if (!spare.includes(c)) spare.push(c); };
  function setLaw(c, law) { c.law = law; c.obj.front.material = chamber.cards[law ?? 'back']; }
  function pose(c, p, q, flip, s = 1) {
    c.obj.position.copy(p); c.q.copy(q); c.flip = flip; c.obj.scale.setScalar(s);
    c.obj.quaternion.copy(q).multiply(FLIP.setFromAxisAngle(Y, flip));
  }
  /** Move a card to a pose: at once when dur is 0, else along an arc of height `arc`. */
  function move(c, to, dur, arc = 0, done = null) {
    if (dur <= 0) { c.anim = null; pose(c, to.p, to.q, to.flip, to.s ?? 1); done?.(); return; }
    c.anim = { p0: c.obj.position.clone(), q0: c.q.clone(), f0: c.flip, s0: c.obj.scale.x, to, t: 0, dur, arc, done };
  }
  const tablePose = (i, n, law) => ({ p: V(TABLE.x + (i - (n - 1) / 2) * CARD_GAP, TABLE_TOP + CARD.h / 2 * Math.cos(TILT) + 0.04, TABLE.z + 0.15), q: Q.table, flip: law ? 0 : Math.PI });
  const pilePose = (x, top) => ({ p: V(TABLE.x + x, top + 0.04, TABLE.z), q: Q.flat, flip: Math.PI });
  const peekPose = (i, law) => ({ p: V(TABLE.x + STACK.deck + (i - 1) * 1.45, TABLE_TOP + 2.3, TABLE.z + 0.6), q: Q.peek, flip: law ? 0 : Math.PI });
  const slotPose = (law, i) => ({ p: chamber.slotPos(law, i), q: Q.upright, flip: 0, s: SLOT_SCALE });
  const toPile = (c, instant) => (instant ? release(c) : move(c, pilePose(STACK.discard, chamber.discardTop()), 0.6 / mul(), 0.5, () => release(c)));

  // ---- state as the scene shows it ------------------------------------------------------------
  let speed = 1, time = 0, disposed = false, last = null, focus = null, power = null, speakerName = null;
  const tweens = new Map();
  const mul = () => speed ** 0.75;   // effects speed up more gently than the playback

  function spotPose(a, where) {
    if (where === 'seat') return { pos: V(a.seatSpot.x, 0, a.seatSpot.z), yaw: a.seatSpot.yaw };
    const r = ROSTRA[where];
    return { pos: V(r.x, 0, r.z), yaw: facing(r.x, r.z, r.x * 0.3, 16) };
  }
  /** From a seat to a rostrum or back: by a point in front of the senators, clear of the table. */
  function route(a, from, to) {
    const end = spotPose(a, to).pos, rostrum = ROSTRA[to] ?? ROSTRA[from];
    return [V(rostrum.x * 0.5, 0, -2.5), end];
  }
  const headOf = (a, out) => (a.dead ? a.seatStub().getWorldPosition(out) : out.copy(a.group.position).setY(a.group.position.y + 3.0));
  for (const a of actors) a.seatStub = () => chamber.memorials[a.i].stub;

  function memorial(a, on, instant) {
    const m = chamber.memorials[a.i];
    m.stub.visible = on;
    (on ? m.anchor : a.anchor).add(a.label.obj);
    if (on && !instant) { m.stub.scale.y = 0.01; tweens.set('stub:' + a.name, { t: 0, dur: 0.7, fn: (k) => { m.stub.scale.y = Math.max(0.01, smooth(k)); } }); }
    else m.stub.scale.y = 1;
  }

  // ---- one event, as it plays -----------------------------------------------------------------
  function handle(ev, s) {
    switch (ev.type) {
      case 'round':
        for (const a of actors) if (!a.dead && !a.path.length) a.yaw = spotPose(a, a.where ?? 'seat').yaw;
        break;
      case 'message': {
        const a = byName.get(ev.name);
        if (!a || a.dead) break;
        a.rig.gesture('talk', Math.min(mul(), 2.5));
        for (const o of actors) if (o !== a && !o.dead && !o.path.length) o.face(a.group.position);
        break;
      }
      case 'vote': {
        const a = byName.get(ev.voter);
        if (a && !a.dead) { a.token.pop = 0; if (ev.aye) a.rig.gesture('agree', Math.min(mul(), 2.5)); }
        break;
      }
      case 'vote_result':
        if (!ev.passed) burst(chamber.lamps[clamp(ev.tracker - 1, 0, 2)].position, [1, 0.55, 0.15], 3);
        break;
      case 'discard': {   // god view: the discarded law leaves the hand for the pile
        const i = table.findIndex((c) => c.law === ev.law);
        if (i >= 0) toPile(table.splice(i, 1)[0], false);
        break;
      }
      case 'enact': {
        const n = ev.law === 'reform' ? ev.reforms : ev.decrees, key = `${ev.law}:${n - 1}`;
        let c;
        if (ev.by !== 'chaos' && table.length) {   // the law the Prefect kept; in town view, the middle face-down card
          const i = table.findIndex((x) => x.law === ev.law);
          c = table.splice(i >= 0 ? i : Math.floor(table.length / 2), 1)[0];
        } else { c = take(); move(c, pilePose(STACK.deck, chamber.deckTop()), 0); }   // chaos: the top law of the deck
        setLaw(c, ev.law);
        pending.add(key);
        const target = chamber.slotPos(ev.law, n - 1);
        move(c, slotPose(ev.law, n - 1), 1.7 / mul(), 5, () => {
          release(c); pending.delete(key);
          slotCards[ev.law][n - 1].visible = (ev.law === 'reform' ? s.reforms : s.decrees) >= n;
          burst(target, ev.law === 'reform' ? [0.5, 1, 0.65] : [1, 0.3, 0.25], 4);
        });
        break;
      }
      case 'power': {
        const a = byName.get(ev.by);
        a?.rig.gesture('talk', Math.min(mul(), 2.5));
        const t = byName.get(ev.target);
        if (a && t && !a.path.length) a.face(t.group.position);
        break;
      }
      case 'executed': {
        const a = byName.get(ev.name);
        if (!a || a.dead) break;
        a.dead = true; a.label.hush(); a.saying = null;
        flash = 1; burst(a.group.position.clone().setY(1.6), [1, 0.15, 0.12], 5);
        a.die(() => memorial(a, true, false));
        break;
      }
      case 'reshuffle':
        burst(V(TABLE.x + STACK.deck, TABLE_TOP + 0.6, TABLE.z), [1, 0.9, 0.6], 2.5);
        break;
      case 'game_over':
        burst(V(0, 6, 0), ev.winner === 'loyalists' ? [0.5, 1, 0.65] : [1, 0.25, 0.2], 9);
        break;
    }
  }

  // ---- the whole picture from the state: at once (instant) or by easing toward it -------------
  function show(s, ctx, instant) {
    const god = ctx.god, step = s.step;
    const speaker = (step.kind === 'debate' || step.kind === 'report') ? step.speaker : null;
    power = step.kind === 'power' && POWER[step.power] ? step : null;
    speakerName = speaker;
    focus = speaker ?? power?.target ?? (step.kind === 'enacted' ? 'boards' : null);

    for (const a of actors) {
      const p = s.players[a.i], where = spotOf(s, a.name), role = roleOf(s, god, ctx.config, a.name);
      if (where === 'gone') {
        if (instant || !a.dead) { a.hide(); memorial(a, true, true); }
        a.dead = true; a.where = 'gone';
      } else {
        if (a.dead) { a.dead = false; memorial(a, false, true); a.where = null; }
        const won = s.over && sideOf(s.roles[a.name] ?? role) === s.over.winner;
        const base = won ? 'celebrate' : 'idle', to = spotPose(a, where);
        to.pos.y = chamber.groundAt(to.pos.x, to.pos.z);
        if (a.where !== where) {
          if (instant || a.where === null) a.place(to.pos, base, to.yaw);
          else a.walk(route(a, a.where, where), base, to.yaw);
          a.where = where;
        } else if (a.after) a.after.base = base;
        else if (a.baseName !== base) a.setBase(base);
        const sp = byName.get(speaker);
        if (instant) a.yaw = sp && sp !== a ? facing(to.pos.x, to.pos.z, sp.group.position.x, sp.group.position.z) : to.yaw;
      }
      // name tag: office, role, what an investigation showed
      a.label.setDead(!p.alive); a.label.setRole(role);
      const office = s.consul === a.name ? 'consul' : s.prefect === a.name ? 'prefect' : '';
      const chk = power?.target === a.name ? '' : p.checked ? (god || s.over ? p.checked : 'investigated') : p.investigated ? 'investigated' : '';   // during the moment itself, the pill says it
      const marks = `${office}|${chk}`;
      if (marks !== a.marks) {
        a.marks = marks;
        a.officeEl.hidden = !office; a.officeEl.textContent = office; a.officeEl.dataset.office = office;
        a.chkEl.hidden = !chk; a.chkEl.dataset.side = chk; a.chkEl.textContent = chk === 'investigated' ? 'Investigated' : chk === 'loyalist' ? 'Seen loyal' : chk ? 'Seen conspiring' : '';
        a.label.resized();
      }
      // speech bubble while this senator's message shows
      if (speaker === a.name && p.alive) { if (a.saying !== step.text) { a.label.say(step.text); a.saying = step.text; } }
      else if (a.saying !== null) { a.label.hush(); a.saying = null; }
      // the vote token
      const vote = p.alive ? p.vote : null;
      a.token.visible = vote !== null;
      if (vote !== null && a.token.vote !== vote) { a.token.material.map = tokenMats[vote]; a.token.material.needsUpdate = true; a.token.vote = vote; }
      if (instant) a.token.pop = 1;
      // the word over a power's target
      const pill = power?.target === a.name ? (power.power === 'investigate' && power.result && god ? power.result : power.power) : null;
      a.pillEl.hidden = !pill;
      if (pill) { a.pillEl.dataset.kind = pill; a.pillEl.textContent = pill === 'loyalist' ? 'Loyalist' : pill === 'conspiracy' ? 'Conspiracy' : !p.alive ? 'Executed' : POWER[pill].pill; }
    }
    laurels.consul.holder = byName.get(s.consul) ?? null; laurels.prefect.holder = byName.get(s.prefect) ?? null;

    // laws in hand on the table
    const want = tableCards(s);
    if (instant) { for (const c of cards) release(c); table.length = peeking.length = 0; pending.clear(); }
    while (table.length > want.length) toPile(table.pop(), instant);
    while (table.length < want.length) { const c = take(); move(c, pilePose(STACK.deck, chamber.deckTop()), 0); table.push(c); }
    table.forEach((c, i) => {
      if (want[i] && c.law !== want[i]) setLaw(c, want[i]);
      const key = `t${i}/${want.length}/${c.law}`;
      if (key !== c.key) { c.key = key; move(c, tablePose(i, want.length, c.law), instant ? 0 : 0.6 / mul(), instant ? 0 : 0.4); }
    });
    // a peek: the top three laws rise from the deck
    const peek = peekCards(s);
    while (peeking.length > peek.length) { const c = peeking.pop(); instant ? release(c) : move(c, pilePose(STACK.deck, chamber.deckTop()), 0.5 / mul(), 0.3, () => release(c)); }
    while (peeking.length < peek.length) { const c = take(); move(c, pilePose(STACK.deck, chamber.deckTop()), 0); peeking.push(c); }
    peeking.forEach((c, i) => {
      if (peek[i] && c.law !== peek[i]) setLaw(c, peek[i]);
      const key = `p${i}/${c.law}`;
      if (key !== c.key) { c.key = key; move(c, peekPose(i, c.law), instant ? 0 : 0.7 / mul(), 0); }
    });
    // the track boards, the piles, the failed votes
    for (const law of ['reform', 'decree']) {
      const count = law === 'reform' ? s.reforms : s.decrees;
      slotCards[law].forEach((c, i) => { c.visible = i < count && !pending.has(`${law}:${i}`); });
    }
    chamber.setCounts(Math.max(0, s.drawPile), s.discardPile, s.tracker);
    confettiColors = s.over ? PALETTE[s.over.winner] : null; confetti.opacity = confettiColors ? 1 : 0;
  }

  function update(s, ctx) {
    speed = clamp(Number(ctx.speed) || 1, 0.25, 32);
    const instant = !ctx.fired.length;
    if (instant && last && ctx.cursor === last.cursor && ctx.god === last.god) return;   // a redraw with nothing new
    last = { cursor: ctx.cursor, god: ctx.god, ctx };
    if (instant) { tweens.clear(); flash = 0; sparkT = 0; }
    else for (const ev of ctx.fired) handle(ev, s);
    show(s, ctx, instant);
  }

  // ---- post-processing, as in the Mafia scene: bloom at half size, then tone mapping and FXAA --
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.22, 0.5, 0.9), bloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSize(w >> 1, h >> 1);
  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(new RenderPass(scene, camera)); composer.addPass(bloom); composer.addPass(new OutputPass()); composer.addPass(fxaa);

  // ---- camera: a slow drift around the chamber that leans toward whoever has the floor --------
  const cam = { auto: true, idle: 0, target: HOME.target.clone(), dist: 34, az: 0, el: HOME.el };   // eased toward goal()
  const view = { w: 1, h: 1 };
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const tall = () => clamp((1.1 - camera.aspect) / 0.5, 0, 1);   // 0 on a wide stage, 1 on a phone held upright
  function homeDist() {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return clamp(Math.max(HOME.halfH / t, lerp(HOME.halfW, 13.2, tall()) / (t * camera.aspect)), 12, 70);
  }
  const focusAt = V(), tmp = V(), off = V();
  function goal() {
    const d = homeDist(), el = HOME.el + 0.42 * tall(), g = { target: HOME.target, dist: d, az: 0, el };   // upright: look down more, the floor fills the height
    const a = byName.get(focus);
    if (focus === 'boards') return { target: tmp.copy(HOME.target).lerp(chamber.boardsCentre, 0.15), dist: d * 0.96, az: 0, el: el + 0.03 };
    if (!a) return g;
    headOf(a, focusAt);   // a lean toward whoever has the floor, small enough to keep the whole Senate in view
    return { target: tmp.copy(HOME.target).lerp(focusAt, 0.12), dist: d * 0.97, az: clamp(Math.atan2(focusAt.x, 28) * 0.25, -0.1, 0.1), el: el - 0.01 };
  }
  controls.addEventListener('start', () => { cam.auto = false; cam.idle = 0; });
  controls.addEventListener('end', () => { cam.idle = 0; });
  const onDbl = () => { resumeAuto(); };
  renderer.domElement.addEventListener('dblclick', onDbl);
  function resumeAuto() {
    off.copy(camera.position).sub(controls.target);
    cam.target.copy(controls.target); cam.dist = off.length();
    cam.az = Math.atan2(off.x, off.z); cam.el = Math.asin(clamp(off.y / cam.dist, -1, 1));
    cam.auto = true;
  }
  function moveCamera(dt) {
    if (!cam.auto) {
      controls.update(dt);
      if ((cam.idle += dt) > IDLE_RETURN) resumeAuto();
      return;
    }
    const g = goal(), e = 1 - Math.exp(-dt * 1.1);
    cam.target.lerp(g.target, e); cam.dist = lerp(cam.dist, g.dist, e); cam.az = lerp(cam.az, g.az, e); cam.el = lerp(cam.el, g.el, e);
    const az = cam.az + (calm ? 0 : 0.12 * Math.sin(time * 0.07)), el = cam.el + (calm ? 0 : 0.025 * Math.sin(time * 0.05));
    camera.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(cam.dist).add(cam.target);
    controls.target.copy(cam.target); camera.lookAt(cam.target);
  }

  function resize() {
    const w = root.clientWidth, h = root.clientHeight, pr = Math.min(window.devicePixelRatio || 1, 2);
    if (w < 40 || h < 40) return;   // not laid out yet: a sliver would fit the camera miles away
    renderer.setPixelRatio(pr); renderer.setSize(w, h);
    composer.setPixelRatio(pr); composer.setSize(w, h);
    fxaa.enabled = pr < 1.5; fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    labels.setSize(w, h); view.w = w; view.h = h;
    root.classList.toggle('scn-compact', w < 560 || h < 340);
    for (const a of actors) a.label.resized();
    camera.aspect = w / h; camera.fov = lerp(38, 54, clamp((1.5 - camera.aspect) / 0.9, 0, 1)); camera.updateProjectionMatrix();
    pointScale.value = h * pr / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); pointPx.value = pr;
    if (cam.auto && !last) { cam.dist = homeDist(); cam.el = goal().el; }
  }
  const observer = new ResizeObserver(resize); observer.observe(root);

  // ---- frame loop -----------------------------------------------------------------------------
  const camDir = V(), hp = V();
  let lastFrame = performance.now(), snap = true;
  const dev = { manual: false };   // a test page sets manual and steps the time with _dev.advance()
  function frame() {
    if (disposed) return;
    if (!root.isConnected) return dispose();
    const now = performance.now();
    let dt = dev.manual ? 0 : Math.min(2, (now - lastFrame) / 1000); lastFrame = now;
    for (; dt > 0.1; dt -= 0.1) step(0.1, false);
    step(dt, true);
  }
  function step(dt, draw) {
    time += dt;
    const m = mul(), ease = 1 - Math.exp(-dt * 6);
    for (const [key, t] of tweens) { t.t += dt * m; const k = Math.min(1, t.t / t.dur); t.fn(k); if (k >= 1) tweens.delete(key); }
    camera.getWorldDirection(camDir);
    for (const a of actors) {
      a.update(dt, speed);
      const gp = a.group.position;
      gp.y += (chamber.groundAt(gp.x, gp.z) - gp.y) * (1 - Math.exp(-dt * 10));
      const tk = a.token;
      if (tk.visible) {   // held up in front of the senator, toward the camera
        tk.pop = Math.min(1, tk.pop + dt * 3.2 * m);
        const k = tk.pop, back = 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;   // ease out with a little overshoot
        tk.position.set(gp.x - camDir.x * 1.0, gp.y + lerp(0.9, 2.05, smooth(k)), gp.z - camDir.z * 1.0);
        tk.scale.setScalar(1.05 * Math.max(0.01, back));
      }
    }
    for (const w of Object.values(laurels)) {   // the wreath rides on the officer's head
      const a = w.holder;
      w.visible = !!a && !a.dead && !a.gone;
      if (!w.visible) continue;
      const head = a.rig.head;
      if (head) head.getWorldPosition(hp).y += 0.95; else hp.copy(a.group.position).setY(a.group.position.y + 3.25);
      w.position.copy(hp); w.rotation.y = a.group.rotation.y;
    }
    // cards
    for (const c of cards) {
      const A = c.anim;
      if (!A) continue;
      A.t += dt; const k = Math.min(1, A.t / A.dur), e = smooth(k);
      tmp.lerpVectors(A.p0, A.to.p, e); tmp.y += Math.sin(Math.PI * e) * A.arc;
      c.q.slerpQuaternions(A.q0, A.to.q, e);
      pose(c, tmp, c.q, lerp(A.f0, A.to.flip, smooth(Math.min(1, k * 1.6))), lerp(A.s0, A.to.s ?? 1, e));
      if (k >= 1) { c.anim = null; A.done?.(); }
    }
    // the speaker's light and the glow at their feet
    const sp = speakerName && byName.get(speakerName), lit = sp && !sp.dead;
    spot.intensity = lerp(spot.intensity, lit ? 240 : 0, ease);
    pool.material.opacity = lerp(pool.material.opacity, lit ? 0.4 : 0, ease);
    if (lit) {
      const p = sp.group.position;
      spot.position.set(p.x, 15, p.z + 6); spot.target.position.set(p.x, p.y + 1.6, p.z);
      pool.position.set(p.x, p.y + 0.04, p.z);
    }
    // a power: a beam from the Consul to the target, a ring at the target's feet
    const from = power && byName.get(power.by), to = power && byName.get(power.target);
    beam.visible = halo.visible = !!(from && to);
    if (beam.visible) {
      const a = headOf(from, V()).setY(from.group.position.y + 2.7), b = to.dead ? to.seatStub().getWorldPosition(V()).setY(1.2) : to.group.position.clone().setY(to.group.position.y + 1.6);
      beam.position.copy(a); beam.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize()); beam.scale.set(1, a.distanceTo(b), 1);
      beam.material.color.setHex(POWER[power.power].color); halo.material.color.setHex(POWER[power.power].color);
      beam.material.opacity = 0.6 + 0.2 * Math.sin(time * 5); halo.material.opacity = 0.7 + 0.3 * Math.sin(time * 4);
      halo.position.set(b.x, (to.dead ? 0.25 : to.group.position.y) + 0.06, b.z); halo.scale.setScalar(1 + 0.08 * Math.sin(time * 4));
    }
    // failed-vote lamps flicker when lit
    chamber.flames.forEach((f, k) => f.children.forEach((c, i) => {   // brazier fire
      const b = c.userData.base, j = time * (7 + i * 2.3) + k * 5;
      c.scale.set(b * 0.62 * (1 + 0.1 * Math.sin(j * 1.3)), b * (1 + 0.2 * Math.sin(j) + 0.1 * Math.sin(j * 2.7)), 1);
      c.material.rotation = 0.08 * Math.sin(j * 0.7);
    }));
    chamber.lamps.forEach((l, i) => { l.material.emissiveIntensity = lerp(l.material.emissiveIntensity, l.userData.on ? 3 + 0.5 * Math.sin(time * 9 + i * 2) : 0, ease); });
    if (flash > 0) { flash = Math.max(0, flash - dt * 1.1 * m); flashEl.style.opacity = flash ? (flash * flash).toFixed(3) : ''; }
    if (sparkT > 0) {
      sparkT = Math.max(0, sparkT - dt * 0.9 * Math.min(m, 3));
      const p = sparks.pos, h = dt * Math.min(m, 3);
      for (let i = 0; i < 80; i++) {
        sv[i * 3 + 1] -= 9 * h;
        p[i * 3] += sv[i * 3] * h; p[i * 3 + 1] = Math.max(0.05, p[i * 3 + 1] + sv[i * 3 + 1] * h); p[i * 3 + 2] += sv[i * 3 + 2] * h;
        sparks.col[i * 4 + 3] = sparkT;
      }
      sparks.commit(); sparks.opacity = sparkT > 0 ? 1 : 0;
    }
    if (confettiColors) {
      cf.forEach((c, i) => {
        const fall = (time * c.sp + c.ph) % 1, col = confettiColors[i % confettiColors.length];
        confetti.set(i, Math.sin(c.a) * c.r * 16 + Math.sin(time * 1.3 + i) * 0.5, 15 * (1 - fall), -3 + Math.cos(c.a) * c.r * 12 + Math.cos(time * 1.1 + i) * 0.5,
          col[0], col[1], col[2], Math.min(1, (1 - fall) * 6) * Math.min(1, fall * 10), 0.17);
      });
      confetti.commit();
    }
    moveCamera(dt);
    if (draw) { composer.render(dt); declutter(); labels.render(scene, camera); }
  }

  /** Name tags that would cover each other are stacked: the nearest stays put, the ones behind rise. */
  const projected = V(), placed = [];
  function declutter() {
    const { w, h } = view, items = [];
    for (const a of actors) {
      if (!a.label.obj.parent) continue;
      a.label.obj.getWorldPosition(projected).project(camera);
      if (Math.abs(projected.z) <= 1) items.push({ label: a.label, x: (projected.x + 1) / 2 * w, y: (1 - projected.y) / 2 * h, z: projected.z });
    }
    items.sort((p, q) => p.z - q.z);
    placed.length = 0;
    for (const it of items) {
      const [lw, lh] = it.label.extent;
      let lift = 0;
      for (let pass = 0; pass < 5; pass++) {
        const hit = placed.find((p) => Math.abs(p.x - it.x) < (p.w + lw) / 2 + 3 && it.y - lift > p.top && it.y - lift - lh < p.bottom);
        if (!hit) break;
        lift = it.y - hit.top + 2;
      }
      lift = Math.min(lift, 150);
      placed.push({ x: it.x, w: lw, top: it.y - lift - lh, bottom: it.y - lift });
      // a tag at the edge of the view slides back inside it (the bubble then centres on the tag)
      const shift = Math.round(lw ? Math.max(0, 4 - (it.x - lw / 2)) + Math.min(0, w - 4 - (it.x + lw / 2)) : 0);
      if (shift !== it.label.shift) { it.label.shift = shift; it.label.obj.element.style.translate = shift ? `${shift}px 0` : ''; }
      it.label.raise(lift, snap); it.label.keepInside(it.x + shift, w);
    }
    snap = false;
  }

  // Animation frames drive the picture; a slower timer covers for them where they do not run on time
  // (a hidden-then-shown tab, or headless Chrome's virtual clock, which timers follow and frames do not).
  const onVisibility = () => { if (document.hidden) renderer.setAnimationLoop(null); else { lastFrame = performance.now(); renderer.setAnimationLoop(guard(frame)); } };
  document.addEventListener('visibilitychange', onVisibility);
  const backup = setInterval(() => { if (!document.hidden && performance.now() - lastFrame > 120) guard(frame)(); }, 100);

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null); clearInterval(backup); observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    renderer.domElement.removeEventListener('dblclick', onDbl);
    controls.dispose();
    scene.traverse((o) => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material || [])) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose?.(); }
    });
    composer.dispose(); rt.dispose(); renderer.dispose(); root.remove();
  }
  function guard(fn) {
    return (...args) => { if (disposed) return; try { return fn(...args); } catch (e) { console.error('[senate scene]', e); } };
  }

  resize();
  try { await renderer.compileAsync(scene, camera); } catch { /* the first frame compiles what is missing */ }
  guard(frame)();
  if (!document.hidden) renderer.setAnimationLoop(guard(frame));
  const api = { update: guard(update), dispose: guard(dispose) };
  // for test pages only: freeze the clock (manual) and run the scene forward by `seconds`, then draw once
  Object.defineProperty(api, '_dev', { value: Object.assign(dev, { advance: guard((seconds) => {
    for (let left = seconds; left > 1e-6; left -= 1 / 30) step(Math.min(1 / 30, left), false);
    snap = true; step(0, true);
  }) }) });
  return api;
}
