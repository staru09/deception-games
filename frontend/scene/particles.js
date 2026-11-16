// One small point-sprite system, reused for smoke, embers, fireflies, stars, confetti and bursts.
import * as THREE from 'three';

/** Set by scene.js on resize: device pixels per world unit at distance 1, and the device pixel ratio. */
export const pointScale = { value: 800 }, pointPx = { value: 1 };

let dot;
function dotTexture() {
  if (dot) return dot;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.45, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return (dot = new THREE.CanvasTexture(c));
}

export class Particles extends THREE.Points {
  /** attenuate=false gives a fixed size in CSS pixels (stars). */
  constructor(count, { additive = false, attenuate = true, square = false } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(count * 4), 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count), 1));
    super(geo, new THREE.ShaderMaterial({
      uniforms: { map: { value: dotTexture() }, uScale: pointScale, uPx: pointPx, uOpacity: { value: 1 } },
      vertexShader: `uniform float uScale; uniform float uPx; attribute float aSize; attribute vec4 aColor; varying vec4 vColor;
        void main() { vColor = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = ${attenuate ? 'aSize * uScale / max(0.1, -mv.z)' : 'aSize * uPx'}; }`,
      fragmentShader: `uniform sampler2D map; uniform float uOpacity; varying vec4 vColor;
        void main() { float a = ${square ? '1.0' : 'texture2D(map, gl_PointCoord).a'} * vColor.a * uOpacity; if (a < 0.004) discard; gl_FragColor = vec4(vColor.rgb, a); }`,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.count = count; this.frustumCulled = false;
    this.pos = geo.attributes.position.array; this.col = geo.attributes.aColor.array; this.size = geo.attributes.aSize.array;
  }
  set(i, x, y, z, r, g, b, a, size) {
    const p = this.pos, c = this.col;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    c[i * 4] = r; c[i * 4 + 1] = g; c[i * 4 + 2] = b; c[i * 4 + 3] = a;
    this.size[i] = size;
  }
  commit() { const a = this.geometry.attributes; a.position.needsUpdate = a.aColor.needsUpdate = a.aSize.needsUpdate = true; }
  set opacity(v) { this.material.uniforms.uOpacity.value = v; this.visible = v > 0.003; }
}
