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

function namesOf(mesh) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return [mesh.name, mesh.parent?.name, ...mats.map((m) => m?.name)].map(words).join(' | ');
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
 * Triangles of `slot` a vehicle reskin must keep: head and tail lights (by part name, or SAM's
 * "lights" zone) and tyre treads (wheel parts by name, or SAM's "wheels" zone).
 * @param {object} slot
 * @param {{ zones?: { zone: string, tris: Map<object, Uint8Array> }[] }} [o] SAM zones of this slot, if found.
 * @returns {{ tris: Map<object, Uint8Array>, headlights: number, treads: number } | null}
 */
export function vehicleKeepTriangles(slot, { zones = [] } = {}) {
  const tris = new Map();
  let headlights = 0,
    treads = 0;
  const add = (mesh, arr) => {
    const cur = tris.get(mesh);
    if (!cur) tris.set(mesh, arr);
    else for (let t = 0; t < arr.length; t++) if (arr[t]) cur[t] = 1;
  };
  for (const mesh of slot.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    if (!src || !mesh.geometry.getAttribute('position')) continue;
    const n = triangleCount(src);
    const name = namesOf(mesh);
    if (HEADLIGHT_NAME.test(name)) {
      add(mesh, new Uint8Array(n).fill(1));
      headlights += n;
      continue;
    }
    if (WHEEL_NAME.test(name)) {
      const tr = treadTriangles(mesh, src);
      const c = tr.reduce((s, v) => s + v, 0);
      if (c) {
        add(mesh, tr);
        treads += c;
      }
    }
  }
  for (const z of zones) {
    if (z.zone !== 'lights' && z.zone !== 'wheels') continue;
    for (const [mesh, use] of z.tris ?? []) {
      const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
      if (!src) continue;
      if (z.zone === 'lights') {
        add(mesh, Uint8Array.from(use));
        headlights += use.reduce((s, v) => s + v, 0);
      } else {
        const tr = treadTriangles(mesh, src, use);
        add(mesh, tr);
        treads += tr.reduce((s, v) => s + v, 0);
      }
    }
  }
  return headlights || treads ? { tris, headlights, treads } : null;
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
