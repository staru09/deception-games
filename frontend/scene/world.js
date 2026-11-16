// The static village: sky and lights, ground, plaza, one house per seat, graveyard, alley, trees.
// Everything is laid out on rings around the origin, so any table size from 4 seats up works.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { recolor, emissiveMap, CELL } from './assets.js';
import { Particles } from './particles.js';
import { TAU, lerp, rng, layout } from './layout.js';

/** Point on the ground at radius r and angle a (0 = +z, growing toward +x). */
export const polar = (r, a, y = 0) => new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);

export const HS = 6.6;   // scale of the KayKit hex buildings (they are board-game miniatures)
const GRASS = '#6d9a4c';
// front = distance from the model origin to its front edge, half = half width, h = height (model units)
const HOUSE = {
  A: { model: 'building_home_A_blue', front: 0.40, half: 0.40, h: 0.93, chimney: [0, 0.95, -0.35] },
  B: { model: 'building_home_B_blue', front: 0.57, half: 0.45, h: 1.28, chimney: [0.14, 1.30, -0.42] },
};


// ---------------------------------------------------------------------------------------------
// Sky, sun/moon, fog. set(k) blends day (0) to night (1).

export function createSky(scene, reach) {
  const sunDir = polar(1, 0.75).multiplyScalar(Math.cos(0.92)).setY(Math.sin(0.92));
  const moonDir = polar(1, 3.6).multiplyScalar(Math.cos(0.72)).setY(Math.sin(0.72));
  const sky = new Sky();
  sky.scale.setScalar(5000);
  const u = sky.material.uniforms;
  u.turbidity.value = 2; u.rayleigh.value = 2.4; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.86;
  u.sunPosition.value.copy(sunDir);
  u.uDim = { value: 0.5 };   // the raw sky is too bright next to the lit scene
  sky.material.fragmentShader = 'uniform float uDim;\n' + sky.material.fragmentShader
    .replace(/gl_FragColor\s*=\s*vec4\(\s*retColor\s*,\s*1\.0\s*\)\s*;/, 'gl_FragColor = vec4( retColor * uDim, 1.0 );');
  sky.renderOrder = -3;
  scene.add(sky);

  const dome = new THREE.Mesh(new THREE.SphereGeometry(4200, 32, 16), new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uOpacity; varying vec3 vDir;
      void main() { float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(vec3(0.060, 0.105, 0.230), vec3(0.010, 0.018, 0.058), pow(h, 0.42));
        gl_FragColor = vec4(c, uOpacity); }`,
    side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
  }));
  dome.renderOrder = -2;
  scene.add(dome);

  const rand = rng(3), stars = new Particles(900, { additive: true, attenuate: false });
  for (let i = 0; i < stars.count; i++) {
    const a = rand() * TAU, y = 0.04 + rand() * 0.96, r = Math.sqrt(1 - y * y) * 3600, w = 0.7 + rand() * 0.3;
    stars.set(i, Math.sin(a) * r, y * 3600, Math.cos(a) * r, w, w, 1, 0.35 + rand() * 0.65, 1.6 + rand() * rand() * 3.2);
  }
  stars.commit(); stars.renderOrder = -1; stars.opacity = 0;
  scene.add(stars);

  const mc = document.createElement('canvas'); mc.width = mc.height = 128;
  const g = mc.getContext('2d'), halo = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  halo.addColorStop(0, 'rgba(235,242,255,1)'); halo.addColorStop(0.30, 'rgba(235,242,255,1)');
  halo.addColorStop(0.34, 'rgba(190,210,255,0.32)'); halo.addColorStop(1, 'rgba(160,190,255,0)');
  g.fillStyle = halo; g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(150,170,210,0.35)';
  for (const [x, y, r] of [[52, 54, 7], [74, 70, 5], [66, 46, 4], [58, 76, 3]]) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(mc), transparent: true, depthWrite: false, fog: false, opacity: 0 }));
  moon.material.map.colorSpace = THREE.SRGBColorSpace;
  moon.material.color.setScalar(1.5);   // above 1 so the bloom pass picks it up
  moon.position.copy(moonDir).multiplyScalar(3300); moon.scale.setScalar(620); moon.renderOrder = -1;
  scene.add(moon);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 20, far: 320 });
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.05;
  scene.add(hemi, sun, sun.target);
  scene.fog = new THREE.FogExp2(0xffffff, 0.004);

  const C = hex => new THREE.Color(hex);
  const day = { sky: C(0xdfeeff), ground: C(0x8a9a66), hemi: 1.15, sun: C(0xfff0d6), sunI: 3.1, fog: C(0xc4d9ec), fogD: 0.0030 };
  const night = { sky: C(0x6f86d6), ground: C(0x232a44), hemi: 1.1, sun: C(0xa8c0ff), sunI: 1.4, fog: new THREE.Color().setRGB(0.050, 0.088, 0.195), fogD: 0.0075 };
  const dir = new THREE.Vector3(), sunset = C(0xff9a52), low = polar(1, 0.75).setY(0.03);
  return {
    sun, hemi,
    set(k) {
      hemi.color.lerpColors(day.sky, night.sky, k); hemi.groundColor.lerpColors(day.ground, night.ground, k);
      hemi.intensity = lerp(day.hemi, night.hemi, k);
      // the light swings from sun to moon, so it dims in the middle of the blend
      const dusk = Math.sin(k * Math.PI);   // 0 by day and by night, 1 halfway: a short sunset
      sun.color.lerpColors(day.sun, night.sun, k).lerp(sunset, dusk * 0.6);
      u.sunPosition.value.copy(low).lerp(sunDir, 1 - Math.min(1, k * 1.6)).normalize();
      sun.intensity = lerp(day.sunI, night.sunI, k) * (1 - 0.55 * Math.sin(k * Math.PI));
      dir.lerpVectors(sunDir, moonDir, k).normalize();
      sun.position.copy(dir).multiplyScalar(160);
      scene.fog.color.lerpColors(day.fog, night.fog, k); scene.fog.density = lerp(day.fogD, night.fogD, k);
      dome.material.uniforms.uOpacity.value = k; dome.visible = k > 0.001;
      stars.opacity = k * k; moon.material.opacity = k * k; moon.visible = k > 0.02;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Ground texture: grass, dirt paths to every house, cobbled plaza. Painted once on a canvas.

function paintGround(size, GS, L, seats, yard, alley) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), k = size / GS, rand = rng(11);
  const X = x => (x + GS / 2) * k, Z = z => (z + GS / 2) * k;
  g.fillStyle = GRASS; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    g.fillStyle = rand() < 0.5 ? 'rgba(46,92,38,0.07)' : 'rgba(176,204,98,0.07)';
    g.beginPath(); g.arc(rand() * size, rand() * size, (0.6 + rand() * 3.2) * k, 0, TAU); g.fill();
  }
  g.lineWidth = Math.max(1, k * 0.07);
  for (let i = 0; i < 9000; i++) {
    const x = rand() * size, y = rand() * size;
    g.strokeStyle = rand() < 0.5 ? 'rgba(40,86,34,0.33)' : 'rgba(158,196,92,0.33)';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * k * 0.3, y - k * 0.3); g.stroke();
  }
  const local = (o, w, d, fill) => {   // rounded patch in the frame of a group
    g.save(); g.translate(X(o.position.x), Z(o.position.z)); g.rotate(-o.rotation.y);
    g.fillStyle = fill; g.beginPath(); g.roundRect(-w / 2 * k, -d / 2 * k, w * k, d * k, 1.6 * k); g.fill(); g.restore();
  };
  const path = (pts, w) => {
    for (const [ww, col] of [[w + 1.1, 'rgba(110,98,60,0.30)'], [w, '#b59c6c'], [w * 0.55, 'rgba(206,184,132,0.55)']]) {
      g.strokeStyle = col; g.lineWidth = ww * k; g.lineCap = g.lineJoin = 'round';
      g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(X(p.x), Z(p.z)) : g.moveTo(X(p.x), Z(p.z))); g.stroke();
    }
  };
  local(yard.group, yard.w + 3, yard.d + 3, 'rgba(84,96,72,0.55)');
  local(alley.group, 9, 13, 'rgba(150,128,90,0.75)');
  const ring = []; for (let i = 0; i <= 72; i++) ring.push(polar(L.Rr, i / 72 * TAU));
  path(ring, 2.2);
  for (const s of seats) path([polar(L.Rplaza - 1, s.angle), polar(L.Rh - s.spec.front * HS + 0.4, s.angle)], 2.3);
  path([polar(L.Rr, yard.angle), polar(yard.radius - yard.d / 2 - 0.5, yard.angle)], 2.6);
  path([polar(L.Rr, alley.angle), polar(alley.radius + 3, alley.angle)], 2.6);
  for (const s of seats) {   // trodden patch where each villager sits
    g.fillStyle = 'rgba(181,156,108,0.5)'; g.beginPath(); g.arc(X(s.homeSpot.x), Z(s.homeSpot.z), 1.3 * k, 0, TAU); g.fill();
  }
  // plaza: concentric rings of cobbles
  const cx = X(0), cz = Z(0);
  g.fillStyle = 'rgba(96,88,72,0.35)'; g.beginPath(); g.arc(cx, cz, (L.Rplaza + 0.5) * k, 0, TAU); g.fill();
  g.fillStyle = '#7b756b'; g.beginPath(); g.arc(cx, cz, L.Rplaza * k, 0, TAU); g.fill();
  const rw = 0.66;
  for (let r = rw * 0.75; r < L.Rplaza - 0.1; r += rw) {
    const outer = r + rw > L.Rplaza - 0.1, count = Math.max(6, Math.round(TAU * r / (outer ? 1.25 : 0.86))), off = rand() * TAU;
    g.lineWidth = rw * 0.84 * k; g.lineCap = 'butt';
    for (let i = 0; i < count; i++) {
      const v = Math.round((outer ? 132 : 150) + rand() * 34), a = off + i / count * TAU, gap = 0.055 / r;
      g.strokeStyle = `rgb(${v + 6},${v},${v - 9})`;
      g.beginPath(); g.arc(cx, cz, r * k, a + gap, a + TAU / count - gap); g.stroke();
    }
  }
  g.fillStyle = 'rgba(40,32,24,0.42)'; g.beginPath(); g.arc(cx, cz, 1.5 * k, 0, TAU); g.fill();   // scorched earth under the fire
  // fade to plain grass at the border so the texture meets the flat outer ground without a seam
  const fade = g.createRadialGradient(cx, cz, size * 0.40, cx, cz, size * 0.5);
  fade.addColorStop(0, 'rgba(109,154,76,0)'); fade.addColorStop(1, GRASS);
  g.fillStyle = fade; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)'); grad.addColorStop(0.35, 'rgba(255,255,255,0.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function signTexture(name, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 80;
  const g = c.getContext('2d');
  g.fillStyle = '#ead9b4'; g.fillRect(0, 0, 256, 80);
  g.fillStyle = color; g.fillRect(0, 0, 256, 12);
  g.strokeStyle = '#6b4a2b'; g.lineWidth = 6; g.strokeRect(3, 3, 250, 74);
  g.fillStyle = '#3b2a1a'; g.textAlign = 'center'; g.textBaseline = 'middle';
  let px = 40; do { g.font = `700 ${px}px Inter, system-ui, sans-serif`; px -= 2; } while (g.measureText(name).width > 226 && px > 12);
  g.fillText(name, 128, 46);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ---------------------------------------------------------------------------------------------

export function buildWorld({ scene, assets, players, anisotropy }) {
  const n = players.length, L = layout(n), rand = rng(40 + n);
  const root = new THREE.Group(); scene.add(root);
  const matV = assets.mat.village, atlasV = assets.atlas.village;
  const flat = color => new THREE.MeshLambertMaterial({ color, flatShading: true });
  const wood = flat(0x7a5536), stone = flat(0x8f8e8a), dark = flat(0x3a3530), earth = flat(0x5a4634);
  const winMap = atlasV && emissiveMap(CELL.windows);
  const deadMap = atlasV && recolor(atlasV, CELL.roof, '#6b6e78');   // a dead player's house: grey roof, dim walls, no light
  const decorMat = atlasV && new THREE.MeshLambertMaterial({ map: recolor(atlasV, CELL.roof, '#b9573d'), emissiveMap: winMap, emissive: 0xffffff, emissiveIntensity: 0 });
  const matG = assets.mat.graveyard && Object.assign(assets.mat.graveyard.clone(), { emissiveMap: emissiveMap(CELL.lanternGlass, '#ffb869'), emissive: new THREE.Color(0xffffff), emissiveIntensity: 0 });
  const glow = glowTexture();
  const poolMat = new THREE.MeshBasicMaterial({ map: glow, color: 0xffb264, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const pickables = [], zones = [], lamps = [];
  const put = (name, mat, pos, ry = 0, s = 1, parent = root) => {
    const o = assets.spawn(name, mat);
    if (!o) return null;
    o.position.copy(pos); o.rotation.y = ry; o.scale.setScalar(s); parent.add(o);
    return o;
  };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const pool = (pos, size, parent = root) => {
    const m = new THREE.Mesh(poolGeo, poolMat); m.position.set(pos.x, 0.06, pos.z); m.scale.setScalar(size); m.renderOrder = 1; parent.add(m);
    return m;
  };
  /** A lantern post with its own glass material and a point light; all `lamps` come on at night. */
  const lamp = (pos, ry, parent = root) => {
    const glass = matG && matG.clone();
    const o = put('post_lantern', matG, pos, ry, 1.15, parent) || fallbackPost(pos, ry, parent, wood);
    o.traverse(m => { if (m.isMesh && /lantern_lantern/.test(m.name) && glass) m.material = glass; });
    const light = new THREE.PointLight(0xffb060, 0, 22, 1.7);
    light.position.set(0, 2.6, 1.25); o.add(light);
    const p = pool(V(0, 0, 1.25), 9, o); p.material = poolMat.clone();
    const entry = { glass, light, pool: p, color: new THREE.Color(0xffb060) };
    lamps.push(entry);
    return entry;
  };

  // ---- seats: one house each -----------------------------------------------------------------
  const seats = players.map((p, i) => {
    const angle = L.seatAngle(i), spec = HOUSE[i % 3 === 1 ? 'B' : 'A'];
    const group = new THREE.Group();
    group.position.copy(polar(L.Rh, angle)); group.rotation.y = angle + Math.PI; root.add(group);
    let mat, body, roofMat = null;
    if (assets.models[spec.model] && atlasV) {
      mat = new THREE.MeshLambertMaterial({ map: recolor(atlasV, CELL.roof, p.color), emissiveMap: winMap, emissive: 0xffffff, emissiveIntensity: 0 });
      body = assets.spawn(spec.model, mat); body.scale.setScalar(HS);
    } else {
      mat = flat(0xd9cdb8); roofMat = flat(p.color); body = fallbackHouse(mat, roofMat, spec);
    }
    group.add(body);
    const front = spec.front * HS, half = spec.half * HS, h = spec.h * HS;
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(half * 2, h, half * 2));
    proxy.position.y = h / 2; proxy.visible = false; proxy.userData.player = p.name; group.add(proxy); pickables.push(proxy);
    // name sign beside the path
    const sign = new THREE.Group(); sign.position.set(-2.5, 0, front + 1.3); sign.rotation.y = 0.18; group.add(sign);
    const post = new THREE.Mesh(signGeo.post, wood); post.position.y = 1.0; post.castShadow = true;
    const board = new THREE.Mesh(signGeo.board, wood); board.position.y = 1.72; board.castShadow = true;
    const face = new THREE.Mesh(signGeo.face, new THREE.MeshLambertMaterial({ map: signTexture(p.name, p.color) }));
    face.position.set(0, 1.72, 0.07);
    sign.add(post, board, face);
    // a prop or two by the wall
    const props = [['barrel', 'crate_B_small'], ['resource_lumber'], ['sack', 'bucket_water'], ['wheelbarrow'], ['crate_A_big', 'barrel']][i % 5];
    props.forEach((name, j) => put(name, matV, V(half + 0.9 + j * 0.25, 0, front * 0.3 + j * 1.25), 0.4 + i + j, 4.6, group));
    const lightPool = pool(V(1.2, 0, front + 2.2), 10, group);
    group.updateMatrixWorld(true);
    const world = v => group.localToWorld(v);
    return {
      i, name: p.name, angle, spec, group, mat, liveMap: mat.map, roofMat, roofColor: new THREE.Color(p.color), alive: true, dark: 0, lightPool,
      homeSpot: world(V(1.5, 0, front + 2.9)), plazaSpot: polar(L.Rp, angle), face: angle + Math.PI,
      smoke: world(V(spec.chimney[0] * HS, spec.chimney[1] * HS, spec.chimney[2] * HS)),
      roof: world(V(0, h + 0.4, 0)), top: h,
    };
  });

  // ---- plaza: campfire in the middle, well, benches, lantern posts -----------------------------
  const fire = new THREE.Group(); root.add(fire);
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(fireGeo.stone, stone); s.position.copy(polar(1.02, i / 9 * TAU, 0.14)); s.rotation.set(i, i * 2, i * 3); s.scale.setScalar(0.8 + (i % 3) * 0.18); s.castShadow = true; fire.add(s);
  }
  for (let i = 0; i < 5; i++) {
    const l = new THREE.Mesh(fireGeo.log, i % 2 ? wood : dark); l.position.copy(polar(0.3, i / 5 * TAU, 0.34)); l.rotation.set(0, -i / 5 * TAU, 1.02, 'YXZ'); l.castShadow = true; fire.add(l);
  }
  // a low-poly fire: one tall yellow tongue with shorter orange and red ones around it
  const flames = [[0xffd75e, 0, 0, 0.34, 1.9], [0xff9a2a, 0.3, 0.4, 0.36, 1.35], [0xff6a1a, 0.32, 2.5, 0.38, 1.15], [0xff8420, 0.3, 4.6, 0.34, 1.25], [0xff4a12, 0.42, 5.6, 0.3, 0.85]].map(([c, r, a, w, h]) => {
    const m = new THREE.Mesh(fireGeo.flame, new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.6), fog: false }));
    m.position.copy(polar(r, a, 0.3)); m.userData.s = [w, h]; fire.add(m);
    return m;
  });
  const fireLight = new THREE.PointLight(0xff8a3c, 10, 30, 1.6); fireLight.position.y = 1.6; fire.add(fireLight);
  const firePool = pool(V(0, 0, 0), 13); firePool.material = poolMat.clone(); firePool.material.color.set(0xff8a3c);
  const embers = new Particles(16, { additive: true }); root.add(embers);

  const { gaps } = L;
  put('building_well_blue', decorMat, polar(L.Rplaza - 1.7, L.millAngle - L.step * 0.18), L.millAngle + Math.PI, 3.3);
  [0, 1, 2, 3].map(j => Math.round(j * n / 4) % Math.max(1, n)).filter((g, j, arr) => arr.indexOf(g) === j).forEach(g => {
    const a = L.gapAngle(g) + L.step * 0.24;
    lamp(polar(L.Rplaza + 0.5, a), a + Math.PI);
  });
  [gaps.market, gaps.grave].forEach(g => {
    if (g === undefined) return;
    const a = L.gapAngle(g) - L.step * 0.26;
    put('bench', matG, polar(L.Rplaza - 0.9, a), a + Math.PI, 1);
  });

  // ---- graveyard: fenced plot with one slot per seat, church beside it ------------------------
  const cols = Math.max(1, Math.min(n, n > 10 ? Math.ceil(n / 3) : 5)), rows = Math.max(1, Math.ceil(n / cols));
  const yard = { angle: L.graveAngle, w: cols * 2.7 + 1.8, d: rows * 3.3 + 2.4, group: new THREE.Group() };
  yard.radius = L.Rh + 9 + yard.d / 2;
  yard.group.position.copy(polar(yard.radius, yard.angle)); yard.group.rotation.y = yard.angle + Math.PI; root.add(yard.group);
  zones.push({ p: yard.group.position, r: Math.max(yard.w, yard.d) / 2 + 3 });
  {
    const hw = yard.w / 2, hd = yard.d / 2, G = yard.group;
    const run = (ax, az, bx, bz) => {   // a row of iron fence panels (each 4 long) from a to b
      const len = Math.hypot(bx - ax, bz - az), count = Math.max(1, Math.round(len / 4)), ry = Math.atan2(-(bz - az), bx - ax);
      for (let i = 0; i < count; i++) {
        const t = (i + 0.5) / count, f = put('fence', matG, V(lerp(ax, bx, t), 0, lerp(az, bz, t)), ry, 1, G);
        if (f) f.scale.set(len / count / 4, 0.8, 1);
      }
    };
    run(-hw, -hd, hw, -hd); run(-hw, -hd, -hw, hd); run(hw, -hd, hw, hd);
    run(-hw, hd, -2.3, hd); run(2.3, hd, hw, hd);
    for (const [x, z] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) put('fence_pillar', matG, V(x, 0, z), 0, 1, G);
    put('arch', matG, V(0, 0, hd), 0, 1, G);
    put('lantern_standing', matG, V(-3.1, 0, hd + 0.9), 0, 1.1, G); put('lantern_standing', matG, V(3.1, 0, hd + 0.9), 0, 1.1, G);
    put('tree_dead_large', matG, V(hw + 1.6, 0, -hd - 1.2), 0.6, 1.25, G); put('tree_dead_medium', matG, V(hw + 1.4, 0, hd - 1.5), 2.1, 1.3, G);
    const church = put('building_church_blue', decorMat, V(-hw - 7.5, 0, -1.5), 0, 7, G);
    if (church) { G.updateMatrixWorld(true); zones.push({ p: church.getWorldPosition(V(0, 0, 0)), r: 7.5 }); }
    const kinds = ['grave_A', 'gravestone', 'grave_B', 'gravemarker_A', 'gravemarker_B'], size = [0.72, 0.95, 0.72, 1.25, 1.25];
    seats.forEach(s => {
      const j = s.i, g = new THREE.Group();
      g.position.set((j % cols - (cols - 1) / 2) * 2.7, 0, (Math.floor(j / cols) - (rows - 1) / 2) * 3.3 - 0.4); G.add(g);
      if (!put(kinds[j % 5], matG, V(0, 0, 0), 0, size[j % 5], g)) fallbackGrave(g, stone);
      const mound = new THREE.Mesh(graveGeo.mound, earth); mound.position.set(0, 0, 1.15); mound.scale.set(0.62, 0.2, 0.95); mound.receiveShadow = true; g.add(mound);
      const proxy = new THREE.Mesh(graveGeo.proxy); proxy.position.y = 0.9; proxy.visible = false; proxy.userData.player = s.name; proxy.userData.grave = true; g.add(proxy); pickables.push(proxy);
      g.visible = false;
      s.grave = g;
    });
  }

  // ---- alley: tavern and smithy with a narrow lane between them, where the mafia meet ---------
  const alley = { angle: L.alleyAngle, radius: L.Rh + 13, group: new THREE.Group() };
  alley.group.position.copy(polar(alley.radius, alley.angle)); alley.group.rotation.y = alley.angle + Math.PI; root.add(alley.group);
  zones.push({ p: alley.group.position, r: 13 });
  put('building_tavern_blue', decorMat, V(-7.4, 0, -0.5), Math.PI / 2, 7, alley.group);
  put('building_blacksmith_blue', decorMat, V(7.6, 0, 0), -Math.PI / 2, 7, alley.group);
  [['barrel', -2.3, -2.6, 5], ['barrel', -2.5, -1.4, 4.4], ['crate_A_big', 2.4, -3.2, 5], ['crate_B_small', 2.5, -1.9, 5], ['sack', -2.4, 2.6, 5], ['crate_A_big', 2.5, 3.4, 4.6]]
    .forEach(([name, x, z, s], j) => put(name, matV, V(x, 0, z), j * 1.3, s, alley.group));
  alley.lamp = lamp(V(-2.3, 0, 5.2), Math.PI / 2, alley.group);
  alley.group.updateMatrixWorld(true);
  const mafia = Math.max(1, players.filter(p => p.role === 'mafia').length);
  alley.center = alley.group.localToWorld(V(0, 0, 0.6));
  alley.spots = [...Array(mafia)].map((_, j) => mafia === 1 ? alley.center.clone()
    : alley.group.localToWorld(V(Math.sin(j / mafia * TAU + 0.35) * 1.5, 0, 0.6 + Math.cos(j / mafia * TAU + 0.35) * 2.3)));

  // ---- windmill with a field, market stalls ---------------------------------------------------
  let fan = null;
  {
    const a = L.millAngle, p = polar(L.Rh + 15, a);
    const mill = put('building_windmill_blue', decorMat, p, a + Math.PI, 9);
    mill?.traverse(o => { if (/fan/.test(o.name)) fan = o; });
    zones.push({ p, r: 9 });
    const f = polar(L.Rh + 29, a);
    put('building_grain', matV, f, a, 6.5); zones.push({ p: f, r: 8 });
    if (gaps.market !== undefined) {
      const am = L.gapAngle(gaps.market), pm = polar(L.Rh + 9.5, am);
      put('building_market_blue', decorMat, pm, am + Math.PI, 5.2); zones.push({ p: pm, r: 7 });
    }
  }

  // ---- fences between neighbouring houses (the graveyard and alley gaps stay open) ------------
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = V(0, 1, 0), sc = V(1, 1, 1);
  const instanced = (geo, material, list, shadow = true) => {
    if (!geo || !material || !list.length) return null;
    const im = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((m, i) => im.setMatrixAt(i, m));
    im.castShadow = shadow; im.receiveShadow = shadow; im.computeBoundingSphere(); root.add(im);
    return im;
  };
  const fences = [];
  seats.forEach((s, i) => {
    if (i === gaps.grave || i === gaps.alley) return;
    const t = seats[(i + 1) % n];
    const side = (seat, sign) => seat.group.localToWorld(V(sign * (seat.spec.half * HS + 0.7), 0, -0.6));
    const A = side(s, -1), B = side(t, 1), len = A.distanceTo(B), count = Math.floor(len / 3.2), pad = (len - count * 3.2) / 2;
    for (let j = 0; j < count; j++) {
      const p = A.clone().lerp(B, (pad + (j + 0.5) * 3.2) / len);
      fences.push(m4.compose(p, q.setFromAxisAngle(up, Math.atan2(B.x - A.x, B.z - A.z)), sc.setScalar(2.65)).clone());
    }
  });
  instanced(assets.geometry('fence_wood_straight'), matV, fences);

  // ---- trees, rocks, far hills, clouds --------------------------------------------------------
  seats.forEach(s => zones.push({ p: s.group.position, r: 6.5 }));
  const free = (p, r) => zones.every(z => Math.hypot(z.p.x - p.x, z.p.z - p.z) > z.r + r);
  const scatter = (count, rmin, rmax, r) => {
    const out = [];
    for (let tries = 0; out.length < count && tries < count * 30; tries++) {
      const p = polar(lerp(rmin, rmax, Math.sqrt(rand())), rand() * TAU);
      if (free(p, r) && out.every(o => o.distanceTo(p) > r * 1.6)) out.push(p);
    }
    return out;
  };
  const place = (name, pts, smin, smax, shadow = true) => instanced(assets.geometry(name), matV,
    pts.map(p => m4.compose(p, q.setFromAxisAngle(up, rand() * TAU), sc.setScalar(lerp(smin, smax, rand()))).clone()), shadow);
  const near = scatter(30 + n * 2, L.Rh + 6, L.Rh + 30, 2.6), mid = scatter(22, L.Rh + 16, L.Rh + 52, 6);
  if (!assets.geometry('tree_single_A')) instanced(new THREE.ConeGeometry(0.34, 1.15, 7).translate(0, 0.62, 0), flat(0x3f7f3a), near.map(p => m4.compose(p, q.identity(), sc.setScalar(lerp(5.2, 7.6, rand()))).clone()));
  place('tree_single_A', near.filter((_, i) => i % 2 === 0), 5.2, 7.6);
  place('tree_single_B', near.filter((_, i) => i % 2 === 1), 5.2, 7.6);
  ['trees_A_medium', 'trees_B_medium', 'trees_B_large'].forEach((name, k) => place(name, mid.filter((_, i) => i % 3 === k), 6, 8));
  const rocks = scatter(18, L.Rr + 2.5, L.Rh + 40, 2);
  ['rock_single_B', 'rock_single_D', 'rock_single_E'].forEach((name, k) => place(name, rocks.filter((_, i) => i % 3 === k), 4, 8));
  // rolling hills on the horizon: squashed low-poly blobs that the fog turns into layered silhouettes
  const hills = [];
  for (const [count, r0, r1, h0, h1] of [[16, 210, 270, 16, 30], [14, 340, 430, 40, 78]]) {
    for (let i = 0; i < count; i++) {
      const w = lerp(55, 110, rand()), p = polar(lerp(r0, r1, rand()), (i + rand() * 0.8) / count * TAU, -4);
      hills.push(m4.compose(p, q.setFromAxisAngle(up, rand() * TAU), sc.set(w, lerp(h0, h1, rand()), w * lerp(0.6, 1, rand()))).clone());
    }
  }
  instanced(new THREE.IcosahedronGeometry(1, 2), flat(0x4f7f43), hills, false);
  const clouds = new THREE.Group(); root.add(clouds);
  const cloudMat = matV && Object.assign(matV.clone(), { fog: false, emissive: new THREE.Color(0xdfe9f7), emissiveIntensity: 0.5 });
  for (let i = 0; i < 9; i++) {
    const c = assets.spawn(i % 3 ? 'cloud_small' : 'cloud_big', cloudMat, false);
    if (!c) break;
    c.position.copy(polar(130 + rand() * 150, i / 9 * TAU + rand() * 0.4, 75 + rand() * 45)); c.rotation.y = rand() * TAU; c.scale.setScalar(15 + rand() * 12);
    c.traverse(m => { m.receiveShadow = false; }); clouds.add(c);
  }

  // ---- ground ---------------------------------------------------------------------------------
  const GS = (L.Rh + 40) * 2;
  const groundTex = paintGround(2048, GS, L, seats, yard, alley);
  groundTex.anisotropy = anisotropy;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GS, GS).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: groundTex }));
  ground.receiveShadow = true;
  const outer = new THREE.Mesh(new THREE.CircleGeometry(900, 48).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: GRASS }));
  outer.position.y = -0.05;
  root.add(ground, outer);

  // ---- small moving things --------------------------------------------------------------------
  const smoke = new Particles(n * 5); root.add(smoke);
  const flies = new Particles(48, { additive: true }); root.add(flies);
  const flyBase = [...Array(flies.count)].map(() => ({ p: polar(lerp(L.Rplaza, L.Rh + 18, rand()), rand() * TAU, 0.7 + rand() * 2.6), ph: rand() * 40 }));
  let alleyRed = false, redK = 0;
  const warm = new THREE.Color(0xffb060), red = new THREE.Color(0xff2a1e), deadRoof = new THREE.Color(0x4a4d55);

  return {
    L, seats, alley, pickables,
    setAlleyRed(on, instant) { alleyRed = on; if (instant) redK = on ? 1 : 0; },
    /** dt seconds, t absolute seconds, night 0..1 */
    update(dt, t, night) {
      const ease = 1 - Math.exp(-dt * 5);
      for (const s of seats) {
        s.dark += ((s.alive ? 0 : 1) - s.dark) * ease;
        const map = s.liveMap && (s.dark > 0.5 ? deadMap : s.liveMap);
        if (map && s.mat.map !== map) s.mat.map = map;
        s.mat.color.setRGB(lerp(1, 0.56, s.dark), lerp(1, 0.57, s.dark), lerp(1, 0.64, s.dark));
        if (s.roofMat) s.roofMat.color.copy(s.roofColor).lerp(deadRoof, s.dark);
        s.mat.emissiveIntensity = night * 2.4 * (1 - s.dark);
        s.lightPool.visible = s.dark < 0.5;
      }
      if (decorMat) decorMat.emissiveIntensity = night * 1.7;
      if (matG) matG.emissiveIntensity = night * 2.2;
      poolMat.opacity = night * 0.42;
      redK += ((alleyRed ? 1 : 0) - redK) * ease;
      for (const l of lamps) {
        const k = l === alley.lamp ? redK : 0;
        l.color.lerpColors(warm, red, k);
        l.light.color.copy(l.color); l.light.intensity = night * lerp(26, 60, k) * (0.94 + 0.06 * Math.sin(t * 9 + l.light.id));
        l.pool.material.color.copy(l.color); l.pool.material.opacity = night * lerp(0.5, 0.62, k);
        if (l.glass) { l.glass.emissive.setRGB(1, lerp(1, 0.16, k), lerp(1, 0.1, k)); l.glass.emissiveIntensity = night * lerp(2.6, 5, k); }
      }
      const flick = 0.82 + 0.18 * Math.sin(t * 11) * Math.sin(t * 7.3) + 0.06 * Math.sin(t * 23);
      fireLight.intensity = lerp(9, 42, night) * flick;
      firePool.material.opacity = lerp(0.1, 0.6, night) * flick;
      flames.forEach((f, i) => { const [w, h] = f.userData.s, k = 1 + 0.2 * Math.sin(t * (8 + i * 2.7) + i * 2); f.scale.set(w * (2 - k), h * k, w * (2 - k)); f.rotation.set(Math.sin(t * 5 + i) * 0.12, t * (1.5 + i), Math.cos(t * 4.3 + i) * 0.12); });
      for (let i = 0; i < embers.count; i++) {
        const a = (t * 0.45 + i / embers.count * 7.3) % 1, sw = i * 2.4;
        embers.set(i, Math.sin(sw + a * 5) * 0.35 * (0.4 + a), 0.6 + a * 3.4, Math.cos(sw * 1.7 + a * 4) * 0.35 * (0.4 + a), 1, 0.55, 0.15, (1 - a) * 0.9, 0.16);
      }
      embers.commit();
      const grey = lerp(0.92, 0.42, night);
      seats.forEach((s, si) => {
        for (let j = 0; j < 5; j++) {
          const a = (t * 0.17 + j / 5 + si * 0.37) % 1;
          smoke.set(si * 5 + j, s.smoke.x + a * 1.5 + Math.sin(a * 6 + si) * 0.25, s.smoke.y + a * 4.6, s.smoke.z + a * 0.6, grey, grey, grey, Math.sin(a * Math.PI) * 0.26 * (1 - s.dark), 0.7 + a * 1.7);
        }
      });
      smoke.commit();
      flies.opacity = night;
      if (night > 0.003) {
        flyBase.forEach((f, i) => flies.set(i, f.p.x + Math.sin(t * 0.5 + f.ph) * 1.6, f.p.y + Math.sin(t * 0.9 + f.ph * 2) * 0.5, f.p.z + Math.cos(t * 0.4 + f.ph) * 1.6, 0.85, 1, 0.45, 0.35 + 0.65 * Math.max(0, Math.sin(t * 1.6 + f.ph)), 0.3));
        flies.commit();
      }
      if (fan) fan.rotation.z += dt * 0.5;
      clouds.rotation.y += dt * 0.004;
      if (cloudMat) cloudMat.emissiveIntensity = lerp(0.5, 0.05, night);
    },
  };
}

const signGeo = { post: new THREE.CylinderGeometry(0.09, 0.12, 2.0, 6), board: new THREE.BoxGeometry(2.0, 0.66, 0.12), face: new THREE.PlaneGeometry(1.88, 0.58) };
const fireGeo = { stone: new THREE.DodecahedronGeometry(0.3, 0), log: new THREE.CylinderGeometry(0.12, 0.14, 1.5, 6), flame: new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0) };
const graveGeo = { mound: new THREE.SphereGeometry(1, 10, 6), proxy: new THREE.BoxGeometry(2, 1.8, 2.6), slab: new THREE.BoxGeometry(1.1, 1.5, 0.3) };

// ---- simple stand-ins used when a model did not load ----------------------------------------
function fallbackHouse(wall, roof, spec) {
  const g = new THREE.Group(), w = spec.half * 2 * HS * 0.86, h = spec.h * HS * 0.55;
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), wall); box.position.y = h / 2;
  const top = new THREE.Mesh(new THREE.ConeGeometry(w * 0.82, spec.h * HS * 0.45, 4), roof); top.position.y = h + spec.h * HS * 0.225; top.rotation.y = Math.PI / 4;
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.3, 0.2), new THREE.MeshLambertMaterial({ color: 0x5b3b22 })); door.position.set(0, 1.15, w / 2);
  for (const m of [box, top, door]) { m.castShadow = m.receiveShadow = true; g.add(m); }
  return g;
}
function fallbackGrave(parent, material) {
  const m = new THREE.Mesh(graveGeo.slab, material); m.position.y = 0.75; m.castShadow = true; parent.add(m);
  return m;
}
function fallbackPost(pos, ry, parent, material) {
  const g = new THREE.Group(); g.position.copy(pos); g.rotation.y = ry; parent.add(g);
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 3.4, 6), material); p.position.y = 1.7; p.castShadow = true;
  const l = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.4), new THREE.MeshBasicMaterial({ color: 0xffc27a })); l.position.set(0, 2.7, 1.1);
  g.add(p, l);
  return g;
}
