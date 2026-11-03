import * as THREE from 'three';
import { uvSourceOf } from './textureLayout.js';
import { islandIdPerTriangle, triangleCount } from './uvIslands.js';

/**
 * Areas a reskin must never change, found from the 3D model. Vehicles: the lights (head and
 * tail lights) and
 * the tyre treads (the rubber running surface) keep their original pixels; tyre sidewalls
 * and rims are painted. The plugin puts the original pixels back inside these triangles
 * after every paint, in both paint modes, so the rule holds whatever the image model does.
 */

/** Mesh / material names that mean a vehicle light: headlights and taillights (also brake,
 * fog, reverse lights and indicators). "light" / "lamp" alone count too. */
export const HEADLIGHT_NAME =
  /(head|front|fog|tail|rear|back|brake|stop|reverse|reversing|side|turn)\s*(light|lamp)s?|\b(head|tail)lamps?\b|\blights?\b|\blamps?\b|\b(high|low)\s*beam|\bindicators?\b|\bblinkers?\b/i;
/** Mesh / material names that mean a wheel or tyre. */
export const WHEEL_NAME = /\b(wheels?|tires?|tyres?|treads?)\b/i;

const words = (s) =>
  String(s ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\d]+/g, ' ');

/** A mesh name that says nothing about the part (then its parent's name is used). */
const GENERIC_NAME = /^\s*(mesh|object|primitive|node|geometry|group)?[\s_\-.\d]*$/i;

/**
 * Names that say what a mesh is: its own name and material names. The parent's name only
 * counts when the mesh has no name of its own (a glTF mesh split into primitives), never
 * for a named mesh: an editor may group a whole car under "car + wheel", and that must not
 * make the body a wheel.
 */
export function namesOf(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const own = GENERIC_NAME.test(mesh.name ?? '') ? mesh.parent?.name : mesh.name;
  return [own, ...mats.map((m) => m?.name)].map(words).join(' | ');
}

function vertexIndex(src, t, k) {
  return src.index ? src.index[t * 3 + k] : t * 3 + k;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/** World-space unit normal, centroid and area of each triangle. */
function triangleGeometry(mesh, src) {
  const pos = mesh.geometry.getAttribute('position');
  const n = triangleCount(src);
  const normal = new Float32Array(n * 3);
  const centroid = new Float32Array(n * 3);
  const area = new Float32Array(n);
  mesh.updateWorldMatrix(true, false);
  const m = mesh.matrixWorld;
  for (let t = 0; t < n; t++) {
    _a.fromBufferAttribute(pos, vertexIndex(src, t, 0)).applyMatrix4(m);
    _b.fromBufferAttribute(pos, vertexIndex(src, t, 1)).applyMatrix4(m);
    _c.fromBufferAttribute(pos, vertexIndex(src, t, 2)).applyMatrix4(m);
    for (let k = 0; k < 3; k++)
      centroid[t * 3 + k] = (_a.getComponent(k) + _b.getComponent(k) + _c.getComponent(k)) / 3;
    _b.sub(_a);
    _c.sub(_a);
    _b.cross(_c);
    const len = _b.length();
    area[t] = len / 2;
    if (len > 0) for (let k = 0; k < 3; k++) normal[t * 3 + k] = _b.getComponent(k) / len;
  }
  return { normal, centroid, area, n };
}

/**
 * The axle direction of a wheel (0 = X, 1 = Y, 2 = Z): the axis the most surface faces along
 * (the flat sidewalls and rim face sideways along the axle).
 */
function axleAxis(g, use) {
  const share = [0, 0, 0];
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    for (let k = 0; k < 3; k++) if (Math.abs(g.normal[t * 3 + k]) > 0.85) share[k] += g.area[t];
  }
  return share.indexOf(Math.max(...share));
}

/**
 * Tread triangles of a wheel: faces pointing outward, across the axle (not along it), on the
 * outside of the wheel. `use` limits it to some triangles (a SAM wheel zone).
 */
export function treadTriangles(mesh, src, use = null) {
  const g = triangleGeometry(mesh, src);
  const axis = axleAxis(g, use);
  const out = new Uint8Array(g.n);
  // One wheel per mesh: also require the outer ring (inner rim barrels face across the axle too).
  const box = new THREE.Box3();
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    box.expandByPoint(_a.set(g.centroid[t * 3], g.centroid[t * 3 + 1], g.centroid[t * 3 + 2]));
  }
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const others = [0, 1, 2].filter((k) => k !== axis);
  const d0 = size.getComponent(others[0]),
    d1 = size.getComponent(others[1]);
  const single =
    d0 > 0 && d1 > 0 && Math.max(d0, d1) / Math.min(d0, d1) < 1.4 && size.getComponent(axis) < Math.min(d0, d1);
  const radius = single ? Math.max(d0, d1) / 2 : 0;
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    if (Math.abs(g.normal[t * 3 + axis]) > 0.45) continue; // sidewall / rim face
    if (single) {
      const r = Math.hypot(
        g.centroid[t * 3 + others[0]] - center.getComponent(others[0]),
        g.centroid[t * 3 + others[1]] - center.getComponent(others[1]),
      );
      if (r < radius * 0.7) continue; // inside the rim
      // The face must point away from the wheel's center (outward), not into it.
      const ox = g.centroid[t * 3 + others[0]] - center.getComponent(others[0]);
      const oy = g.centroid[t * 3 + others[1]] - center.getComponent(others[1]);
      if (ox * g.normal[t * 3 + others[0]] + oy * g.normal[t * 3 + others[1]] <= 0) continue;
    }
    out[t] = 1;
  }
  return out;
}

/**
 * Connected pieces of a mesh (triangles sharing a vertex position), limited to `use`.
 * @returns {{ use: Uint8Array, count: number }[]} biggest first
 */
export function meshPieces(mesh, src, use = null) {
  const pos = mesh.geometry.getAttribute('position');
  const n = triangleCount(src);
  mesh.geometry.computeBoundingBox?.();
  const bb = mesh.geometry.boundingBox;
  const q = Math.max(1e-6, (bb ? bb.max.distanceTo(bb.min) : 1) * 1e-4);
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const seen = new Map();
  for (let t = 0; t < n; t++) {
    if (use && !use[t]) continue;
    for (let k = 0; k < 3; k++) {
      const v = vertexIndex(src, t, k);
      const key = `${Math.round(pos.getX(v) / q)},${Math.round(pos.getY(v) / q)},${Math.round(pos.getZ(v) / q)}`;
      const o = seen.get(key);
      if (o === undefined) seen.set(key, t);
      else {
        const a = find(o),
          b = find(t);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map();
  for (let t = 0; t < n; t++) {
    if (use && !use[t]) continue;
    const r = find(t);
    let gp = groups.get(r);
    if (!gp) groups.set(r, (gp = { use: new Uint8Array(n), count: 0 }));
    gp.use[t] = 1;
    gp.count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/**
 * Is this piece shaped like a wheel: round across its axle (the two other sides within 1.4×
 * of each other) and thinner along the axle than across?
 */
export function isWheelShaped(mesh, src, use = null) {
  const g = triangleGeometry(mesh, src);
  const axis = axleAxis(g, use);
  const box = new THREE.Box3();
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    box.expandByPoint(_a.set(g.centroid[t * 3], g.centroid[t * 3 + 1], g.centroid[t * 3 + 2]));
  }
  const size = box.getSize(new THREE.Vector3());
  const others = [0, 1, 2].filter((k) => k !== axis);
  const d0 = size.getComponent(others[0]),
    d1 = size.getComponent(others[1]);
  return d0 > 0 && d1 > 0 && Math.max(d0, d1) / Math.min(d0, d1) < 1.4 && size.getComponent(axis) <= Math.min(d0, d1);
}

/**
 * Tread triangles of the wheel-shaped pieces of `mesh` (each piece is one wheel or tyre),
 * limited to `use`. Pieces that are not round (a car body, a wheel arch) are skipped.
 * @returns {{ tris: Uint8Array, count: number, wheels: number, skipped: number }}
 */
export function wheelTreads(mesh, src, use = null) {
  const n = triangleCount(src);
  const tris = new Uint8Array(n);
  let wheels = 0,
    skipped = 0,
    count = 0;
  const pieces = meshPieces(mesh, src, use);
  const minCount = Math.max(8, (pieces[0]?.count ?? 0) * 0.05);
  for (const piece of pieces) {
    if (piece.count < minCount) continue; // bolts, valve caps
    if (!isWheelShaped(mesh, src, piece.use)) {
      skipped++;
      continue;
    }
    wheels++;
    const tr = treadTriangles(mesh, src, piece.use);
    for (let t = 0; t < n; t++)
      if (tr[t]) {
        tris[t] = 1;
        count++;
      }
  }
  return { tris, count, wheels, skipped };
}

/** Total world-space area of a mesh's triangles (only `use` ones when given). */
function meshArea(mesh, src, use = null) {
  const g = triangleGeometry(mesh, src);
  let a = 0;
  for (let t = 0; t < g.n; t++) if (!use || use[t]) a += g.area[t];
  return a;
}

/**
 * Triangles of `slot` a vehicle reskin must keep: head and tail lights (by part name, or SAM's
 * "lights" zone) and tyre treads (wheel parts by name, or SAM's "wheels" zone).
 * Cross-checks: a name or zone alone is not enough. A "wheel" must be shaped like a wheel
 * (round, thin along its axle), piece by piece, and a "light" must be small (under
 * `maxLightShare` of the texture's surface). Anything rejected is painted, and listed in
 * `rejected` with the reason.
 * @param {object} slot
 * @param {{ zones?: { zone: string, tris: Map<object, Uint8Array> }[], maxLightShare?: number }} [o]
 * @returns {{ tris: Map<object, Uint8Array>, lights: Map<object, Uint8Array>, headlights: number, treads: number, rejected: { name: string, reason: string }[] } | null}
 *   `tris` = everything kept, `lights` = the light part of it.
 */
export function vehicleKeepTriangles(slot, { zones = [], maxLightShare = 0.2, roles = null, zoneRoles = null } = {}) {
  const decisions = [];
  const tris = new Map();
  const lights = new Map();
  const rejected = [];
  let headlights = 0,
    treads = 0;
  const merge = (map, mesh, arr) => {
    const cur = map.get(mesh);
    if (!cur) map.set(mesh, Uint8Array.from(arr));
    else for (let t = 0; t < arr.length; t++) if (arr[t]) cur[t] = 1;
  };
  const add = (mesh, arr, isLight = false) => {
    merge(tris, mesh, arr);
    if (isLight) merge(lights, mesh, arr);
  };
  let total = 0;
  const srcs = new Map();
  for (const mesh of slot.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    if (!src || !mesh.geometry.getAttribute('position')) continue;
    srcs.set(mesh, src);
    total += meshArea(mesh, src);
  }
  const tooBig = (mesh, src, use) => total > 0 && meshArea(mesh, src, use) / total > maxLightShare;
  const label = (mesh) => mesh.name || mesh.parent?.name || 'mesh';
  for (const [mesh, src] of srcs) {
    const n = triangleCount(src);
    // Muse's reading of the renders (roles) first; the mesh / material name only as a fallback.
    const museRole = roles?.get(mesh);
    const name = namesOf(mesh);
    const role = museRole
      ? museRole === 'tyre'
        ? 'wheel'
        : museRole
      : HEADLIGHT_NAME.test(name)
        ? 'light'
        : WHEEL_NAME.test(name)
          ? 'wheel'
          : null;
    const source = museRole ? 'Muse' : 'name';
    if (role === 'light') {
      if (slot.meshes.length > 1 && tooBig(mesh, src)) {
        rejected.push({
          name: label(mesh),
          reason: `${source} says light but it is too big to be one, so it is painted`,
        });
        continue;
      }
      add(mesh, new Uint8Array(n).fill(1), true);
      headlights += n;
      decisions.push({ name: label(mesh), role: 'light', source });
    } else if (role === 'wheel') {
      const w = wheelTreads(mesh, src);
      if (w.count) {
        add(mesh, w.tris);
        treads += w.count;
        decisions.push({ name: label(mesh), role: 'wheel', source, wheels: w.wheels });
      }
      if (!w.wheels)
        rejected.push({
          name: label(mesh),
          reason: `${source} says wheel but it is not shaped like one, so it is painted`,
        });
    } else if (museRole) {
      // Muse says it is not a light or wheel (body, glass, trim…): painted. When the name said
      // otherwise, Muse wins.
      const over = HEADLIGHT_NAME.test(name) || WHEEL_NAME.test(name);
      decisions.push({ name: label(mesh), role: museRole, source: over ? 'Muse (over its name)' : 'Muse' });
    }
  }
  for (const z of zones) {
    if (z.zone !== 'lights' && z.zone !== 'wheels') continue;
    // Muse's role for this zone (it sees the zones as the parts of the model) wins over the
    // zone's name.
    const museZ = zoneRoles?.[z.zone];
    if (museZ && !['light', 'wheel', 'tyre'].includes(museZ)) {
      decisions.push({ name: `SAM ${z.zone} zone`, role: museZ, source: 'Muse (over the zone name)' });
      continue;
    }
    const kind = museZ ? (museZ === 'light' ? 'lights' : 'wheels') : z.zone;
    const source = museZ ? 'Muse + SAM' : 'SAM';
    for (const [mesh, use] of z.tris ?? []) {
      const src = srcs.get(mesh);
      if (!src) continue;
      if (kind === 'lights') {
        if (tooBig(mesh, src, use)) {
          rejected.push({ name: 'SAM lights zone', reason: 'too big to be lights, so it is painted' });
          continue;
        }
        add(mesh, use, true);
        headlights += use.reduce((s, v) => s + v, 0);
        decisions.push({ name: `SAM ${z.zone} zone`, role: 'light', source });
      } else {
        const w = wheelTreads(mesh, src, use);
        if (w.count) {
          add(mesh, w.tris);
          treads += w.count;
          decisions.push({ name: `SAM ${z.zone} zone`, role: 'wheel', source, wheels: w.wheels });
        }
        if (!w.wheels && w.skipped)
          rejected.push({
            name: 'SAM wheels zone',
            reason: 'no wheel-shaped piece in it (wheel arches?), so it is painted',
          });
      }
    }
  }
  if (!headlights && !treads)
    return rejected.length || decisions.length
      ? { tris, lights, headlights, treads, rejected, decisions, none: true }
      : null;
  return { tris, lights, headlights, treads, rejected, decisions };
}

/** Share (0..1) of a paint area's triangles that are in `keep` (Map mesh → Uint8Array). */
export function keptShare(slot, part, keep) {
  let all = 0,
    kept = 0;
  for (const mesh of part.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    if (!src) continue;
    const isl = part.islands?.get(mesh);
    const islandOf = isl ? islandIdPerTriangle(src) : null;
    const tri = part.tris?.get(mesh);
    if ((part.islands && !isl) || (part.tris && !tri)) continue;
    const k = keep.get(mesh);
    const n = triangleCount(src);
    for (let t = 0; t < n; t++) {
      if (isl && !isl.has(islandOf[t])) continue;
      if (tri && !tri[t]) continue;
      all++;
      if (k?.[t]) kept++;
    }
  }
  return all ? kept / all : 0;
}

/**
 * Most common color (4 bits per channel buckets, averaged) of `rgba` where `inside(p)` is
 * true. On a vehicle atlas this is the original body paint. null when nothing is inside.
 * @param {Uint8ClampedArray} rgba
 * @param {(p: number) => boolean} inside pixel index → counted
 */
export function dominantColor(rgba, inside) {
  const count = new Uint32Array(4096);
  const sum = new Float64Array(4096 * 3);
  const n = rgba.length / 4;
  for (let p = 0; p < n; p++) {
    if (!inside(p)) continue;
    const i = p * 4;
    const b = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    count[b]++;
    sum[b * 3] += rgba[i];
    sum[b * 3 + 1] += rgba[i + 1];
    sum[b * 3 + 2] += rgba[i + 2];
  }
  let best = -1;
  for (let b = 0; b < 4096; b++) if (count[b] && (best < 0 || count[b] > count[best])) best = b;
  if (best < 0) return null;
  return [0, 1, 2].map((k) => sum[best * 3 + k] / count[best]);
}

/** True when (r, g, b) is within `tol` (RGB distance) of `color`. */
export function nearColor(r, g, b, color, tol = 64) {
  const dr = r - color[0],
    dg = g - color[1],
    db = b - color[2];
  return dr * dr + dg * dg + db * db <= tol * tol;
}

/**
 * The square (side `size`) of a W×H map with the most `on` pixels, searched on a coarse
 * grid. Used to cut a swatch of the newly painted body. Returns { x, y, size, share }.
 * @param {Uint8Array} on 1 per pixel that counts
 */
export function bestSquare(on, W, H, size) {
  size = Math.max(4, Math.min(size, W, H));
  // Summed-area table for O(1) window counts.
  const S = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += on[y * W + x];
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row;
    }
  }
  const step = Math.max(1, Math.round(size / 4));
  let best = { x: 0, y: 0, size, share: -1 };
  for (let y = 0; y + size <= H; y += step)
    for (let x = 0; x + size <= W; x += step) {
      const c =
        S[(y + size) * (W + 1) + x + size] -
        S[y * (W + 1) + x + size] -
        S[(y + size) * (W + 1) + x] +
        S[y * (W + 1) + x];
      const share = c / (size * size);
      if (share > best.share) best = { x, y, size, share };
    }
  return best;
}

/** True when a zone ({ tris: Map mesh → Uint8Array }) holds at least one wheel-shaped piece. */
export function zoneHasWheel(slot, zone) {
  for (const [mesh, use] of zone.tris ?? []) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    if (!src || !mesh.geometry.getAttribute('position')) continue;
    if (wheelTreads(mesh, src, use).wheels) return true;
  }
  return false;
}
