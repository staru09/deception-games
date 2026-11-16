// Characters. An Actor owns one rig per skin and swaps between them in place; a rig turns the
// viewer's actions (idle, walk, talk, agree, die, celebrate, sit) into that model's clips.
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { recolor, CELL, VILLAGERS } from './assets.js';

/** Viewer action -> clip name per skin. null means the skin has no clip and a code-driven motion is used. */
export const CLIPS = {
  villagers: { idle: 'Idle', walk: 'Walking_A', talk: 'Interact', agree: null, die: 'Death_A', celebrate: 'Cheer', sit: 'Sit_Floor_Idle', sitDown: 'Sit_Floor_Down' },
  robots: { idle: 'Idle', walk: 'Walking', talk: 'Wave', agree: 'Yes', die: 'Death', celebrate: 'Dance', sit: 'Sitting' },
};
const HOLD = { villagers: ['die'], robots: ['die', 'sit'] };   // play once and keep the last pose
const SKIN = { villagers: { scale: 1.25, head: 3.95, sit: 3.0 }, robots: { scale: 0.6, head: 3.45, sit: 2.75 } };
const WALK = 3.1;                                               // world units per second at 1x
const DIE = 1.15, FADE = 0.45;                                  // a death lasts DIE seconds at 1x; the figure fades over the last FADE
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

class Rig {
  constructor(gltf, skin, color, model) {
    this.skin = skin;
    this.object = cloneSkinned(gltf.scene);
    this.object.scale.setScalar(SKIN[skin].scale);
    this.mats = [];
    const made = new Map();
    this.object.traverse(m => {
      if (!m.isMesh) return;
      m.castShadow = true; m.frustumCulled = false;
      if (!made.has(m.material)) {
        // matte Lambert in place of the file's PBR material: same look here, far cheaper to compile and to light
        const src = m.material, mat = new THREE.MeshLambertMaterial({ color: src.color, map: src.map });
        if (skin === 'robots') { if (src.name === 'Main') mat.color = new THREE.Color(color); }
        else if (src.map?.image) mat.map = recolor(src.map.image, CELL.cloth[model] || [], color);
        made.set(m.material, mat); this.mats.push(mat);
      }
      m.material = made.get(m.material);
    });
    this.mixer = new THREE.AnimationMixer(this.object);
    this.actions = {};
    for (const [k, name] of Object.entries(CLIPS[skin])) {
      const clip = name && gltf.animations.find(c => c.name === name);
      if (clip) this.actions[k] = this.mixer.clipAction(clip);
    }
    this.head = this.object.getObjectByName('head') || this.object.getObjectByName('Head');
    this.headRest = this.head?.quaternion.clone();
    this.baseName = null; this.current = null; this.gestureLeft = 0; this.nod = 0; this.pending = null; this.walkRate = 1;
  }
  _play(key, { once = false, instant = false, rate = 1 } = {}) {
    const act = this.actions[key] || this.actions.idle;
    if (!act) return;
    const prev = this.current;
    if (instant) this.mixer.stopAllAction();
    act.reset(); act.enabled = true;
    act.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); act.clampWhenFinished = true;
    act.setEffectiveWeight(1); act.setEffectiveTimeScale(rate); act.play();
    if (instant) { if (once) act.time = Math.max(0, act.getClip().duration - 0.001); this.mixer.update(0); }
    else if (prev && prev !== act) act.crossFadeFrom(prev, 0.22, false);
    this.current = act; this.currentKey = key;
  }
  /** The action the character stays in: idle, walk, sit, celebrate or die. */
  base(name, instant = false) {
    if (name === this.baseName && !instant) return;
    this.baseName = name; this.gestureLeft = 0; this.nod = 0; this.pending = null;
    const hold = HOLD[this.skin].includes(name);
    if (name === 'sit' && !hold && !instant && this.actions.sitDown) {   // settle down, then loop the seated idle
      this._play('sitDown', { once: true });
      this.pending = { t: this.actions.sitDown.getClip().duration - 0.2, key: 'sit' };
    } else this._play(name, { once: hold, instant });
  }
  /** A short action on top of the base: talk or agree. */
  gesture(name, rate = 1) {
    if (this.baseName === 'walk' || this.baseName === 'die') return;
    const act = this.actions[name];
    if (!act) { this.nod = 1; this.nodRate = rate; return; }   // no clip in this skin: nod and hop instead
    if (this.baseName === 'sit' && this.skin === 'villagers') { this.nod = 1; this.nodRate = rate; return; }  // stay seated
    this._play(name, { once: true, rate });
    this.gestureLeft = act.getClip().duration / rate - 0.2;
  }
  update(dt) {
    if (this.baseName === 'walk' && this.current) this.current.setEffectiveTimeScale(this.walkRate);
    this.mixer.update(dt);
    if (this.pending && (this.pending.t -= dt) <= 0) { this._play(this.pending.key); this.pending = null; }
    if (this.gestureLeft > 0 && (this.gestureLeft -= dt) <= 0) this._play(this.baseName, { once: HOLD[this.skin].includes(this.baseName) });
    if (this.nod > 0) {
      this.nod = Math.max(0, this.nod - dt * 1.15 * this.nodRate);
      const k = 1 - this.nod, env = Math.sin(k * Math.PI);
      if (this.head) {
        if (this.currentKey !== 'idle' && this.currentKey !== 'sit') this.head.quaternion.copy(this.headRest);
        this.head.rotateX(Math.sin(k * Math.PI * 4) * 0.42 * env);
      }
      this.object.position.y = Math.abs(Math.sin(k * Math.PI * 2)) * 0.2 * env;
    } else this.object.position.y = 0;
  }
  setOpacity(k) { for (const m of this.mats) { m.transparent = k < 1; m.opacity = k; m.depthWrite = k > 0.5; } }
}

/** Stand-in when a model did not load: a capsule with a head, every action driven by code. */
class SimpleRig {
  constructor(skin, color) {
    this.skin = skin; this.object = new THREE.Group(); this.body = new THREE.Group(); this.object.add(this.body);
    const mat = new THREE.MeshLambertMaterial({ color });
    const skinMat = new THREE.MeshLambertMaterial({ color: skin === 'robots' ? 0x9aa3ad : 0xf2c9a5 });
    const torso = new THREE.Mesh(skin === 'robots' ? new THREE.BoxGeometry(1, 1.2, 0.8) : new THREE.CapsuleGeometry(0.5, 0.7, 4, 10), mat); torso.position.y = 0.95;
    const head = new THREE.Mesh(skin === 'robots' ? new THREE.BoxGeometry(0.8, 0.65, 0.7) : new THREE.SphereGeometry(0.46, 14, 10), skinMat); head.position.y = 2.05;
    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.2), mat); nose.position.set(0, 2.05, 0.46);
    for (const m of [torso, head, nose]) { m.castShadow = true; this.body.add(m); }
    this.mats = [mat, skinMat]; this.baseName = 'idle'; this.t = 0; this.g = null; this.gt = 0; this.walkRate = 1;
  }
  base(name, instant) { if (name !== this.baseName || instant) { this.baseName = name; this.t = instant ? 10 : 0; this.g = null; } }
  gesture(name, rate = 1) { if (this.baseName !== 'walk' && this.baseName !== 'die') { this.g = name; this.gt = 0; this.rate = rate; } }
  update(dt) {
    this.t += dt; const b = this.body, t = this.t; let y = 0, rx = 0, rz = 0, sy = 1;
    if (this.baseName === 'idle') sy = 1 + Math.sin(t * 2.2) * 0.02;
    else if (this.baseName === 'walk') { y = Math.abs(Math.sin(t * 9 * this.walkRate)) * 0.16; rz = Math.sin(t * 9 * this.walkRate) * 0.07; rx = 0.08; }
    else if (this.baseName === 'celebrate') { y = Math.abs(Math.sin(t * 6)) * 0.7; rz = Math.sin(t * 6) * 0.12; }
    else if (this.baseName === 'sit') sy = 1 - 0.38 * Math.min(1, t * 3);
    else if (this.baseName === 'die') { rx = -Math.PI / 2 * Math.min(1, t * 2.2) ** 2; y = 0.3 * Math.min(1, t * 2.2); }
    if (this.g) {
      this.gt += dt * 1.1 * this.rate; const k = this.gt, env = Math.sin(Math.min(1, k) * Math.PI);
      if (this.g === 'agree') rx += Math.sin(k * Math.PI * 4) * 0.3 * env; else { y += Math.abs(Math.sin(k * Math.PI * 3)) * 0.22 * env; rz += Math.sin(k * Math.PI * 4) * 0.1 * env; }
      if (k >= 1) this.g = null;
    }
    b.position.y = y; b.rotation.set(rx, 0, rz); b.scale.set(1, sy, 1);
  }
  setOpacity(k) { for (const m of this.mats) { m.transparent = k < 1; m.opacity = k; } }
}

const ringGeo = new THREE.RingGeometry(0.9, 1.16, 32).rotateX(-Math.PI / 2);
const proxyGeo = new THREE.CylinderGeometry(1.0, 1.0, 3.4, 8).translate(0, 1.7, 0);

export class Actor {
  constructor(player, seat, assets) {
    this.name = player.name; this.role = player.role; this.color = player.color; this.seat = seat;
    this.group = new THREE.Group();
    const model = assets.chars[VILLAGERS[seat.i % VILLAGERS.length]] ? VILLAGERS[seat.i % VILLAGERS.length] : VILLAGERS.find(v => assets.chars[v]);
    this.rigs = {
      villagers: model ? new Rig(assets.chars[model], 'villagers', player.color, model) : new SimpleRig('villagers', player.color),
      robots: assets.robot ? new Rig(assets.robot, 'robots', player.color) : new SimpleRig('robots', player.color),
    };
    this.skin = 'villagers';
    for (const [k, r] of Object.entries(this.rigs)) { r.object.visible = k === this.skin; this.group.add(r.object); }
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: player.color, transparent: true, opacity: 0.8, depthWrite: false }));
    this.ring.position.y = 0.05; this.group.add(this.ring);
    this.proxy = new THREE.Mesh(proxyGeo); this.proxy.visible = false; this.proxy.userData.player = player.name; this.group.add(this.proxy);
    this.anchor = new THREE.Object3D(); this.anchor.position.y = SKIN.villagers.head; this.group.add(this.anchor);   // labels hang here
    this.baseName = 'idle'; this.path = []; this.after = null; this.yaw = 0; this.spot = null;
    this.alive = true; this.gone = false; this.fade = 0; this.onFade = null; this.pace = WALK; this.pulse = 0; this.dest = this.group.position.clone();
    this.rig.base('idle', true);
  }
  get rig() { return this.rigs[this.skin]; }
  setSkin(skin) {
    if (!this.rigs[skin] || skin === this.skin) return;
    this.rig.object.visible = false; this.skin = skin; this.rig.object.visible = true;
    this.rig.base(this.baseName, true); this.rig.setOpacity(1);
  }
  setBase(name, instant) { this.baseName = name; this.rig.base(name, instant); }
  /** Jump to a spot with no animation. */
  place(pos, base, yaw) {
    this.path.length = 0; this.after = null; this.fade = 0; this.onFade = null; this.gone = false;
    this.group.visible = true; this.group.position.copy(pos); this.dest.copy(pos);
    this.yaw = yaw; this.group.rotation.y = yaw; this.ring.visible = true;
    this.rig.setOpacity(1); this.setBase(base, true);
  }
  /** Walk along points, then settle into `base` facing `yaw`. No walk takes more than `limit` seconds at 1x: a long one is hurried. */
  walk(points, base, yaw, then, limit = 2.5) {
    this.path = points.map(p => p.clone()); this.after = { base, yaw, then }; this.dest.copy(points[points.length - 1]);
    let length = 0, from = this.group.position;
    for (const p of this.path) { length += Math.hypot(p.x - from.x, p.z - from.z); from = p; }
    this.pace = Math.max(WALK, length / limit);
    this.setBase('walk');
  }
  hide() { this.path.length = 0; this.after = null; this.fade = 0; this.onFade = null; this.gone = true; this.group.visible = false; }
  /** Play the death clip where the character stands and fade out. onFade is called once, as the fade begins. */
  die(onFade) {
    this.path.length = 0; this.after = null; this.ring.visible = false;
    this.setBase('die'); this.fade = DIE; this.onFade = onFade;
  }
  face(point) { if (!this.path.length) this.yaw = Math.atan2(point.x - this.group.position.x, point.z - this.group.position.z); }
  update(dt, speed, speaking) {
    if (this.gone) return;
    this.pulse += ((speaking ? 1 : 0) - this.pulse) * (1 - Math.exp(-dt * 10));   // the ring swells while its owner talks
    this.ring.scale.setScalar(1 + this.pulse * 0.3); this.ring.material.opacity = 0.8 + this.pulse * 0.2;
    const p = this.group.position;
    if (this.path.length) {
      let left = this.pace * speed * dt;
      while (this.path.length && left > 0) {
        const t = this.path[0], dx = t.x - p.x, dz = t.z - p.z, d = Math.hypot(dx, dz);
        if (d <= left) { p.copy(t); left -= d; this.path.shift(); }
        else { p.x += dx / d * left; p.z += dz / d * left; this.yaw = Math.atan2(dx, dz); left = 0; }
      }
      this.rig.walkRate = Math.min(3, 1.5 * Math.sqrt(speed * this.pace / WALK));
      if (!this.path.length && this.after) {
        const a = this.after; this.after = null;
        this.yaw = a.yaw; this.setBase(a.base); a.then?.();
      }
    }
    this.group.rotation.y += wrap(this.yaw - this.group.rotation.y) * (1 - Math.exp(-dt * 9 * Math.min(speed, 4)));
    const s = SKIN[this.skin], sitting = this.baseName === 'sit' || this.baseName === 'die';
    this.anchor.position.y += ((sitting ? s.sit : s.head) - this.anchor.position.y) * (1 - Math.exp(-dt * 8));
    this.rig.update(dt * Math.min(speed, 2.5));
    if (this.fade > 0) {   // dying: the clip plays, then the figure fades
      this.fade -= dt * speed;
      if (this.fade <= FADE && this.onFade) { const f = this.onFade; this.onFade = null; f(); }
      this.rig.setOpacity(Math.min(1, Math.max(0, this.fade) / FADE));
      if (this.fade <= 0) this.hide();
    }
  }
}
