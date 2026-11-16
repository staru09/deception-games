// Asset loading for the village. Every model is optional: a failed load leaves a hole that the
// callers fill with simple geometry, so the scene always comes up.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// KayKit Medieval Hexagon Pack (village/) and KayKit Halloween Bits (graveyard/). See assets/LICENSES.md.
const VILLAGE = ['building_home_A_blue', 'building_home_B_blue', 'building_tavern_blue', 'building_church_blue',
  'building_windmill_blue', 'building_blacksmith_blue', 'building_market_blue', 'building_well_blue',
  'fence_wood_straight', 'building_grain', 'tree_single_A', 'tree_single_B', 'trees_A_medium', 'trees_B_medium',
  'trees_B_large', 'rock_single_B', 'rock_single_D', 'rock_single_E', 'cloud_big', 'cloud_small', 'barrel', 'crate_A_big', 'crate_B_small', 'sack', 'bucket_water',
  'wheelbarrow', 'resource_lumber'];
const GRAVEYARD = ['grave_A', 'grave_B', 'gravestone', 'gravemarker_A', 'gravemarker_B', 'fence', 'fence_pillar',
  'arch', 'post_lantern', 'lantern_standing', 'tree_dead_large', 'tree_dead_medium', 'bench'];
export const VILLAGERS = ['Knight', 'Barbarian', 'Mage', 'Rogue', 'Rogue_Hooded'];

// Both KayKit packs texture everything from one atlas that is an 8x4 grid of gradient swatches, so a
// colour can be swapped by repainting one grid cell. Cells are [column, row, shade].
export const CELL = {
  roof: [[0, 3]],            // team colour of the "blue" buildings
  windows: [[6, 1]],         // window panes of every building
  lanternGlass: [[2, 3]],    // Halloween Bits lantern glass
  cloth: {                   // main clothing swatches of each villager model
    Knight: [[0, 1]], Barbarian: [[0, 1], [1, 1], [2, 2]], Mage: [[0, 1], [1, 1]],
    Rogue: [[0, 1, 0.72], [1, 1]], Rogue_Hooded: [[0, 1, 0.72], [1, 1]],
  },
};

const rgb = (hex, k) => {
  const v = parseInt(new THREE.Color(hex).getHexString(), 16);
  const ch = s => Math.max(0, Math.min(255, Math.round(((v >> s) & 255) * k)));
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
};

/** Copy of an atlas image with some cells repainted as a light-to-dark gradient of `color`. */
export function recolor(image, cells, color, size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0, size, size);
  const w = size / 8, h = size / 4;
  for (const [cx, cy, shade = 1] of cells) {
    const grad = g.createLinearGradient(0, cy * h, 0, (cy + 1) * h);
    grad.addColorStop(0, rgb(color, 1.1 * shade));
    grad.addColorStop(1, rgb(color, 0.52 * shade));
    g.fillStyle = grad; g.fillRect(cx * w, cy * h, w, h);
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Emissive map for an atlas: black except the given cells. */
export function emissiveMap(cells, color = '#ffc978') {
  const c = document.createElement('canvas'); c.width = 64; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 32);
  g.fillStyle = color;
  for (const [cx, cy] of cells) g.fillRect(cx * 8, cy * 8, 8, 8);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}

export async function loadAssets(base) {
  const loader = new GLTFLoader();
  const out = { models: {}, atlas: {}, mat: {}, chars: {}, robot: null, failed: [] };
  const load = url => loader.loadAsync(url).catch(() => { out.failed.push(url); return null; });
  const pack = (dir, names) => names.map(n => load(`${base}${dir}/${n}.gltf`).then(g => { if (g) out.models[n] = { scene: g.scene, dir }; }));
  // The 40 models of the two packs all point at one of two atlas images. With three's cache on,
  // each image is fetched and decoded once instead of once per model.
  const cacheWas = THREE.Cache.enabled;
  THREE.Cache.enabled = true;
  try {
    await Promise.all([
      ...pack('village', VILLAGE), ...pack('graveyard', GRAVEYARD),
      ...VILLAGERS.map(n => load(`${base}characters/${n}.glb`).then(g => { if (g) out.chars[n] = g; })),
      load(`${base}robot/RobotExpressive.glb`).then(g => { out.robot = g; }),
    ]);
  } finally {
    THREE.Cache.enabled = cacheWas;
    if (!cacheWas) THREE.Cache.clear();
  }
  if (out.failed.length) console.warn(`[scene] ${out.failed.length} asset(s) failed to load; using simple geometry instead`, out.failed);
  // one shared material per pack, taken from the first model whose atlas arrived
  for (const { scene, dir } of Object.values(out.models)) scene.traverse(m => {
    if (!m.isMesh || !m.material.map?.image || out.mat[dir]) return;
    out.atlas[dir] = m.material.map.image;
    out.mat[dir] = new THREE.MeshLambertMaterial({ map: m.material.map });   // matte: cheap to compile and to light
  });

  /** Clone of a model with `material` on every mesh (geometry is shared). null when the model or its atlas is missing. */
  out.spawn = (name, material, shadow = true) => {
    const src = out.models[name], mat = src && (material || out.mat[src.dir]);
    if (!mat) return null;
    const o = src.scene.clone(true);
    o.traverse(m => { if (m.isMesh) { m.material = mat; m.castShadow = shadow; m.receiveShadow = true; } });
    return o;
  };
  /** First mesh geometry of a single-mesh model, for instancing. */
  out.geometry = name => {
    let geo = null;
    out.models[name]?.scene.traverse(m => { if (m.isMesh && !geo) geo = m.geometry; });
    return geo;
  };
  return out;
}
