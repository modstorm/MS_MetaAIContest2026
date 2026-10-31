import * as THREE from 'three';
import { exportGLB } from '@metaai26/reskin-plugin';

/**
 * Builds a small sample robot as a real GLB (ArrayBuffer), so judges can try the
 * pipeline without hunting for a model. It has:
 *  - one shared 1024² atlas, split into 4 regions (head, torso, limbs, base),
 *    with each part's UVs packed into its region, like a typical game asset;
 *  - one untextured material (antenna ball) to exercise the "no texture" path.
 * The harness then loads it through the plugin exactly like a dropped file.
 */
export async function buildSampleGlb() {
  const atlas = paintAtlas();
  const tex = new THREE.CanvasTexture(atlas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.name = 'robot_atlas';

  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.2, name: 'robot_body' });
  const ballMat = new THREE.MeshStandardMaterial({ color: 0xff4466, roughness: 0.3, name: 'antenna_ball' });

  const root = new THREE.Group();
  root.name = 'SampleRobot';
  // [u0, v0, u1, v1] regions of the atlas (v grows downward in glTF image space).
  const HEAD = [0, 0, 0.5, 0.5],
    TORSO = [0.5, 0, 1, 0.5],
    LIMB = [0, 0.5, 0.5, 1],
    BASE = [0.5, 0.5, 1, 1];

  const add = (name, geom, region, pos, material = mat) => {
    if (region.length) packUvs(geom, region);
    const m = new THREE.Mesh(geom, material);
    m.name = name;
    m.position.set(...pos);
    root.add(m);
    return m;
  };

  add('head', new THREE.BoxGeometry(0.6, 0.5, 0.5), HEAD, [0, 1.55, 0]);
  add('torso', new THREE.CylinderGeometry(0.42, 0.36, 0.8, 24), TORSO, [0, 0.95, 0]);
  add('arm_l', new THREE.CapsuleGeometry(0.1, 0.55, 6, 12), LIMB, [-0.55, 1.0, 0]).rotation.z = 0.25;
  add('arm_r', new THREE.CapsuleGeometry(0.1, 0.55, 6, 12), LIMB, [0.55, 1.0, 0]).rotation.z = -0.25;
  add('leg_l', new THREE.CapsuleGeometry(0.12, 0.35, 6, 12), LIMB, [-0.2, 0.33, 0]);
  add('leg_r', new THREE.CapsuleGeometry(0.12, 0.35, 6, 12), LIMB, [0.2, 0.33, 0]);
  add('base', new THREE.CylinderGeometry(0.7, 0.8, 0.12, 32), BASE, [0, 0.06, 0]);
  add('antenna', new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8), HEAD, [0, 1.95, 0]);
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), ballMat);
  ball.geometry.deleteAttribute('uv'); // exercise the "no UVs" path
  ball.name = 'antenna_ball';
  ball.position.set(0, 2.12, 0);
  root.add(ball);

  return exportGLB(root);
}

/** Scales a geometry's 0..1 UVs into an atlas region (and flips v to glTF image space). */
function packUvs(geom, [u0, v0, u1, v1]) {
  const uv = geom.getAttribute('uv');
  const pad = 0.01;
  for (let i = 0; i < uv.count; i++) {
    const u = Math.min(1, Math.max(0, uv.getX(i))),
      v = 1 - uv.getY(i);
    uv.setXY(i, u0 + pad + u * (u1 - u0 - 2 * pad), v0 + pad + v * (v1 - v0 - 2 * pad));
  }
  uv.needsUpdate = true;
}

function paintAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  // Head: face panel with eyes
  g.fillStyle = '#c9ced8';
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#2b3140';
  g.fillRect(60, 150, 392, 200);
  g.fillStyle = '#4fe3ff';
  g.beginPath();
  g.arc(170, 250, 45, 0, Math.PI * 2);
  g.arc(342, 250, 45, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#8a91a3';
  for (let i = 0; i < 6; i++) g.fillRect(140 + i * 40, 400, 22, 50);
  // Torso: plates and a chest light
  g.fillStyle = '#9aa3b5';
  g.fillRect(512, 0, 512, 512);
  g.strokeStyle = '#5d6475';
  g.lineWidth = 6;
  for (let i = 0; i < 4; i++) g.strokeRect(540 + i * 120, 40, 100, 430);
  g.fillStyle = '#ffb547';
  g.beginPath();
  g.arc(768, 200, 60, 0, Math.PI * 2);
  g.fill();
  // Limbs: hazard stripes
  g.fillStyle = '#3a3f4c';
  g.fillRect(0, 512, 512, 512);
  g.fillStyle = '#e3c341';
  for (let i = -8; i < 16; i++) {
    g.beginPath();
    g.moveTo(i * 64, 512);
    g.lineTo(i * 64 + 32, 512);
    g.lineTo(i * 64 + 32 + 512, 1024);
    g.lineTo(i * 64 + 512, 1024);
    g.closePath();
    g.fill();
  }
  // Base: rivets on dark metal
  g.fillStyle = '#4a4f5c';
  g.fillRect(512, 512, 512, 512);
  g.fillStyle = '#7d8495';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      g.beginPath();
      g.arc(544 + x * 64, 544 + y * 64, 8, 0, Math.PI * 2);
      g.fill();
    }
  return c;
}
