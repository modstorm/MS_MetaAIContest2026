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
  /(head|front|fog|tail|rear|back|brake|stop|reverse|reversing|side|turn)\s*(light|lamp)s?|\b(head|tail)lamps?\b|\blights?\b|\blamps?\b|\b(high|low)\s*beam|\bindicators?\b|\bblinkers?\b|\boptics?\b/i;
/** A texture / material that holds only lights (an "Optics" atlas). */
const LIGHT_TEXTURE = /\b(optics?|lights?|lamps?|headlights?|taillights?)\b/i;
/** Mesh / material names that mean glass: windows, windscreen. */
export const GLASS_NAME = /\b(glass|windows?|windshield|windscreen|windscreens|sunroof|glazing)\b/i;

/** A see-through material (glass): transparent, or opacity / transmission set. */
export function isGlassMaterial(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.some((m) => m && ((m.transparent && (m.opacity ?? 1) < 0.95) || (m.transmission ?? 0) > 0.1));
}

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

/** Eigen decomposition of a symmetric 3×3 matrix (Jacobi). Returns { values, vectors (columns) }. */
function eigenSym3(m) {
  const a = m.map((r) => r.slice());
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-14) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1),
        s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p],
          akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k],
          aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p],
          vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]]) };
}

const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

/**
 * A wheel's own frame, in world space, whatever way it was imported (axle along X, Y, Z or
 * tilted, rotations baked into the nodes): `a` = axle, `u`, `v` = the wheel's plane, `c` =
 * centre, `size` = [along axle, along u, along v]. The axle is the odd one out of the shape's
 * three main directions (two are equal: the diameter). When the shape does not say (a cube),
 * the axis most faces point along is used.
 */
export function wheelFrame(g, use = null) {
  let wsum = 0;
  const mean = [0, 0, 0];
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    const w = g.area[t] || 1e-12;
    wsum += w;
    for (let k = 0; k < 3; k++) mean[k] += w * g.centroid[t * 3 + k];
  }
  if (!wsum) return null;
  for (let k = 0; k < 3; k++) mean[k] /= wsum;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    const w = g.area[t] || 1e-12;
    const d = [0, 1, 2].map((k) => g.centroid[t * 3 + k] - mean[k]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += (w * d[i] * d[j]) / wsum;
  }
  const { values, vectors } = eigenSym3(cov);
  let axis = -1,
    bestScore = Infinity;
  for (let k = 0; k < 3; k++) {
    const [i, j] = [0, 1, 2].filter((x) => x !== k);
    const big = Math.max(values[i], values[j]);
    if (!(big > 0)) continue;
    const score = Math.abs(values[i] - values[j]) / big;
    if (score < bestScore && values[k] < big * 0.72) {
      bestScore = score;
      axis = k;
    }
  }
  let a;
  if (axis >= 0 && bestScore < 0.35) a = vectors[axis];
  else {
    // Fallback: of the shape's own main directions, the one most faces point along (flat
    // sidewalls face along the axle). World axes are only tried when the shape has no main
    // directions at all (as round as a ball or a cube), so a tilted import gives the same answer.
    const lmax = Math.max(...values),
      lmin = Math.min(...values);
    const candidates = [...vectors];
    if (lmax > 0 && (lmax - lmin) / lmax < 0.2) candidates.push([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    let best = -1;
    a = candidates[0];
    for (const cand of candidates) {
      let share = 0;
      for (let t = 0; t < g.n; t++) {
        if (use && !use[t]) continue;
        const nd = Math.abs(g.normal[t * 3] * cand[0] + g.normal[t * 3 + 1] * cand[1] + g.normal[t * 3 + 2] * cand[2]);
        if (nd > 0.85) share += g.area[t];
      }
      if (share > best) {
        best = share;
        a = cand;
      }
    }
  }
  const len = Math.hypot(...a) || 1;
  a = a.map((x) => x / len);
  // u, v across the axle: the shape's other two main directions when the axle is one of them
  // (so a long body is measured along its length and width, however it is turned); else any.
  const ai = vectors.findIndex((e) => Math.abs(dot(e, a)) > 0.999);
  let u, v;
  if (ai >= 0) [u, v] = vectors.filter((_, k) => k !== ai);
  else {
    const helper = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    u = [a[1] * helper[2] - a[2] * helper[1], a[2] * helper[0] - a[0] * helper[2], a[0] * helper[1] - a[1] * helper[0]];
    const ul = Math.hypot(...u);
    u = u.map((x) => x / ul);
    v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  }
  // Extents and the box centre in this frame.
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  const axes = [a, u, v];
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    const p = [g.centroid[t * 3], g.centroid[t * 3 + 1], g.centroid[t * 3 + 2]];
    for (let k = 0; k < 3; k++) {
      const x = dot(p, axes[k]);
      if (x < lo[k]) lo[k] = x;
      if (x > hi[k]) hi[k] = x;
    }
  }
  const mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  const c = [0, 1, 2].map((k) => a[k] * mid[0] + u[k] * mid[1] + v[k] * mid[2]);
  return { a, u, v, c, size: [0, 1, 2].map((k) => Math.max(0, hi[k] - lo[k])) };
}

/**
 * Tread triangles of a wheel: faces pointing outward, across the axle (not along it), on the
 * outside of the wheel. `use` limits it to some triangles (a SAM wheel zone). Works in the
 * wheel's own frame, so the import direction does not matter.
 */
export function treadTriangles(mesh, src, use = null) {
  const g = triangleGeometry(mesh, src);
  const out = new Uint8Array(g.n);
  const f = wheelFrame(g, use);
  if (!f) return out;
  const [da, du, dv] = f.size;
  // One wheel: also require the outer ring (inner rim barrels face across the axle too).
  const single = du > 0 && dv > 0 && Math.max(du, dv) / Math.min(du, dv) < 1.4 && da < Math.min(du, dv);
  const radius = single ? Math.max(du, dv) / 2 : 0;
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    const n = [g.normal[t * 3], g.normal[t * 3 + 1], g.normal[t * 3 + 2]];
    if (Math.abs(dot(n, f.a)) > 0.45) continue; // sidewall / rim face
    if (single) {
      const d = [0, 1, 2].map((k) => g.centroid[t * 3 + k] - f.c[k]);
      const x = dot(d, f.u),
        y = dot(d, f.v);
      if (Math.hypot(x, y) < radius * 0.7) continue; // inside the rim
      // The face must point away from the wheel's center (outward), not into it.
      if (x * dot(n, f.u) + y * dot(n, f.v) <= 0) continue;
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
  const f = wheelFrame(g, use);
  if (!f) return false;
  const [da, du, dv] = f.size;
  if (!(du > 0 && dv > 0 && Math.max(du, dv) / Math.min(du, dv) < 1.4 && da <= Math.min(du, dv))) return false;
  // Round all the way: the outer ring must go around the axle (a wheel arch or a patch only
  // covers part of the circle). At least 9 of 12 sectors around the centre must be filled.
  const R = Math.max(du, dv) / 2;
  const sectors = new Set();
  for (let t = 0; t < g.n; t++) {
    if (use && !use[t]) continue;
    const d = [0, 1, 2].map((k) => g.centroid[t * 3 + k] - f.c[k]);
    const x = dot(d, f.u),
      y = dot(d, f.v);
    if (Math.hypot(x, y) < R * 0.5) continue;
    sectors.add(Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * 12) % 12);
  }
  return sectors.size >= 9;
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
export function vehicleKeepTriangles(
  slot,
  {
    zones = [],
    maxLightShare = 0.2,
    maxGlassShare = 0.4,
    roles = null,
    zoneRoles = null,
    glassOnly = false,
    userKeep = [],
  } = {},
) {
  let glass = 0,
    user = 0;
  const userMatch = (text) => userKeep.find((k) => k.re.test(text));
  const decisions = [];
  let arches = false;
  const tris = new Map();
  const lights = new Map();
  // Kept areas found by SAM (its "headlight" zone, wheel arches): any shade of the old body
  // paint in them is body, not a lens (a mirror SAM took for a headlight).
  const soft = new Map();
  // SAM's windows zone: kept, but SAM often takes the side mirrors (body paint) for windows, so
  // old body paint in it gets the new paint like in a lights zone.
  const samGlass = new Map();
  const rejected = [];
  let headlights = 0,
    treads = 0;
  const merge = (map, mesh, arr) => {
    const cur = map.get(mesh);
    if (!cur) map.set(mesh, Uint8Array.from(arr));
    else for (let t = 0; t < arr.length; t++) if (arr[t]) cur[t] = 1;
  };
  const add = (mesh, arr, isLight = false, fromSam = false) => {
    merge(tris, mesh, arr);
    if (isLight) merge(lights, mesh, arr);
    if (fromSam) merge(soft, mesh, arr);
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
    // The user's own "don't paint the X" (userRules): a part named like X is kept whole.
    const uk = userMatch(name);
    if (uk) {
      if (meshArea(mesh, src) / (total || 1) > maxGlassShare)
        rejected.push({ name: label(mesh), reason: `user rule "${uk.noun}": too big to keep, so it is painted` });
      else {
        add(mesh, new Uint8Array(n).fill(1));
        user += n;
        decisions.push({ name: label(mesh), role: `kept (user rule: ${uk.noun})`, source: 'user rule' });
        continue;
      }
    }
    const role = museRole
      ? museRole === 'tyre'
        ? 'wheel'
        : museRole
      : HEADLIGHT_NAME.test(name)
        ? 'light'
        : WHEEL_NAME.test(name)
          ? 'wheel'
          : GLASS_NAME.test(name)
            ? 'glass'
            : isGlassMaterial(mesh)
              ? 'glass'
              : null;
    const source = museRole ? 'Muse' : GLASS_NAME.test(name) || role !== 'glass' ? 'name' : 'material';
    if (role === 'glass') {
      // Glass is never painted (Kris): the whole part keeps its original pixels. A "glass" part
      // that is most of the texture is not glass (a wrong label), so it is painted.
      if (slot.meshes.length > 1 && meshArea(mesh, src) / (total || 1) > maxGlassShare) {
        rejected.push({
          name: label(mesh),
          reason: `${source} says glass but it is too big to be the windows, so it is painted`,
        });
        continue;
      }
      add(mesh, new Uint8Array(n).fill(1));
      glass += n;
      decisions.push({ name: label(mesh), role: 'glass (kept)', source });
      continue;
    }
    if (glassOnly) continue; // not a vehicle: only glass (and the user's rules) is kept
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
    const uz = userKeep.find((k) => z.zone === `keep: ${k.noun}`) ?? userMatch(z.zone);
    // "Don't paint the windows": a windows zone goes through the glass rule below, which keeps
    // the glass but paints old body paint SAM put in it (the side mirrors).
    if (uz && !GLASS_NAME.test(z.zone)) {
      let a = 0;
      for (const [mesh, use] of z.tris ?? []) {
        const src = srcs.get(mesh);
        if (src) a += meshArea(mesh, src, use);
      }
      if (total > 0 && a / total > maxGlassShare) {
        rejected.push({
          name: `SAM ${z.zone} zone`,
          reason: `user rule "${uz.noun}": too big to keep, so it is painted`,
        });
        continue;
      }
      for (const [mesh, use] of z.tris ?? []) {
        if (!srcs.get(mesh)) continue;
        add(mesh, use);
        user += use.reduce((s, v) => s + v, 0);
      }
      decisions.push({ name: `SAM ${z.zone} zone`, role: `kept (user rule: ${uz.noun})`, source: 'user rule + SAM' });
      continue;
    }
    if ((z.zone === 'windows' || GLASS_NAME.test(z.zone)) && (!zoneRoles?.[z.zone] || zoneRoles[z.zone] === 'glass')) {
      // SAM's windows zone: glass, never painted. Too big to be windows = SAM got it wrong.
      let a = 0;
      for (const [mesh, use] of z.tris ?? []) {
        const src = srcs.get(mesh);
        if (src) a += meshArea(mesh, src, use);
      }
      if (total > 0 && a / total > maxGlassShare) {
        rejected.push({ name: 'SAM windows zone', reason: 'too big to be the windows, so it is painted' });
        continue;
      }
      for (const [mesh, use] of z.tris ?? []) {
        if (!srcs.get(mesh)) continue;
        add(mesh, use);
        merge(samGlass, mesh, use);
        glass += use.reduce((s, v) => s + v, 0);
      }
      decisions.push({
        name: 'SAM windows zone',
        role: 'glass (kept)',
        source: zoneRoles?.[z.zone] ? 'Muse + SAM' : 'SAM',
      });
      continue;
    }
    if (glassOnly) continue;
    if (z.zone === 'wheel arches') {
      // Kept like lights: original pixels back, old body paint replaced by the new body paint.
      for (const [mesh, use] of z.tris ?? []) {
        if (!srcs.get(mesh)) continue;
        add(mesh, use, true, true);
      }
      decisions.push({ name: 'SAM wheel arches zone', role: 'wheel arch (kept)', source: 'SAM + shape check' });
      arches = true;
      continue;
    }
    if (z.zone !== 'lights' && z.zone !== 'wheels' && zoneRoles?.[z.zone] !== 'light') continue;
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
        // Muse looked at the renders and says light: kept at any size when the texture is named
        // for lights (an "Optics" atlas) or the zone is not most of the texture.
        const museSure = museZ === 'light' && (LIGHT_TEXTURE.test(namesOf(mesh)) || (z.share ?? 1) <= 0.5);
        // Already kept as a light by its own name (an "Optics" texture): nothing to reject.
        const already = lights.get(mesh);
        if (already && use.every((v, t) => !v || already[t])) continue;
        if (!museSure && tooBig(mesh, src, use)) {
          rejected.push({ name: 'SAM lights zone', reason: 'too big to be lights, so it is painted' });
          continue;
        }
        add(mesh, use, true, true);
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
  if (!headlights && !treads && !arches && !glass && !user)
    return rejected.length || decisions.length
      ? { tris, lights, soft, samGlass, headlights, treads, glass, user, rejected, decisions, none: true }
      : null;
  return { tris, lights, soft, samGlass, headlights, treads, glass, user, rejected, decisions };
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
  // Buckets by hue for colorful pixels (so a shaded body paint, light to dark, is one color)
  // and by brightness for greys.
  const count = new Uint32Array(40);
  const sum = new Float64Array(40 * 3);
  const n = rgba.length / 4;
  for (let p = 0; p < n; p++) {
    if (!inside(p)) continue;
    const i = p * 4;
    const b = colorBucket(rgba[i], rgba[i + 1], rgba[i + 2]);
    count[b]++;
    sum[b * 3] += rgba[i];
    sum[b * 3 + 1] += rgba[i + 1];
    sum[b * 3 + 2] += rgba[i + 2];
  }
  let best = -1;
  for (let b = 0; b < 40; b++) if (count[b] && (best < 0 || count[b] > count[best])) best = b;
  if (best < 0) return null;
  return [0, 1, 2].map((k) => sum[best * 3 + k] / count[best]);
}

function hsv(r, g, b) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [h * 60, mx ? d / mx : 0, mx / 255];
}

/** 0..31 = hue bins of colorful pixels, 32..39 = grey levels. */
function colorBucket(r, g, b) {
  const [h, s, v] = hsv(r, g, b);
  if (s >= 0.35 && v >= 0.15) return Math.floor(h / 11.25) % 32;
  return 32 + Math.min(7, Math.floor(v * 8));
}

/**
 * Same paint as `color` in another shade: for a colorful paint, the same hue (within 20°) and
 * clearly colorful; otherwise within `tol` in RGB.
 */
export function sameShade(r, g, b, color, tol = 64) {
  if (nearColor(r, g, b, color, tol)) return true;
  const [h0, s0] = hsv(color[0], color[1], color[2]);
  if (s0 < 0.35) return false;
  const [h, s, v] = hsv(r, g, b);
  const dh = Math.min(Math.abs(h - h0), 360 - Math.abs(h - h0));
  return s >= 0.35 && v >= 0.12 && dh <= 20;
}

/**
 * sameShade, but also about as saturated as the body paint: a tinted window (dark blue-grey) is
 * not a shade of a blue body, a side mirror in shadow is.
 */
export function sameStrongShade(r, g, b, color, tol = 64) {
  if (nearColor(r, g, b, color, tol)) return true;
  if (!sameShade(r, g, b, color, tol)) return false;
  const [, s0] = hsv(color[0], color[1], color[2]);
  const [, s] = hsv(r, g, b);
  return s >= 0.7 * s0;
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

/** True for a clearly colored paint (red, blue…), false for white, grey, silver or black. */
export function isColorful(color) {
  if (!color) return false;
  const mx = Math.max(...color),
    mn = Math.min(...color);
  return mx > 0 && (mx - mn) / mx >= 0.35 && mx >= 40;
}

/**
 * Cleans the paint in and right around kept lights. Muse tends to paint splashes, rings and
 * strokes around a light it was told to leave alone, and the old body paint inside a light
 * area (a lens ring, a fog light housing) must get the new paint, not a pattern from elsewhere.
 * Both get the new paint found right next to that light (the median of the painted pixels
 * 1..3 ring widths away), shaded by the original's light and dark.
 *
 * Changes `painted` in place. Call it after the original pixels were put back on kept pixels,
 * with `before` = the painted pixels as Muse returned them (for the surrounding color).
 * @param {{ W: number, H: number, painted: Uint8ClampedArray, before: Uint8ClampedArray,
 *   orig: Uint8ClampedArray, light: Uint8Array, kept: Uint8Array, cover: Uint8Array,
 *   body: number[], bodyInside: (i: number) => boolean, bodyAround: (i: number) => boolean,
 *   ring?: number, fallback?: Uint8ClampedArray, ringFrom?: Uint8Array }} o  light/kept/cover: 1 per pixel; i = rgba
 *   index; fallback: new body paint (rgba) for old body paint inside a light with no painted
 *   surface next to it (a light that is its own UV island)
 * @returns {{ inside: number, around: number, lights: number }} pixels changed, light spots
 */
export function cleanAroundLights(o) {
  const { W, H, painted, before, orig, light, kept, cover, body, bodyInside, bodyAround, fallback } = o;
  const ringFrom = o.ringFrom ?? light; // spots whose surroundings are cleaned (not windows)
  const R = Math.max(2, o.ring ?? Math.round(W / 128));
  const N = W * H;
  const dist = new Int16Array(N).fill(-1);
  const comp = new Int32Array(N).fill(-1);
  // Light spots: 4-connected parts of the light mask.
  let spots = 0;
  const queue = new Int32Array(N);
  for (let p = 0; p < N; p++) {
    if (!light[p] || comp[p] >= 0) continue;
    let h = 0,
      t = 0;
    queue[t++] = p;
    comp[p] = spots;
    dist[p] = 0;
    while (h < t) {
      const q = queue[h++];
      const x = q % W,
        y = (q - x) / W;
      for (const n of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1])
        if (n >= 0 && light[n] && comp[n] < 0) {
          comp[n] = spots;
          dist[n] = 0;
          queue[t++] = n;
        }
    }
    spots++;
  }
  if (!spots) return { inside: 0, around: 0, lights: 0 };
  const ringSpot = new Uint8Array(spots);
  for (let p = 0; p < N; p++) if (ringFrom[p] && comp[p] >= 0) ringSpot[comp[p]] = 1;
  // Grow outwards (inside the texture's islands, not over other kept pixels), up to 3 rings.
  let h = 0,
    t = 0;
  for (let p = 0; p < N; p++) if (light[p]) queue[t++] = p;
  while (h < t) {
    const q = queue[h++];
    if (dist[q] >= 3 * R) continue;
    const x = q % W,
      y = (q - x) / W;
    for (const n of [x > 0 ? q - 1 : -1, x < W - 1 ? q + 1 : -1, y > 0 ? q - W : -1, y < H - 1 ? q + W : -1])
      if (n >= 0 && dist[n] < 0 && cover[n] && !kept[n]) {
        dist[n] = dist[q] + 1;
        comp[n] = comp[q];
        queue[t++] = n;
      }
  }
  // The new paint next to each light: per-channel median of the outer rings.
  const samples = Array.from({ length: spots }, () => [[], [], []]);
  for (let p = 0; p < N; p++) {
    if (dist[p] <= R || light[p]) continue;
    const s = samples[comp[p]];
    if (s[0].length >= 4000) continue;
    const i = p * 4;
    s[0].push(before[i]);
    s[1].push(before[i + 1]);
    s[2].push(before[i + 2]);
  }
  const median = (a) => {
    a.sort((u, v) => u - v);
    return a[a.length >> 1];
  };
  const local = samples.map((s) => (s[0].length >= 6 ? s.map(median) : null));
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const bodyLum = lum(body[0], body[1], body[2]);
  let inside = 0,
    around = 0;
  for (let p = 0; p < N; p++) {
    const d = dist[p];
    if (d < 0 || d > R) continue;
    const i = p * 4;
    const c = local[comp[p]];
    if (!c) {
      if (d === 0 && fallback && bodyInside(i)) {
        painted[i] = fallback[i];
        painted[i + 1] = fallback[i + 1];
        painted[i + 2] = fallback[i + 2];
        inside++;
      }
      continue;
    }
    if (d === 0 ? !bodyInside(i) : !ringSpot[comp[p]] || !bodyAround(i)) continue;
    const shade = bodyLum < 24 ? 1 : Math.min(1.2, Math.max(0.6, lum(orig[i], orig[i + 1], orig[i + 2]) / bodyLum));
    painted[i] = Math.min(255, c[0] * shade);
    painted[i + 1] = Math.min(255, c[1] * shade);
    painted[i + 2] = Math.min(255, c[2] * shade);
    if (d === 0) inside++;
    else around++;
  }
  return { inside, around, lights: spots };
}

const KEEP_VERB =
  /\b(?:do\s*not|don'?t|never|no|avoid|without|stop)\s+(?:paint(?:ing)?|touch(?:ing)?|chang(?:e|ing)|recolou?r(?:ing)?|colou?r(?:ing)?|draw(?:ing)?|cover(?:ing)?)\s+(?:anything\s+)?(?:on|over|onto|in|across)?\s*(?:the|any|a|my)?\s*([a-z][a-z\s,/&-]*)/gi;
const KEEP_AS_IS =
  /\b(?:keep|leave)\s+(?:the|all|any|my)?\s*([a-z][a-z\s,/&-]*?)\s+(?:original|clean|untouched|unpainted|alone|as\s+(?:it|they)\s+(?:is|are|were|was))\b/gi;
const STOP_WORDS = new Set([
  'it',
  'them',
  'that',
  'this',
  'anything',
  'everything',
  'model',
  'thing',
  'things',
  'stuff',
]);

/**
 * What the user's rules (userRules) say must not be painted: "don't paint on the windows",
 * "never touch the badge", "keep the grille original". Returns [{ noun, re }] where `re`
 * matches a part or zone name for that noun (singular or plural). Glass words are left in:
 * glass is matched like any noun (and is never painted anyway).
 * @param {string[]} rules
 */
export function keepTargetsFromRules(rules = []) {
  const out = new Map();
  for (const rule of rules ?? []) {
    const text = String(rule ?? '');
    for (const rx of [KEEP_VERB, KEEP_AS_IS]) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(text))) {
        // The phrase ends at a clause break ("…windows, and make it blue").
        const phrase = m[1].split(
          /\b(?:and\s+(?:make|paint|use|give|add|keep|do)|but|because|please|even|with|in\s+the\s+theme|red|blue|green|black|white|yellow|orange|pink|purple|gold|silver)\b/i,
        )[0];
        for (let noun of phrase.split(/,|\/|&|\bor\b|\band\b/i)) {
          noun = noun
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/^(?:the|a|an|any|all|my|its|their)\s+/, '');
          if (/^(?:make|paint|use|give|add|keep|turn|change|put|do|let|it)\b/.test(noun)) continue;
          if (!noun || STOP_WORDS.has(noun) || noun.split(' ').length > 3) continue;
          const stem = noun.endsWith('ss') ? noun : noun.replace(/s$/, '');
          const words = stem
            .split(' ')
            .map((w) => w.replace(/[^a-z0-9-]/g, ''))
            .filter(Boolean);
          if (!words.length) continue;
          const re = new RegExp(`(?<![a-z])${words.join('[\\s_-]*')}(?:e?s)?(?![a-z])`, 'i');
          out.set(noun, { noun, re });
        }
      }
    }
  }
  return [...out.values()];
}

/**
 * True when every mesh of `slot` is glass: named so (Glass, Windows…), see-through, or
 * labelled glass by Muse (`roles`: Map mesh → role). Such a texture slot is never painted.
 */
export function slotIsGlass(slot, roles = null) {
  return (
    slot.meshes.length > 0 &&
    slot.meshes.every((m) => {
      const r = roles?.get(m);
      if (r) return r === 'glass';
      return GLASS_NAME.test(namesOf(m)) || isGlassMaterial(m);
    })
  );
}
