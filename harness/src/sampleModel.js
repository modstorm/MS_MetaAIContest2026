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

/**
 * Test asset for UV orientation: two planes sharing one atlas. "Head" (top half of the
 * atlas) is stored upside down, "Body" (bottom half) is stored upright.
 */
export async function buildOrientationTestGlb() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#888';
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, name: 'doll' });
  const root = new THREE.Group();
  const make = (name, y, upsideDown, [v0, v1]) => {
    const geom = new THREE.PlaneGeometry(1, 1);
    const uv = geom.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      // glTF v grows downward: upright means top of plane -> small v.
      const t = 1 - uv.getY(i); // 0 at top of plane
      const v = upsideDown ? 1 - t : t;
      uv.setXY(i, uv.getX(i), v0 + v * (v1 - v0));
    }
    const m = new THREE.Mesh(geom, mat);
    m.name = name;
    m.position.y = y;
    root.add(m);
  };
  make('Head', 1.2, true, [0, 0.5]);
  make('Body', 0, false, [0.5, 1]);
  return exportGLB(root);
}

/**
 * Test asset for post-processing: one large "Arm" island (u 0.1–0.4, v 0.1–0.9)
 * and ten tiny "Finger" islands in a row (v 0.45–0.48), sharing a 1024² atlas.
 */
export async function buildPaddingTestGlb() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 1024, 1024);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, name: 'skin' });
  const root = new THREE.Group();
  const quad = (name, [u0, v0, u1, v1], x) => {
    const geom = new THREE.PlaneGeometry(0.2, 0.2);
    const uv = geom.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + (1 - uv.getY(i)) * (v1 - v0));
    const m = new THREE.Mesh(geom, mat);
    m.name = name;
    m.position.x = x;
    root.add(m);
  };
  quad('Arm', [0.1, 0.1, 0.4, 0.9], 0);
  for (let i = 0; i < 10; i++) quad('Finger', [0.5 + i * 0.045, 0.45, 0.53 + i * 0.045, 0.48], 0.3 + i * 0.25);
  return exportGLB(root);
}

/**
 * A blocky avatar for the body-zone test: "Body" = torso + neck + head + hair (one mesh),
 * "Arms" = both arms including the hands (one mesh), "Legs". Each box has its own UV rect.
 */
export async function buildAvatarTestGlb({
  singleMesh = false,
  touchingLegs = false,
  torsoColumns = 1,
  hairStrands = 0,
  skinSwatch = false,
  separateHands = false,
  unwrappedLegs = false,
  hairSharedUv = false,
  oneMesh = false,
  torsoWrap = false,
} = {}) {
  const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js');
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#c99';
  g.fillRect(0, 0, 512, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, name: 'avatar' });
  const box = ([w, h, d], [x, y, z], rect, seg = 1, cols = 1) => {
    const geom = new THREE.BoxGeometry(w, h, d, cols, seg, 1);
    packUvs(geom, rect);
    geom.translate(x, y, z);
    return geom;
  };
  const mesh = (name, geoms) => {
    const m = new THREE.Mesh(mergeGeometries(geoms), mat);
    m.name = name;
    return m;
  };
  // torsoWrap: the torso is one strip wrapped round the body, laid out left to right as
  // side, front, side, back (front and back twice as wide as the sides), front off-center.
  const wrapTorso = () => {
    const hx = 0.25,
      hz = 0.125,
      yTop = 1.5,
      yBot = 0.9,
      rect = [0.4, 0.74, 0.98, 0.98];
    const faces = [
      { n: [1, 0, 0], w: 2 * hz },
      { n: [0, 0, 1], w: 2 * hx },
      { n: [-1, 0, 0], w: 2 * hz },
      { n: [0, 0, -1], w: 2 * hx },
    ];
    const total = faces.reduce((a, f) => a + f.w, 0);
    const pos = [],
      uvs = [],
      idx = [];
    let acc = 0;
    for (const f of faces) {
      const r = [f.n[2], 0, -f.n[0]]; // up × n
      const half = f.w / 2;
      const c = [f.n[0] * hx, 0, f.n[2] * hz];
      const a = rect[0] + ((rect[2] - rect[0]) * acc) / total;
      acc += f.w;
      const b = rect[0] + ((rect[2] - rect[0]) * acc) / total;
      const corner = (sx, y) => [c[0] + r[0] * half * sx, y, c[2] + r[2] * half * sx];
      const base = pos.length / 3;
      pos.push(...corner(-1, yTop), ...corner(1, yTop), ...corner(1, yBot), ...corner(-1, yBot));
      uvs.push(a, rect[1], b, rect[1], b, rect[3], a, rect[3]);
      idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  const torso = [
    torsoWrap ? wrapTorso() : box([0.5, 0.6, 0.25], [0, 1.2, 0], [0.02, 0.02, 0.3, 0.3], 6, torsoColumns), // torsoColumns: vertex columns across (low-poly)
    box([0.08, 0.1, 0.08], [0, 1.55, 0], [0.32, 0.02, 0.36, 0.06]), // neck
  ];
  // skinSwatch: a small box on the upper back whose UVs are one tiny square (a color swatch).
  if (skinSwatch) torso.push(box([0.1, 0.1, 0.02], [0, 1.4, -0.14], [0.33, 0.1, 0.36, 0.13]));
  const head = [
    box([0.24, 0.25, 0.24], [0, 1.725, 0], [0.5, 0.02, 0.7, 0.2], 4), // face
    box([0.26, 0.15, 0.26], [0, 1.925, 0], [0.75, 0.02, 0.98, 0.2], 2), // hair
  ];
  // separateHands: each hand (a long one: the last 0.35 of the arm) is its own UV island.
  const arms = separateHands
    ? [
        box([0.1, 0.3, 0.1], [-0.35, 1.3, 0], [0.02, 0.4, 0.2, 0.6], 10),
        box([0.1, 0.3, 0.1], [0.35, 1.3, 0], [0.25, 0.4, 0.43, 0.6], 10),
        box([0.1, 0.35, 0.1], [-0.35, 0.975, 0], [0.02, 0.62, 0.2, 0.7], 6),
        box([0.1, 0.35, 0.1], [0.35, 0.975, 0], [0.25, 0.62, 0.43, 0.7], 6),
      ]
    : [
        box([0.1, 0.65, 0.1], [-0.35, 1.125, 0], [0.02, 0.4, 0.2, 0.7], 20),
        box([0.1, 0.65, 0.1], [0.35, 1.125, 0], [0.25, 0.4, 0.43, 0.7], 20),
      ];
  // unwrappedLegs: each leg is four side strips laid out next to each other in the texture
  // (right leg: inner, back, outer, front; left leg: inner, front, outer, back).
  const tube = (cx, rect, order) => {
    const hw = 0.075,
      yTop = 0.925,
      yBot = 0.075;
    const dirs = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      outer: [Math.sign(cx), 0, 0],
      inner: [-Math.sign(cx), 0, 0],
    };
    const pos = [],
      uvs = [],
      idx = [];
    order.forEach((name, k) => {
      const n = dirs[name];
      const r = [n[2], 0, -n[0]]; // up × n
      const c = [cx + n[0] * hw, 0, n[2] * hw];
      const a = rect[0] + ((rect[2] - rect[0]) * k) / 4,
        b = rect[0] + ((rect[2] - rect[0]) * (k + 1)) / 4;
      const corner = (sx, y) => [c[0] + r[0] * hw * sx, y, c[2] + r[2] * hw * sx];
      const base = pos.length / 3;
      pos.push(...corner(-1, yTop), ...corner(1, yTop), ...corner(1, yBot), ...corner(-1, yBot));
      uvs.push(a, rect[1], b, rect[1], b, rect[3], a, rect[3]);
      idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  const legs = unwrappedLegs
    ? [
        tube(-0.12, [0.5, 0.4, 0.7, 0.7], ['inner', 'back', 'outer', 'front']),
        tube(0.12, [0.75, 0.4, 0.95, 0.7], ['inner', 'front', 'outer', 'back']),
      ]
    : [
        // touchingLegs: legs pressed together (the middle is filled all the way down).
        box([0.15, 0.85, 0.15], [touchingLegs ? -0.075 : -0.12, 0.5, 0], [0.5, 0.4, 0.7, 0.7], 6),
        box([0.15, 0.85, 0.15], [touchingLegs ? 0.075 : 0.12, 0.5, 0], [0.75, 0.4, 0.95, 0.7], 6),
      ];
  // Shoes share one UV rect, the second one mirrored (opposite UV winding).
  const shoeL = box([0.16, 0.08, 0.25], [-0.12, 0.04, 0.04], [0.05, 0.8, 0.3, 0.95]);
  const shoeR = box([0.16, 0.08, 0.25], [0.12, 0.04, 0.04], [0.05, 0.8, 0.3, 0.95]);
  const uv = shoeR.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, 0.35 - uv.getX(i));
  // hairStrands: a separate Hair mesh of spiky cards (one UV island each) instead of a hair box.
  const strands = [];
  for (let i = 0; i < hairStrands; i++) {
    const a = (i / hairStrands) * Math.PI * 2;
    const card = new THREE.PlaneGeometry(0.06, 0.22);
    const col = i % 4,
      row = Math.floor(i / 4);
    // hairSharedUv: every card uses the same UV square (one UV island for all strands).
    if (hairSharedUv) packUvs(card, [0.75, 0.22, 0.8, 0.3]);
    else packUvs(card, [0.75 + col * 0.06, 0.22 + row * 0.09, 0.8 + col * 0.06, 0.3 + row * 0.09]);
    card.translate(0, 0.11, 0); // root at the origin
    card.rotateX(0.6); // lean outward…
    card.rotateY(a); // …all around the head
    card.translate(Math.sin(a) * 0.08, 1.83, Math.cos(a) * 0.08);
    strands.push(card);
  }
  if (hairStrands) head.pop(); // no hair box
  const root = new THREE.Group();
  // oneMesh: everything, shoes included, in one mesh (like a single "ROOT SKIN" avatar).
  if (oneMesh) root.add(mesh('Body', [...torso, ...head, ...arms, ...legs, shoeL, shoeR]));
  else if (singleMesh) root.add(mesh('Body', [...torso, ...head, ...arms, ...legs]));
  else root.add(mesh('Body', [...torso, ...head]), mesh('Arms', arms), mesh('Legs', legs));
  if (!oneMesh) root.add(mesh('Shoes', [shoeL, shoeR]));
  if (strands.length) root.add(mesh('Hair', strands));
  return exportGLB(root);
}

/**
 * A toy car laid out like Kris's test car: a body atlas and a separate wheel atlas,
 * both materials named "lambert1" (Maya's default), and four wheels whose UVs are
 * all stacked on the same wheel image (100% overlap).
 */
export async function buildCarTestGlb() {
  const flat = (w, h, color, name) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.fillRect(w * 0.1, h * 0.1, w * 0.3, h * 0.3);
    const t = new THREE.CanvasTexture(c);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.name = name;
    return t;
  };
  const bodyMat = new THREE.MeshStandardMaterial({ map: flat(1024, 1024, '#3366cc', ''), name: 'lambert1' });
  const wheelMat = new THREE.MeshStandardMaterial({ map: flat(512, 512, '#222222', ''), name: 'lambert1' });
  const root = new THREE.Group();
  root.name = 'ToyCar';
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 1), bodyMat);
  packUvs(body.geometry, [0.05, 0.05, 0.95, 0.6]);
  body.name = 'carBody';
  body.position.set(0, 0.6, 0);
  root.add(body);
  for (const [name, x, z] of [
    ['tireBackR', -0.7, 0.55],
    ['tireBackL', -0.7, -0.55],
    ['tireFrontR', 0.7, 0.55],
    ['tireFrontL', 0.7, -0.55],
  ]) {
    const g = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 20);
    packUvs(g, [0.05, 0.05, 0.95, 0.95]); // every wheel on the same spot of the wheel image
    const m = new THREE.Mesh(g, wheelMat);
    m.name = name;
    m.rotation.x = Math.PI / 2;
    m.position.set(x, 0.3, z);
    root.add(m);
  }
  return exportGLB(root);
}

/**
 * Test asset for buildings: one box mesh named "Building". Walls (±X, ±Z) sit side by side
 * in the top half of the atlas, each with two dark windows; the roof (+Y) is bottom-left,
 * the underside (-Y) bottom-right with a red door on it (as in kit models that reuse a facade).
 * `sharedUnderside` maps the underside onto the first wall instead (overlapping UVs).
 */
export async function buildBuildingTestGlb({ sharedUnderside = false } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#b0a080';
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#202020';
  for (let i = 0; i < 4; i++) {
    g.fillRect(i * 128 + 20, 60, 30, 50);
    g.fillRect(i * 128 + 78, 60, 30, 50);
  }
  g.fillStyle = '#606060';
  g.fillRect(0, 256, 256, 256);
  g.fillStyle = '#504030';
  g.fillRect(256, 256, 256, 256);
  g.fillStyle = '#c02020';
  g.fillRect(340, 330, 80, 120);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, name: 'building' });
  const geom = new THREE.BoxGeometry(2, 1.2, 1.6);
  const uv = geom.getAttribute('uv');
  // BoxGeometry faces, 4 vertices each: +X, -X, +Y, -Y, +Z, -Z.
  const rects = [
    [0.25, 0, 0.5, 0.5], // +X wall
    [0.75, 0, 1, 0.5], // -X wall
    [0, 0.5, 0.5, 1], // roof
    sharedUnderside ? [0, 0, 0.25, 0.5] : [0.5, 0.5, 1, 1], // underside
    [0, 0, 0.25, 0.5], // +Z wall (front)
    [0.5, 0, 0.75, 0.5], // -Z wall
  ];
  for (let f = 0; f < 6; f++) {
    const [u0, v0, u1, v1] = rects[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      // three's box UVs have v up; glTF v grows downward.
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + (1 - uv.getY(i)) * (v1 - v0));
    }
  }
  const m = new THREE.Mesh(geom, mat);
  m.name = 'Building';
  return exportGLB(m);
}

/**
 * Test asset for the vehicle rule: one 512² atlas shared by a body, a "Headlight_L", a
 * "TailLight_R" and a "Wheel_FL" (tread = cylinder side, sidewalls = the two caps).
 * Atlas (pixels): body 0-512 × 0-256 blue; headlight 0-128 × 256-384 yellow; taillight
 * 128-256 × 256-384 red; tread 0-256 × 384-512 striped grey; sidewalls 256-384 / 384-512
 * × 384-512 mid grey.
 */
export async function buildVehicleTestGlb() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2050c0';
  g.fillRect(0, 0, 512, 256);
  // Headlight: a yellow lens inside a ring of body paint (the housing), and a body-colored
  // side mirror whose name says "light" (a light finder mistake).
  g.fillStyle = '#2050c0';
  g.fillRect(0, 256, 128, 128);
  g.fillRect(256, 256, 128, 128);
  g.fillStyle = '#ffe040';
  g.fillRect(30, 286, 68, 68);
  g.fillStyle = '#e02020';
  g.fillRect(128, 256, 128, 128);
  g.fillStyle = '#303030';
  g.fillRect(0, 384, 256, 128);
  g.fillStyle = '#b0b0b0';
  for (let x = 8; x < 256; x += 24) g.fillRect(x, 384, 8, 128);
  g.fillStyle = '#808080';
  g.fillRect(256, 384, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, name: 'car' });
  const fit = (geom, [u0, v0, u1, v1], pick = () => true) => {
    const uv = geom.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      if (!pick(i)) continue;
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + (1 - uv.getY(i)) * (v1 - v0));
    }
  };
  const root = new THREE.Group();
  const add = (geom, name, pos) => {
    const m = new THREE.Mesh(geom, mat);
    m.name = name;
    m.position.set(...pos);
    root.add(m);
    return m;
  };
  const body = new THREE.BoxGeometry(2, 0.6, 1);
  fit(body, [0.02, 0.02, 0.98, 0.48]);
  add(body, 'Body', [0, 0.6, 0]);
  const head = new THREE.BoxGeometry(0.1, 0.15, 0.3);
  fit(head, [0.02, 0.52, 0.23, 0.73]);
  add(head, 'Headlight_L', [1.02, 0.65, 0.3]);
  const mirror = new THREE.BoxGeometry(0.15, 0.1, 0.1);
  fit(mirror, [0.52, 0.52, 0.73, 0.73]);
  add(mirror, 'MirrorLight_L', [0.6, 0.95, 0.55]);
  const tail = new THREE.BoxGeometry(0.1, 0.15, 0.3);
  fit(tail, [0.27, 0.52, 0.48, 0.73]);
  add(tail, 'TailLight_R', [-1.02, 0.65, 0.3]);
  // Wheel: axle along Z (the car's side axis here is Z: the wheel faces ±Z).
  const wheel = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 24);
  const n = wheel.getAttribute('normal');
  const isCap = (i, s) => Math.abs(n.getY(i)) > 0.9 && Math.sign(n.getY(i)) === s;
  fit(wheel, [0.02, 0.77, 0.48, 0.98], (i) => Math.abs(n.getY(i)) <= 0.9);
  fit(wheel, [0.52, 0.77, 0.73, 0.98], (i) => isCap(i, 1));
  fit(wheel, [0.77, 0.77, 0.98, 0.98], (i) => isCap(i, -1));
  const w = add(wheel, 'Wheel_FL', [0.7, 0.3, 0.55]);
  w.rotation.x = Math.PI / 2;
  return exportGLB(root);
}
