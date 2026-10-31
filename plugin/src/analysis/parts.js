import * as THREE from 'three';
import { uvSourceOf } from './textureLayout.js';
import { computeUvBounds, islandIdPerTriangle, triangleCount } from './uvIslands.js';

/** Distinct, nameable colors for the part map (name used in prompts, hex used in the image). */
export const PART_COLORS = [
  ['red', '#e6194b'],
  ['blue', '#4363d8'],
  ['green', '#3cb44b'],
  ['yellow', '#ffe119'],
  ['magenta', '#f032e6'],
  ['cyan', '#42d4f4'],
  ['orange', '#f58231'],
  ['purple', '#911eb4'],
  ['lime', '#bfef45'],
  ['brown', '#9a6324'],
  ['navy', '#000075'],
  ['pink', '#fabed4'],
];

function cleanName(s) {
  return String(s || '')
    .replace(/[_.\-]+/g, ' ')
    .replace(/\b(mesh|geo|geom|primitive|prim|lod\d*|\d+)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A readable part name for a mesh: its own name, else its material's, else its parent's. */
export function partName(mesh) {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  return cleanName(mesh.name) || cleanName(mat?.name) || cleanName(mesh.parent?.name) || 'part';
}

/**
 * Splits a texture slot into named parts (one per distinct mesh name), with each
 * part's UV bounding box and the orientation of its islands. The orientation says
 * which way the model's world "up" points inside the texture image, so the image
 * model can paint faces and lettering the right way round.
 *
 * @param {import('../types.js').TextureSlot} slot
 * @returns {{ name: string, color: string, hex: string, meshes: import('three').Mesh[],
 *   bbox: [number, number, number, number], area: number, up: 'up'|'down'|'left'|'right'|'mixed'|null }[]}
 */
export function slotParts(slot) {
  const byName = new Map();
  for (const mesh of slot.meshes) {
    const name = partName(mesh);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(mesh);
  }
  const parts = [];
  for (const [name, meshes] of byName) {
    let minU = Infinity,
      minV = Infinity,
      maxU = -Infinity,
      maxV = -Infinity;
    const votes = { up: 0, down: 0, left: 0, right: 0 };
    let area = 0;
    let mirroredArea = 0;
    for (const mesh of meshes) {
      const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
      if (!src) continue;
      const b = computeUvBounds(src);
      minU = Math.min(minU, b.minU);
      minV = Math.min(minV, b.minV);
      maxU = Math.max(maxU, b.maxU);
      maxV = Math.max(maxV, b.maxV);
      for (const o of islandUpDirections(mesh, src)) {
        votes[o.dir] += o.area;
        area += o.area;
        if (o.mirrored) mirroredArea += o.area;
      }
    }
    if (!Number.isFinite(minU)) continue;
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    let up = null;
    if (area > 0) up = ranked[0][1] / area >= 0.6 ? ranked[0][0] : 'mixed';
    const clamp = (x) => Math.round(Math.min(1, Math.max(0, x)) * 1000);
    parts.push({
      name,
      meshes,
      bbox: [clamp(minU), clamp(minV), clamp(maxU), clamp(maxV)],
      area,
      up,
      mirrored: area > 0 && mirroredArea / area > 0.5,
    });
  }
  parts.sort((a, b) => b.area - a.area);
  return parts.slice(0, PART_COLORS.length).map((p, i) => ({ ...p, color: PART_COLORS[i][0], hex: PART_COLORS[i][1] }));
}

/**
 * For each UV island of a mesh, fits world height (Y) as a linear function of (u, v)
 * by least squares; the gradient (∂y/∂u, ∂y/∂v) is the direction in the image that
 * points "up" on the model. Image y grows downward, matching glTF v.
 */
export function islandUpDirections(mesh, src) {
  const pos = mesh.geometry.getAttribute('position');
  if (!pos) return [];
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  const tris = triangleCount(src);
  const island = islandIdPerTriangle(src);
  const acc = new Map();
  const p = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    let a = acc.get(island[t]);
    if (!a) acc.set(island[t], (a = { s: new Float64Array(9), area: 0, signed: 0 }));
    const idx = [0, 1, 2].map((k) => (src.index ? src.index[t * 3 + k] : t * 3 + k));
    const [u0, v0, u1, v1, u2, v2] = idx.flatMap((v) => [src.uvs[v * 2], src.uvs[v * 2 + 1]]);
    const cross = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    a.area += Math.abs(cross) / 2;
    // glTF triangles are counter-clockwise from outside. With v pointing down (image space)
    // an unmirrored mapping has a negative signed UV area; positive means the island is mirrored.
    a.signed += cross / 2;
    for (const v of idx) {
      const u = src.uvs[v * 2],
        w = src.uvs[v * 2 + 1];
      const y = p.fromBufferAttribute(pos, v).applyMatrix4(m).y;
      const s = a.s; // sums for normal equations of y = A u + B w + C
      s[0] += u * u;
      s[1] += u * w;
      s[2] += u;
      s[3] += w * w;
      s[4] += w;
      s[5] += 1;
      s[6] += u * y;
      s[7] += w * y;
      s[8] += y;
    }
  }
  const out = [];
  for (const [id, { s, area, signed }] of acc) {
    const M = [
      [s[0], s[1], s[2]],
      [s[1], s[3], s[4]],
      [s[2], s[4], s[5]],
    ];
    const sol = solve3(M, [s[6], s[7], s[8]]);
    if (!sol || area <= 0) continue;
    const [A, B] = sol;
    if (Math.hypot(A, B) < 1e-9) continue;
    // Image "up" is -y. Classify the direction the model's up points to in the image.
    const dir = Math.abs(A) > Math.abs(B) ? (A > 0 ? 'right' : 'left') : B > 0 ? 'down' : 'up';
    out.push({ id, dir, area, gradient: [A, B], mirrored: signed > 0 });
  }
  return out;
}

function solve3(M, b) {
  const [[a, b1, c], [d, e, f], [g, h, i]] = M;
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const inv = [
    [(e * i - f * h) / det, (c * h - b1 * i) / det, (b1 * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b1 * g - a * h) / det, (a * e - b1 * d) / det],
  ];
  return inv.map((r) => r[0] * b[0] + r[1] * b[1] + r[2] * b[2]);
}

/** Human sentence for a part's orientation, for prompts. */
export function orientationNote(up) {
  switch (up) {
    case 'up':
      return 'stored upright (top of the part at the top of the image)';
    case 'down':
      return 'stored UPSIDE DOWN (the top of this part points to the bottom of the image), so paint it upside down';
    case 'left':
      return 'stored rotated (the top of this part points to the LEFT of the image)';
    case 'right':
      return 'stored rotated (the top of this part points to the RIGHT of the image)';
    case 'mixed':
      return 'made of islands facing different directions';
    default:
      return '';
  }
}

// ------------------------------------------------------------------ orientation transform
// A transform T = rotate `rot` degrees clockwise, then mirror horizontally if `flipX`.

const ROT_DIR = { up: 'right', right: 'down', down: 'left', left: 'up' }; // one 90° clockwise step

function mapDir(dir, t) {
  if (!['up', 'down', 'left', 'right'].includes(dir)) return dir;
  let d = dir;
  for (let i = 0; i < (t.rot / 90) % 4; i++) d = ROT_DIR[d];
  if (t.flipX && (d === 'left' || d === 'right')) d = d === 'left' ? 'right' : 'left';
  return d;
}

function mapPoint(x, y, t) {
  let p = [x, y];
  for (let i = 0; i < (t.rot / 90) % 4; i++) p = [1 - p[1], p[0]];
  if (t.flipX) p = [1 - p[0], p[1]];
  return p;
}

/**
 * Picks the transform that makes the most important part upright and unmirrored:
 * a part named like head/face if there is one, otherwise the largest part by area.
 * Returns { rot: 0|90|180|270, flipX: boolean, reason } (identity when already upright).
 */
export function chooseOrientation(parts) {
  const known = parts.filter((p) => p.up && p.up !== 'mixed');
  if (!known.length) return { rot: 0, flipX: false, reason: 'unknown' };
  const key = known.find((p) => /\b(head|face)\b/i.test(p.name)) ?? known[0];
  const rot = { up: 0, left: 90, down: 180, right: 270 }[key.up];
  return { rot, flipX: !!key.mirrored, reason: key.name };
}

export function isIdentity(t) {
  return !t || (t.rot % 360 === 0 && !t.flipX);
}

/** Parts as seen after transform T (bboxes and up directions remapped). */
export function transformParts(parts, t) {
  if (isIdentity(t)) return parts;
  return parts.map((p) => {
    const [x0, y0, x1, y1] = p.bbox.map((n) => n / 1000);
    const a = mapPoint(x0, y0, t);
    const b = mapPoint(x1, y1, t);
    const bbox = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])].map((n) =>
      Math.round(n * 1000),
    );
    return { ...p, bbox, up: mapDir(p.up, t), mirrored: t.flipX ? !p.mirrored : p.mirrored };
  });
}

const NAMED_ORIENTATIONS = {
  none: { rot: 0, flipX: false },
  rot90: { rot: 90, flipX: false },
  rot180: { rot: 180, flipX: false },
  rot270: { rot: 270, flipX: false },
  flipH: { rot: 0, flipX: true },
  flipV: { rot: 180, flipX: true }, // vertical mirror = 180° turn + horizontal mirror
};

/**
 * Resolves the orientation option: 'auto' (default, from the 3D data), 'none', a name
 * ('flipV', 'flipH', 'rot90', 'rot180', 'rot270') or an explicit { rot, flipX }.
 */
export function resolveOrientation(option, parts) {
  if (option === false) option = 'none';
  if (option == null || option === 'auto') return chooseOrientation(parts);
  if (typeof option === 'string') {
    const t = NAMED_ORIENTATIONS[option];
    if (!t) throw new Error(`Unknown orientation "${option}"`);
    return { ...t, reason: 'manual' };
  }
  return { rot: (((option.rot ?? 0) % 360) + 360) % 360, flipX: !!option.flipX, reason: 'manual' };
}
