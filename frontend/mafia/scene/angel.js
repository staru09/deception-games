// The moderator as an angel. It never touches the ground: it waits out of sight high above the
// village, glides down to hover over the plaza while the moderator speaks (a narration event),
// and drifts back up when it is done. Built from primitives, so there is no model to load.
import * as THREE from 'three';

const SKY = new THREE.Vector3(0, 46, -30);   // out of sight above the far side of the village
const DESCEND_S = 2.2, ASCEND_S = 2.8;       // seconds at 1× for the glide down and the climb back

export function createAngel(scene, { hover = 9 } = {}) {
  const angel = new THREE.Group();
  const robe = new THREE.MeshStandardMaterial({ color: 0xf7f3ff, emissive: 0xd8d0ff, emissiveIntensity: 0.45, roughness: 0.55, side: THREE.DoubleSide });
  const skin = new THREE.MeshStandardMaterial({ color: 0xfff3dc, emissive: 0xffe1a6, emissiveIntensity: 0.8, roughness: 0.4 });
  const gold = new THREE.MeshBasicMaterial({ color: 0xffd877 });
  const feather = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf0ecff, emissiveIntensity: 0.55, side: THREE.DoubleSide, transparent: true, opacity: 0.93 });

  const body = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.9, 24, 1, true), robe);
  body.position.y = -0.35;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 24, 16), skin);
  head.position.y = 0.85;
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 10, 48), gold);
  halo.position.y = 1.32; halo.rotation.x = Math.PI / 2;

  // One wing outline, mirrored for the other side; each hangs from a pivot at the shoulder.
  const outline = new THREE.Shape();
  outline.moveTo(0, 0);
  outline.bezierCurveTo(0.5, 0.9, 1.7, 1.35, 2.4, 0.75);
  outline.bezierCurveTo(1.9, 0.45, 1.75, -0.05, 1.35, -0.55);
  outline.bezierCurveTo(1.0, -0.3, 0.45, -0.45, 0, 0);
  const wingShape = new THREE.ShapeGeometry(outline, 18);
  const wings = [1, -1].map((side) => {
    const pivot = new THREE.Group();
    const wing = new THREE.Mesh(wingShape, feather);
    wing.scale.x = side;
    pivot.add(wing);
    pivot.position.set(0.12 * side, 0.35, -0.15);
    angel.add(pivot);
    return { pivot, side };
  });

  const light = new THREE.PointLight(0xffe2a0, 0, 16, 1.6);
  light.position.y = -0.4;
  angel.add(body, head, halo, light);
  angel.scale.setScalar(2.2);   // big enough to read from the default camera distance
  angel.visible = false;
  scene.add(angel);

  const HOVER = new THREE.Vector3(0, hover, 0);
  let k = 0;          // 0 = in the sky, 1 = hovering over the plaza
  let stay = 0;       // seconds (at 1×) left to hover
  let going = false;  // gliding down, or hovering

  return {
    /** The moderator speaks for about `seconds`: come down, or stay longer if already here. */
    speak(seconds) {
      going = true;
      stay = Math.max(stay, seconds);
      angel.visible = true;
    },
    /** Gone at once (after a jump in the timeline). */
    away() {
      going = false; stay = 0; k = 0;
      angel.visible = false; light.intensity = 0;
    },
    update(dt, time, mul) {
      if (!angel.visible) return;
      if (going) {
        k = Math.min(1, k + dt * mul / DESCEND_S);
        if (k === 1 && (stay -= dt * mul) <= 0) going = false;
      } else {
        k = Math.max(0, k - dt * mul / ASCEND_S);
        if (k === 0) { angel.visible = false; light.intensity = 0; return; }
      }
      const e = k * k * (3 - 2 * k);
      angel.position.lerpVectors(SKY, HOVER, e);
      angel.position.y += Math.sin(time * 1.7) * 0.35 * e;   // a gentle bob once it hovers
      angel.rotation.y = Math.sin(time * 0.35) * 0.6;         // turns to look around the circle
      angel.rotation.z = Math.sin(time * 1.1) * 0.06;
      const beat = Math.sin(time * (going ? 5.5 : 7.5));       // beats faster while climbing away
      for (const { pivot, side } of wings) pivot.rotation.y = side * (0.35 + beat * 0.45);
      halo.rotation.z = time * 0.8;
      light.intensity = e * 7;
    },
  };
}
