// The 3D village for the Mafia viewer. Public API and snapshot shape: see CONTRACT.md.
//
//   const scene = await createScene(container, { players, onPlayerClick });
//   scene.sync(snapshot); scene.handle(event); scene.setReveal(bool); scene.setSkin(name);
//   scene.setTimeOfDay(mode); scene.setFollowSpeaker(bool); scene.setSpeed(n); scene.focus(name);
//
// Extras outside the contract, all optional: createScene also takes `banners: true` (the scene then shows
// its own "<team> wins" and "Nobody died tonight" texts; off by default because ui.js has banners) and
// `assetBase` (where the models live), and the returned object has dispose().
//
// The scene keeps a small copy of the game state (phase, who is alive, open votes, night actions).
// sync() overwrites it and redraws everything at once; handle() changes it one event at a time and
// animates the difference. Spoilers are decided here: `shown()` is the single switch between the
// town view and the god view, and setReveal() redraws the current picture through the same code.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { loadAssets } from './scene/assets.js';
import { buildWorld, createSky, polar } from './scene/world.js';
import { lerp, clamp } from './scene/layout.js';
import { Actor } from './scene/actors.js';
import { createFx, createLabel, styleElement } from './scene/fx.js';
import { pointScale, pointPx } from './scene/particles.js';
import { createAngel } from './scene/angel.js';

const FALLBACK_COLORS = ['#f2c14e', '#4ea8de', '#b388eb', '#ff8c42', '#3ddbd9', '#f78fb3', '#a3d977', '#c9ada7'];
const ROLES = ['mafia', 'detective', 'doctor', 'villager'];
const AGREE = /^\s*(yes|yeah|yep|yup|agreed?|same|ok|okay|true|exactly|right|sure|fair)\b/i;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const live = new WeakMap();   // container -> running scene, so creating a second one replaces the first

export async function createScene(container, { players = [], onPlayerClick, assetBase, banners = false } = {}) {
  if (!(container instanceof Element)) throw new Error('createScene: container must be a DOM element');
  live.get(container)?.dispose();
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    throw new Error('WebGL is not available, so the 3D village cannot be shown. Enable hardware acceleration or try another browser.');
  }
  const roster = players.filter(p => p && p.name != null).map((p, i) => ({
    name: String(p.name), model: p.model == null ? '' : String(p.model),
    role: ROLES.includes(p.role) ? p.role : 'villager',
    color: /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : FALLBACK_COLORS[i % FALLBACK_COLORS.length],
  }));

  // ---- DOM: one root inside the container holds the canvas and the label layer ----------------
  const root = document.createElement('div'); root.className = 'scn-root';
  const labels = new CSS2DRenderer(); labels.domElement.className = 'scn-layer';
  root.append(styleElement(), renderer.domElement, labels.domElement);
  container.prepend(root);   // first, so anything the page already put in the container stays on top

  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;   // keeps the flat-colour models saturated
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 12000);
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 7, maxPolarAngle: 1.45, minPolarAngle: 0.12, autoRotateSpeed: 0.35, zoomSpeed: 0.8 });

  // ---- world, characters, effects -------------------------------------------------------------
  let assets, world;
  const timing = { start: performance.now() };   // where start-up time goes, in ms; read by scene-demo.html?info=1
  try {
    assets = await loadAssets(assetBase || new URL('./assets/', import.meta.url).href);
    timing.assets = performance.now() - timing.start;
    world = buildWorld({ scene, assets, players: roster, anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
  } catch (e) {   // nothing half-built stays behind
    controls.dispose(); renderer.dispose(); root.remove();
    throw e;
  }
  const { L } = world;
  const sky = createSky(scene, L.Rh + 26);
  const fx = createFx({ scene, world, overlay: root });
  const angel = createAngel(scene);   // the moderator, flying over the plaza while it speaks
  controls.maxDistance = L.Rh * 5;

  const click = name => { try { onPlayerClick?.(name); } catch (e) { console.error('[scene] onPlayerClick failed', e); } };
  let mafiaSeen = 0;
  const actors = roster.map((p, i) => {
    const a = new Actor(p, world.seats[i], assets);
    a.mafiaIndex = p.role === 'mafia' ? mafiaSeen++ : 0;
    a.label = createLabel(p);
    a.graveAnchor = new THREE.Object3D(); a.graveAnchor.position.y = 2.7; a.seat.grave.add(a.graveAnchor);
    a.anchor.add(a.label.obj);
    scene.add(a.group); world.pickables.push(a.proxy);
    return a;
  });
  const byName = new Map(actors.map(a => [a.name, a]));

  // ---- game state as the scene sees it --------------------------------------------------------
  const st = { phase: 'day', votes: [], protect: null, investigate: null, winner: null, shieldBroken: false, saved: null };
  let reveal = false, forcedTod = null, follow = false, speed = 1, night = 0, time = 0, disposed = false;
  /** True when private information may be drawn: god view, or the game is over. */
  const shown = () => reveal || !!st.winner;
  const timers = new Map(), tweens = new Map();
  const later = (key, sec, fn) => timers.set(key, { t: sec, fn });
  const tween = (key, sec, fn) => tweens.set(key, { t: 0, dur: Math.max(0.01, sec), fn });

  function target(a) {   // where a living character belongs right now
    const won = st.winner && (st.winner === 'mafia') === (a.role === 'mafia');
    if (st.winner) return { kind: 'plaza', pos: a.seat.plazaSpot, yaw: a.seat.face, base: won ? 'celebrate' : 'idle' };
    if (st.phase === 'night' && shown() && a.role === 'mafia') {
      const spots = world.alley.spots, pos = spots[a.mafiaIndex % spots.length], c = world.alley.center;
      const yaw = spots.length > 1 ? Math.atan2(c.x - pos.x, c.z - pos.z) : world.alley.angle + Math.PI;
      return { kind: 'alley', pos, yaw, base: 'idle' };
    }
    if (st.phase === 'night') return { kind: 'home', pos: a.seat.homeSpot, yaw: a.seat.face, base: 'sit' };
    return { kind: 'plaza', pos: a.seat.plazaSpot, yaw: a.seat.face, base: 'idle' };
  }
  function route(from, to) {   // along the ring road when the two points are on different spokes
    const af = Math.atan2(from.x, from.z), d = wrap(Math.atan2(to.x, to.z) - af);
    if (Math.abs(d) < 0.2 || Math.max(Math.hypot(from.x, from.z), Math.hypot(to.x, to.z)) < L.Rr) return [to];
    const pts = [], steps = Math.max(2, Math.ceil(Math.abs(d) / 0.2));
    for (let i = 0; i <= steps; i++) pts.push(polar(L.Rr, af + d * i / steps));
    pts.push(to);
    return pts;
  }
  /** mode: 'jump' places everyone, 'moved' jumps only those whose spot changed, 'walk' animates. */
  function settle(a, mode) {
    if (!a.alive) return;
    const t = target(a);
    if (mode === 'jump' || (mode === 'moved' && a.spot !== t.kind)) { a.place(t.pos, t.base, t.yaw); a.spot = t.kind; return; }
    if (a.spot === t.kind) { if (a.after) a.after.base = t.base; else if (!a.path.length) a.setBase(t.base); return; }
    a.spot = t.kind; a.walk(route(a.group.position, t.pos), t.base, t.yaw);
  }
  const buried = a => !a.alive && a.seat.grave.visible;
  function refreshLabel(a) {
    a.label.setDead(!a.alive);
    a.label.setRole(!a.alive || shown() ? a.role : null);
    const parent = buried(a) ? a.graveAnchor : a.anchor;   // the label moves to the grave with its owner
    if (a.label.obj.parent !== parent) parent.add(a.label.obj);
    a.label.setGrave(buried(a));
  }
  const votesVisible = () => st.phase === 'day' || shown();
  function arcPoint(a) { return a.dest.clone().setY((a.after?.base ?? a.baseName) === 'sit' ? 1.7 : 2.5); }
  function drawVote(v, instant) {
    const from = byName.get(v.voter), to = byName.get(v.target);
    if (!from || !to || !from.alive || !to.alive) return;
    fx.setArc(v.voter, arcPoint(from), arcPoint(to), st.phase === 'night' ? '#ff3b3b' : from.color, instant, (from.seat.i % 3) * 0.45);
  }
  function refreshVotes(bump) {
    const counts = new Map();
    if (votesVisible()) for (const v of st.votes) counts.set(v.target, (counts.get(v.target) || 0) + 1);
    for (const a of actors) a.label.setVotes(a.alive ? counts.get(a.name) || 0 : 0, st.phase === 'night', bump);
  }
  function redrawVotes() {
    fx.clearArcs();
    if (votesVisible()) for (const v of st.votes) drawVote(v, true);
    refreshVotes(false);
  }
  function refreshNight(instant) {   // the private night actions: shield, spotlight, red lantern
    const on = st.phase === 'night' && shown(), seat = name => byName.get(name)?.seat;
    fx.setShield(on && st.protect && !st.shieldBroken ? seat(st.protect.target) : null, instant);
    const inv = on && st.investigate && seat(st.investigate.detective) && seat(st.investigate.target) ? st.investigate : null;
    fx.setSpotlight(inv && seat(inv.detective), inv && seat(inv.target), inv?.is_mafia, instant);
    world.setAlleyRed(on, instant);
  }
  function savedToast() {
    if (!banners || st.saved == null) return fx.toast(null);
    if (shown()) fx.toast(`${st.saved} was saved by the doctor`, 'saved'); else fx.toast('Nobody died tonight', 'quiet');
  }
  function hush(a) { a.label.hush(); timers.delete('say:' + a.name); }
  function refreshAll(mode) {
    for (const a of actors) { settle(a, mode); refreshLabel(a); if (a.label.private && !shown()) hush(a); }
    redrawVotes(); refreshNight(mode !== 'walk'); savedToast();
    fx.banner(banners ? st.winner : null); fx.setConfetti(st.winner);
  }
  function showGrave(a, instant) {
    const g = a.seat.grave; g.visible = true;
    if (instant) { g.position.y = 0; tweens.delete('grave:' + a.name); return; }
    g.position.y = -2.6;
    tween('grave:' + a.name, 0.6 / speed, k => { g.position.y = -2.6 * (1 - k) ** 2; });
    fx.burst(g.getWorldPosition(new THREE.Vector3()).setY(0.4), [0.75, 0.62, 0.45], 4);
  }
  /** A death that is still playing is completed on the spot: character gone, grave up, house dark. */
  function finishDeaths() {
    for (const a of actors) {
      if (a.alive) continue;
      if (!a.gone) a.hide();
      a.seat.dark = 1; showGrave(a, true); refreshLabel(a);
    }
  }
  // Movement (walks, deaths) scales with the playback speed itself, so it keeps its place between the
  // events at any speed; bubbles and effects scale more gently so that they stay readable.
  const speedMul = () => speed ** 0.75;

  function say(a, text, priv) {
    const speaking = actors.filter(o => o.label.speaking && o !== a);
    speaking.sort((x, y) => y.spoke - x.spoke);   // newest first; at most three bubbles at once, one on a phone
    for (const o of speaking.splice(view.w < 560 ? 0 : 2)) hush(o);
    a.spoke = time; a.label.say(text, priv);
    for (const o of speaking) o.label.age();
    later('say:' + a.name, Math.max(0.9, clamp(1.6 + text.length * 0.05, 2.4, 6.5) / speedMul()), () => a.label.hush());
    a.rig.gesture(AGREE.test(text) ? 'agree' : 'talk', Math.min(speedMul(), 2.5));
    if (!priv) for (const o of actors) {   // the circle turns to whoever is talking
      if (!o.alive || o.spot !== 'plaza' || o.path.length) continue;
      if (o === a) o.yaw = o.seat.face; else o.face(a.dest);
    }
    if (follow) flyTo(a.dest.clone().setY(1.6), clamp(camera.position.distanceTo(controls.target), 15, 24));
  }

  function handle(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'phase':
        finishDeaths();   // nothing of the last phase carries over
        Object.assign(st, { phase: ev.phase === 'night' ? 'night' : 'day', votes: [], protect: null, investigate: null, shieldBroken: false });
        for (const a of actors) { hush(a); settle(a, 'walk'); }
        redrawVotes(); refreshNight(false);
        break;
      case 'message': {
        const a = byName.get(ev.name), priv = (ev.phase ?? st.phase) === 'night';
        if (a && a.alive && (!priv || shown())) say(a, String(ev.text ?? ''), priv);
        break;
      }
      case 'vote_open':
        st.votes = []; redrawVotes();
        for (const a of actors) hush(a);   // the talking is over
        break;
      case 'vote': {
        const v = { voter: String(ev.voter), target: String(ev.target) };
        st.votes = st.votes.filter(o => o.voter !== v.voter).concat(v);
        if (votesVisible()) {
          drawVote(v, false);
          const a = byName.get(v.voter), t = byName.get(v.target);
          if (a?.alive && t) { a.face(t.dest); a.rig.gesture('agree', Math.min(speedMul(), 2.5)); }
        }
        refreshVotes(true);
        break;
      }
      case 'investigate':
        st.investigate = { detective: String(ev.detective), target: String(ev.target), is_mafia: !!ev.is_mafia }; refreshNight(false);
        break;
      case 'protect':
        st.protect = { doctor: String(ev.doctor), target: String(ev.target) }; st.shieldBroken = false; refreshNight(false);
        break;
      case 'eliminated': {
        st.votes = []; redrawVotes();
        finishDeaths();   // an earlier death never overlaps this one
        const a = byName.get(ev.name);
        if (!a || !a.alive) break;
        a.alive = a.seat.alive = false;
        if (ROLES.includes(ev.role)) a.role = ev.role;   // the role is public from here on
        hush(a); refreshLabel(a);
        const bury = () => { showGrave(a, false); refreshLabel(a); };   // as the figure starts to fade
        if (ev.cause === 'night') {
          fx.flash(); fx.burst(a.group.position.clone().setY(1.3), [1, 0.16, 0.1], 5);
          a.die(bury);
        } else {
          a.spot = 'centre';
          a.walk(route(a.group.position, polar(2.2, a.seat.angle)), 'idle', a.seat.face, () => a.die(bury), 0.6);
        }
        break;
      }
      case 'saved':
        st.votes = []; redrawVotes();
        st.saved = String(ev.name ?? ''); st.shieldBroken = true;
        fx.breakShield(); refreshNight(false); savedToast();
        later('toast', Math.max(1.5, 4.5 / speedMul()), () => { st.saved = null; fx.toast(null); });
        break;
      case 'narration':   // public: the moderator speaks, so the angel comes down while it does
        angel.speak(clamp(String(ev.text ?? '').length * 0.06, 3, 10));
        break;
      case 'game_over':
        st.winner = ev.winner === 'mafia' ? 'mafia' : 'town'; st.votes = [];
        refreshAll('walk');
        fx.burst(new THREE.Vector3(0, 6, 0), st.winner === 'mafia' ? [1, 0.2, 0.2] : [1, 0.85, 0.35], 11);
        break;
    }
  }

  function sync(snap) {
    snap = snap && typeof snap === 'object' ? snap : {};
    timers.clear(); tweens.clear(); angel.away();
    Object.assign(st, {
      phase: snap.phase === 'night' ? 'night' : 'day',
      votes: Array.isArray(snap.votes) ? snap.votes.filter(Boolean).map(v => ({ voter: String(v.voter), target: String(v.target) })) : [],
      protect: snap.protect || null, investigate: snap.investigate || null,
      winner: snap.winner === 'mafia' || snap.winner === 'town' ? snap.winner : null, shieldBroken: false, saved: null,
    });
    for (const a of actors) {
      const p = snap.players?.[a.name];
      a.alive = a.seat.alive = !p || p.alive !== false;
      a.seat.dark = a.alive ? 0 : 1; a.seat.grave.visible = !a.alive; a.seat.grave.position.y = 0;
      a.label.hush();
      if (!a.alive) a.hide();
    }
    refreshAll('jump');
    night = nightGoal(); snapLabels = true;
  }

  // ---- lighting -------------------------------------------------------------------------------
  const nightGoal = () => (forcedTod ?? st.phase) === 'night' ? 1 : 0;
  // Drawing: scene -> bloom -> tone mapping -> FXAA. Measured on an Intel UHD 630 at 1920x1080 with ten
  // players: a 4x multisampled float target gave 29 frames a second, none gave 57, so edges are smoothed
  // by one FXAA pass instead (skipped on dense screens), and the bloom blurs at quarter resolution.
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.2, 0.6, 1), bloomSize = bloom.setSize.bind(bloom);
  bloom.setSize = (w, h) => bloomSize(w >> 1, h >> 1);
  const fxaa = new ShaderPass(FXAAShader);
  composer.addPass(new RenderPass(scene, camera)); composer.addPass(bloom); composer.addPass(new OutputPass()); composer.addPass(fxaa);
  // If frames still come slowly, the picture is drawn with fewer pixels (never the labels, which are HTML).
  const pace = { quality: 1, wait: 4, frames: 0, time: 0, slow: 0 };
  function watchPace(dt) {
    if (dt > 1) return;                                             // a pause, not a slow frame
    if (pace.wait > 0) { pace.wait -= dt; pace.frames = pace.time = 0; return; }   // start-up and resizes do not count
    pace.frames++; pace.time += dt;
    if (pace.frames < 40) return;
    pace.slow = pace.frames / pace.time < 36 ? pace.slow + 1 : 0;   // under 36 frames a second, three times running
    pace.frames = pace.time = 0;
    if (pace.slow >= 3 && pace.quality > 0.6) { pace.quality = Math.max(0.6, pace.quality * 0.8); pace.slow = 0; pace.wait = 2; resize(); }
  }

  // ---- camera ---------------------------------------------------------------------------------
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;   // then the camera does not drift on its own
  const off = new THREE.Vector3(); let fitted = false;
  const cam = { goal: null, idle: 0, moved: false };   // moved: the user or focus()/follow has taken the camera off the default view
  const homeAz = L.back + Math.PI;   // looks across the plaza at the graveyard and the alley
  function homeView() {
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    return { target: new THREE.Vector3(0, 1.4, 0), dist: Math.max((L.Rh + 9) / t * 0.7, (L.Rh - 1) / (t * camera.aspect)) };
  }
  function resetView(keepAngle) {
    const v = homeView(), el = 0.56;
    if (keepAngle) off.copy(camera.position).sub(controls.target).setLength(v.dist);
    else off.set(Math.sin(homeAz) * Math.cos(el), Math.sin(el), Math.cos(homeAz) * Math.cos(el)).multiplyScalar(v.dist);
    controls.target.copy(v.target); camera.position.copy(v.target).add(off);
    cam.goal = null; cam.moved = false;
  }
  function flyTo(target, dist) { cam.goal = { target, dist }; cam.moved = true; }
  controls.addEventListener('start', () => { cam.goal = null; cam.idle = 0; cam.moved = true; });
  controls.addEventListener('end', () => { cam.idle = 0; });

  function resize() {
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight), pr = Math.min(window.devicePixelRatio || 1, 2) * pace.quality;
    renderer.setPixelRatio(pr); renderer.setSize(w, h);
    composer.setPixelRatio(pr); composer.setSize(w, h);
    fxaa.enabled = pr < 1.5; fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    labels.setSize(w, h); view.w = w; view.h = h;
    root.classList.toggle('scn-compact', w < 560 || h < 340);   // small view: name tags only
    for (const a of actors) a.label.resized();
    camera.aspect = w / h; camera.fov = lerp(38, 56, clamp((1 - camera.aspect) / 0.5, 0, 1)); camera.updateProjectionMatrix();
    pointScale.value = h * pr / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); pointPx.value = pr;
    if (!cam.moved) resetView(fitted);   // still on the default view: refit it to the new shape
    fitted = true;
  }
  const observer = new ResizeObserver(resize); observer.observe(root);

  // ---- picking --------------------------------------------------------------------------------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), canvas = renderer.domElement;
  function pick(ev) {
    for (const a of actors) if (a.label.obj.visible && a.label.hit(ev.clientX, ev.clientY)) return a.name;   // labels lie on top of the canvas
    const r = canvas.getBoundingClientRect();
    ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
    for (const hit of ray.intersectObjects(world.pickables, false)) {
      const a = byName.get(hit.object.userData.player);
      if (!a) continue;
      if (hit.object === a.proxy ? !a.gone : !hit.object.userData.grave || a.seat.grave.visible) return a.name;
    }
    return null;
  }
  let down = null, lastHover = 0;
  const onDown = ev => { down = { x: ev.clientX, y: ev.clientY }; };
  const onUp = ev => {
    if (down && ev.button === 0 && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 6) { const name = pick(ev); if (name) click(name); }
    down = null;
  };
  const onMove = ev => {
    if (ev.buttons || ev.timeStamp - lastHover < 70) return;
    lastHover = ev.timeStamp; canvas.style.cursor = pick(ev) ? 'pointer' : 'grab';
  };
  const onDbl = () => resetView();
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove); canvas.addEventListener('dblclick', onDbl);

  // ---- frame loop -----------------------------------------------------------------------------
  const clock = new THREE.Clock();
  const dev = { manual: false };   // scene-demo.html sets manual to step time by hand
  function frame() {
    if (!root.isConnected) return dispose();   // the page removed us without calling dispose()
    // Scene time follows the wall clock even when frames are rare (slow GPU, busy page): a long gap is
    // caught up in small steps without drawing, so animations never fall behind the events.
    let dt = dev.manual ? 0 : clock.getDelta();
    if (!dev.manual) watchPace(dt);
    dt = Math.min(dt, 2);
    for (; dt > 0.1; dt -= 0.1) step(0.1, false);
    step(dt, true);
  }
  function step(dt, draw) {
    const mul = speedMul();
    time += dt;
    const goal = nightGoal();
    night = goal > night ? Math.min(goal, night + dt / 2 * Math.min(mul, 4)) : Math.max(goal, night - dt / 2 * Math.min(mul, 4));
    const k = night * night * (3 - 2 * night);
    sky.set(k);
    bloom.strength = lerp(0.1, 0.42, k); bloom.threshold = lerp(1.0, 0.82, k);
    for (const [key, t] of timers) if ((t.t -= dt) <= 0) { timers.delete(key); t.fn(); }
    for (const [key, t] of tweens) { t.t += dt; const p = Math.min(1, t.t / t.dur); t.fn(p); if (p >= 1) tweens.delete(key); }
    for (const a of actors) a.update(dt, speed, a.label.speaking);
    world.update(dt, time, k); fx.update(dt, time, mul); angel.update(dt, time, mul);
    cam.idle += dt;
    if (cam.goal) {
      const e = 1 - Math.exp(-dt * 3.2), g = cam.goal;
      off.copy(camera.position).sub(controls.target);
      const d = lerp(off.length(), g.dist, e);
      controls.target.lerp(g.target, e); camera.position.copy(controls.target).add(off.setLength(d));
      if (controls.target.distanceTo(g.target) < 0.05 && Math.abs(d - g.dist) < 0.1) cam.goal = null;
    }
    controls.autoRotate = !calm && !cam.goal && !follow && cam.idle > 6;
    controls.update(dt);
    const t = controls.target, far = Math.hypot(t.x, t.z) / (L.Rh + 30);   // panning stays near the village and above ground
    if (far > 1) { t.x /= far; t.z /= far; }
    t.y = clamp(t.y, 0.3, 12);
    if (draw) { composer.render(dt); declutter(); labels.render(scene, camera); }
  }
  /** Name tags (and bubbles) that would cover each other on screen are stacked: the nearest stays put, the ones behind move up. */
  const projected = new THREE.Vector3(), placed = [], view = { w: 1, h: 1 };
  let snapLabels = true;   // after a jump the tags take their places at once instead of sliding there
  function declutter() {
    const { w, h } = view, items = [];
    for (const a of actors) {
      a.label.obj.getWorldPosition(projected).project(camera);
      if (Math.abs(projected.z) <= 1) items.push({ label: a.label, x: (projected.x + 1) / 2 * w, y: (1 - projected.y) / 2 * h, z: projected.z });
    }
    items.sort((p, q) => p.z - q.z);
    placed.length = 0;
    for (const it of items) {
      const [lw, lh] = it.label.extent;
      let lift = 0;
      for (let pass = 0; pass < 5; pass++) {
        const hit = placed.find(p => Math.abs(p.x - it.x) < (p.w + lw) / 2 + 3 && it.y - lift > p.top && it.y - lift - lh < p.bottom);
        if (!hit) break;
        lift = it.y - hit.top + 2;
      }
      lift = Math.min(lift, 170);
      placed.push({ x: it.x, w: lw, top: it.y - lift - lh, bottom: it.y - lift });
      it.label.raise(lift, snapLabels); it.label.keepInside(it.x, w);
    }
    snapLabels = false;
  }
  /** Dev only: run the simulation forward by `seconds` in fixed steps, then draw once. */
  function advance(seconds) {
    for (let left = seconds; left > 1e-6; left -= 1 / 30) step(Math.min(1 / 30, left), false);
    snapLabels = true; step(0, true);
  }
  const onVisibility = () => {   // no work while the tab is hidden
    if (document.hidden) renderer.setAnimationLoop(null); else { clock.getDelta(); pace.wait = 2; renderer.setAnimationLoop(guard(frame)); }
  };
  document.addEventListener('visibilitychange', onVisibility);

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null); observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('dblclick', onDbl);
    controls.dispose();
    scene.traverse(o => {
      o.geometry?.dispose?.();
      for (const m of [].concat(o.material || [])) { for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose?.(); }
    });
    composer.dispose(); rt.dispose(); renderer.dispose(); root.remove();
    if (live.get(container) === api) live.delete(container);
  }

  /** Nothing may throw out of the public API or the frame loop. */
  function guard(fn) {
    return (...args) => { if (disposed) return; try { return fn(...args); } catch (e) { console.error('[scene]', e); } };
  }
  const api = {
    sync: guard(sync),
    handle: guard(handle),
    setReveal: guard(on => { reveal = !!on; refreshAll('moved'); }),
    setSkin: guard(name => { if (name === 'villagers' || name === 'robots') for (const a of actors) a.setSkin(name); }),
    setTimeOfDay: guard(mode => { forcedTod = mode === 'day' || mode === 'night' ? mode : null; }),
    setFollowSpeaker: guard(on => {
      if (follow && !on) { const v = homeView(); flyTo(v.target, v.dist); }   // back to the overview
      follow = !!on;
    }),
    setSpeed: guard(n => { speed = clamp(Number(n) || 1, 0.1, 64); }),
    focus: guard(name => {
      const a = byName.get(name);
      if (a) flyTo(buried(a) ? a.seat.grave.getWorldPosition(new THREE.Vector3()).setY(1.2) : a.dest.clone().setY(1.6), 15);
    }),
    dispose: guard(dispose),   // not in the contract; safe to ignore
  };
  live.set(container, api);
  resize(); refreshAll('jump'); night = nightGoal();
  timing.build = performance.now() - timing.start - timing.assets;
  // Shaders are compiled before the first picture, off the main thread where the browser can
  // (KHR_parallel_shader_compile), so the page stays responsive meanwhile. Both skins are included.
  try {
    const quad = new THREE.PlaneGeometry(2, 2), inner = new THREE.Scene(), last = new THREE.Scene();   // the post-processing shaders live in the passes
    for (const m of [bloom.materialHighPassFilter, ...bloom.separableBlurMaterials, bloom.compositeMaterial, bloom.blendMaterial]) if (m) inner.add(new THREE.Mesh(quad, m));
    last.add(new THREE.Mesh(quad, fxaa.material));
    renderer.setRenderTarget(rt);     // a shader is compiled for where it draws: these into a float buffer,
    const jobs = [renderer.compileAsync(scene, camera), renderer.compileAsync(inner, camera)];
    renderer.setRenderTarget(null);   // and the last pass onto the screen
    if (fxaa.enabled) jobs.push(renderer.compileAsync(last, camera));
    await Promise.all(jobs);
    quad.dispose();
  } catch (e) { /* the first frame compiles whatever is missing */ }
  renderer.setRenderTarget(null);
  timing.compile = performance.now() - timing.start - timing.assets - timing.build;
  if (disposed) return api;
  guard(frame)();
  timing.firstFrame = performance.now() - timing.start - timing.assets - timing.build - timing.compile;
  if (!document.hidden) renderer.setAnimationLoop(guard(frame));
  Object.defineProperty(api, '_dev', { value: Object.assign(dev, { camera, controls, renderer, actors, timing, pace, advance: guard(advance) }) });   // for scene-demo.html only
  return api;
}
