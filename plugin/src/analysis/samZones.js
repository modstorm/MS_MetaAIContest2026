/**
 * Paint zones found by SAM 3.1, for models with no profile and no known body layout.
 *
 *   1. The model is rendered from the six axis directions (renderViews.js), and the same
 *      views are rasterized on the CPU as a triangle-ID buffer: for every pixel, which
 *      triangle of which mesh is in front.
 *   2. The six renders go to SAM 3.1 as ONE image per noun phrase ("face", "hand", "wheel"),
 *      so a zone costs one SAM image, not six.
 *   3. Every mask pixel votes for the triangle under it. Where two masks overlap, the
 *      smaller one wins (a hand inside an "arm" mask is the hand).
 *   4. Triangles no view saw (inner sides, tiny triangles) take the zone of their nearest
 *      labelled neighbour on the mesh surface, so every triangle ends up in a zone and the
 *      zones can be drawn into UV space like any other paint area.
 *
 * The noun phrases come from the asset class (`samZones` in assetClasses.js), or from the
 * part names Muse gave in its suggestion when the class has no list.
 */

import * as THREE from 'three';
import { decodeMaskToRaster, recordsOfKind } from '@meta-sam/parser';
import { getAssetClass } from '../assetClasses.js';
import { uvSourceOf } from './textureLayout.js';
import { islandIdPerTriangle, triangleCount } from './uvIslands.js';

/** @typedef {{ zone: string, concept: string }} ZoneConcept */

/**
 * The noun phrases to ask SAM for, with the zone each one fills, plus the name of the zone
 * for surface no phrase covered. From the asset class, else from Muse's part names.
 * @returns {{ concepts: ZoneConcept[], rest: string }}
 */
export function zoneConceptsFor(assetClassId, partNames = [], { max = 8 } = {}) {
  const spec = getAssetClass(assetClassId)?.samZones;
  if (spec?.concepts?.length) {
    return {
      concepts: spec.concepts.slice(0, max).map((c) => (typeof c === 'string' ? { zone: c, concept: c } : c)),
      rest: spec.rest ?? 'other',
    };
  }
  const seen = new Set();
  const concepts = [];
  for (const raw of partNames) {
    const concept = String(raw ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9 -]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(-3)
      .join(' ');
    if (!concept || seen.has(concept)) continue;
    seen.add(concept);
    concepts.push({ zone: concept, concept });
    if (concepts.length >= max) break;
  }
  return { concepts, rest: spec?.rest ?? 'body' };
}

// ------------------------------------------------------------------ triangle-ID raster

const _v = new THREE.Vector3();

/**
 * World-space vertex positions of a mesh as drawn (skinning and morph targets applied).
 * @returns {Float32Array} xyz per vertex
 */
export function worldPositions(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  mesh.updateWorldMatrix(true, false);
  const posed = typeof mesh.getVertexPosition === 'function' && (mesh.isSkinnedMesh || mesh.morphTargetInfluences);
  for (let i = 0; i < pos.count; i++) {
    if (posed) mesh.getVertexPosition(i, _v);
    else _v.fromBufferAttribute(pos, i);
    _v.applyMatrix4(mesh.matrixWorld);
    out[i * 3] = _v.x;
    out[i * 3 + 1] = _v.y;
    out[i * 3 + 2] = _v.z;
  }
  return out;
}

/**
 * Rasterizes triangles into an ID buffer (pixel centres, nearest wins).
 * `meshes` are { positions: Float32Array (world xyz), index: ArrayLike|null, tris, base }
 * where `base` is the mesh's first global triangle id. `projView` maps world → clip space
 * (orthographic, so no perspective divide is needed beyond w = 1).
 * Triangles smaller than a pixel are tested at their centroid against the depth buffer.
 * @returns {{ ids: Int32Array, depth: Float32Array }} ids = global triangle id or -1
 */
export function rasterizeIds(meshes, projView, size, { depthTolerance = 0.004 } = {}) {
  const ids = new Int32Array(size * size).fill(-1);
  const depth = new Float32Array(size * size).fill(Infinity);
  const e = projView.elements;
  const small = [];
  for (const m of meshes) {
    const n = m.positions.length / 3;
    const sx = new Float32Array(n),
      sy = new Float32Array(n),
      sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = m.positions[i * 3],
        y = m.positions[i * 3 + 1],
        z = m.positions[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      sx[i] = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2) * size;
      sy[i] = ((1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2) * size;
      sz[i] = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
    }
    for (let t = 0; t < m.tris; t++) {
      const a = m.index ? m.index[t * 3] : t * 3,
        b = m.index ? m.index[t * 3 + 1] : t * 3 + 1,
        c = m.index ? m.index[t * 3 + 2] : t * 3 + 2;
      const x0 = sx[a],
        y0 = sy[a],
        x1 = sx[b],
        y1 = sy[b],
        x2 = sx[c],
        y2 = sy[c];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area === 0) continue;
      const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
      const maxX = Math.min(size - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
      const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
      const maxY = Math.min(size - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
      const id = m.base + t;
      let hit = false;
      for (let py = minY; py <= maxY; py++) {
        const cy = py + 0.5;
        for (let px = minX; px <= maxX; px++) {
          const cx = px + 0.5;
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          hit = true;
          const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
          const p = py * size + px;
          if (z < depth[p]) {
            depth[p] = z;
            ids[p] = id;
          }
        }
      }
      if (!hit) small.push(id, (x0 + x1 + x2) / 3, (y0 + y1 + y2) / 3, (sz[a] + sz[b] + sz[c]) / 3);
    }
  }
  // Sub-pixel triangles: visible if their centroid is (about) as near as what won that pixel.
  // They are reported separately so they vote without hiding the triangle that owns the pixel.
  const extra = [];
  for (let i = 0; i < small.length; i += 4) {
    const px = Math.floor(small[i + 1]),
      py = Math.floor(small[i + 2]);
    if (px < 0 || py < 0 || px >= size || py >= size) continue;
    const p = py * size + px;
    if (small[i + 3] <= depth[p] + depthTolerance) extra.push(small[i], p);
  }
  return { ids, depth, extra };
}

// ------------------------------------------------------------------ SAM masks → pixel labels

/**
 * One label per pixel of the image sent to SAM: the index of the concept whose mask covers
 * it (smallest mask wins where masks overlap), or -1. `results[k]` is SAM's parsed result
 * for concept k.
 * @returns {{ label: Int16Array, found: number[] }} found[k] = masks kept for concept k
 */
export function labelPixels(results, w, h, { minConfidence = 0.35 } = {}) {
  const label = new Int16Array(w * h).fill(-1);
  const owner = new Float32Array(w * h).fill(Infinity);
  const found = results.map(() => 0);
  results.forEach((result, k) => {
    for (const rec of recordsOfKind(result?.records ?? [], 'mask')) {
      if (rec.confidence !== undefined && rec.confidence < minConfidence) continue;
      const { left, top, right, bottom } = rec.bounds;
      const bw = right - left,
        bh = bottom - top;
      if (bw <= 0 || bh <= 0) continue;
      const raster = decodeMaskToRaster(rec.mask);
      const rw = rec.mask.width,
        rh = rec.mask.height;
      let on = 0;
      for (let i = 0; i < raster.length; i++) on += raster[i] ? 1 : 0;
      if (!on) continue;
      const size = (on / raster.length) * bw * bh; // mask area in image pixels
      found[k]++;
      for (let y = Math.max(0, top); y < Math.min(h, bottom); y++) {
        const ry = Math.min(rh - 1, Math.floor(((y - top) * rh) / bh));
        for (let x = Math.max(0, left); x < Math.min(w, right); x++) {
          const rx = Math.min(rw - 1, Math.floor(((x - left) * rw) / bw));
          if (!raster[ry * rw + rx]) continue;
          const p = y * w + x;
          if (size < owner[p]) {
            owner[p] = size;
            label[p] = k;
          }
        }
      }
    }
  });
  return { label, found };
}

// ------------------------------------------------------------------ votes → triangle zones

/**
 * Turns per-view triangle IDs plus the label image into a zone per triangle.
 * `views[i]` = { ids, extra, ox, oy } with (ox, oy) the view's offset in the label image.
 * Labels 0..K-1 are concepts, K is "seen but no concept" (rest).
 * @returns {Int16Array} zone per global triangle, -1 = not seen
 */
export function voteTriangles(views, label, labelW, size, triCount, K) {
  const votes = new Float32Array(triCount * (K + 1));
  for (const v of views) {
    const add = (id, p) => {
      const x = (p % size) + v.ox,
        y = Math.floor(p / size) + v.oy;
      const l = label[y * labelW + x];
      votes[id * (K + 1) + (l >= 0 ? l : K)] += 1;
    };
    for (let p = 0; p < v.ids.length; p++) if (v.ids[p] >= 0) add(v.ids[p], p);
    for (let i = 0; i < v.extra.length; i += 2) add(v.extra[i], v.extra[i + 1]);
  }
  const zone = new Int16Array(triCount).fill(-1);
  for (let t = 0; t < triCount; t++) {
    let best = -1,
      bestN = 0;
    for (let k = 0; k <= K; k++) {
      const n = votes[t * (K + 1) + k];
      if (n > bestN) {
        bestN = n;
        best = k;
      }
    }
    zone[t] = best;
  }
  return zone;
}

/**
 * Fills unseen triangles (-1) from their labelled neighbours across shared vertex positions,
 * breadth first, so a zone grows over the hidden side of the same surface. Triangles on
 * pieces no view saw at all take the zone of the nearest labelled triangle (by centroid).
 * `meshes[i]` = { positions, index, tris, base }.
 */
export function fillUnseen(zone, meshes) {
  const total = zone.length;
  const neighbours = new Array(total);
  const centroid = new Float32Array(total * 3);
  for (const m of meshes) {
    // Weld by position so seams (split UVs / normals) still connect.
    const n = m.positions.length / 3;
    const weld = new Int32Array(n);
    const keyOf = new Map();
    let span = 0;
    for (let i = 0; i < m.positions.length; i++) span = Math.max(span, Math.abs(m.positions[i]));
    const q = (span || 1) * 1e-5;
    for (let i = 0; i < n; i++) {
      const k = `${Math.round(m.positions[i * 3] / q)},${Math.round(m.positions[i * 3 + 1] / q)},${Math.round(m.positions[i * 3 + 2] / q)}`;
      let w = keyOf.get(k);
      if (w === undefined) keyOf.set(k, (w = keyOf.size));
      weld[i] = w;
    }
    const byVertex = Array.from({ length: keyOf.size }, () => []);
    for (let t = 0; t < m.tris; t++) {
      for (let j = 0; j < 3; j++) {
        const v = m.index ? m.index[t * 3 + j] : t * 3 + j;
        byVertex[weld[v]].push(m.base + t);
        centroid[(m.base + t) * 3] += m.positions[v * 3] / 3;
        centroid[(m.base + t) * 3 + 1] += m.positions[v * 3 + 1] / 3;
        centroid[(m.base + t) * 3 + 2] += m.positions[v * 3 + 2] / 3;
      }
    }
    for (let t = 0; t < m.tris; t++) {
      const set = new Set();
      for (let j = 0; j < 3; j++) {
        const v = m.index ? m.index[t * 3 + j] : t * 3 + j;
        for (const o of byVertex[weld[v]]) if (o !== m.base + t) set.add(o);
      }
      neighbours[m.base + t] = [...set];
    }
  }
  const mine = [];
  for (const m of meshes) for (let t = 0; t < m.tris; t++) mine.push(m.base + t);
  const queue = mine.filter((t) => zone[t] >= 0);
  for (let h = 0; h < queue.length; h++) {
    const t = queue[h];
    for (const o of neighbours[t] ?? []) {
      if (zone[o] >= 0) continue;
      zone[o] = zone[t];
      queue.push(o);
    }
  }
  // Disconnected pieces nobody saw: nearest labelled centroid (sampled for speed).
  const labelled = mine.filter((t) => zone[t] >= 0);
  if (!labelled.length) return zone;
  const step = Math.max(1, Math.floor(labelled.length / 4000));
  for (const t of mine) {
    if (zone[t] >= 0) continue;
    let best = -1,
      bestD = Infinity;
    for (let i = 0; i < labelled.length; i += step) {
      const o = labelled[i];
      const dx = centroid[t * 3] - centroid[o * 3],
        dy = centroid[t * 3 + 1] - centroid[o * 3 + 1],
        dz = centroid[t * 3 + 2] - centroid[o * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    zone[t] = zone[best];
  }
  return zone;
}

// ------------------------------------------------------------------ the whole pass

/**
 * Finds paint zones for the atlas slots of a model.
 * @param {{
 *   root: import('three').Object3D,
 *   slots: object[],
 *   views: { name: string, canvas: HTMLCanvasElement, projView: import('three').Matrix4, rootMatrix: import('three').Matrix4 }[],
 *   concepts: ZoneConcept[], rest: string,
 *   segment: (o: { image: string, prompt: string, signal?: AbortSignal }) => Promise<any>,
 *   signal?: AbortSignal, cols?: number, minShare?: number, restMinShare?: number,
 * }} o
 * @returns {Promise<{ zones: Map<string, { zone: string, tris: Map<import('three').Mesh, Uint8Array>, area: number }[]>,
 *   found: { zone: string, concept: string, masks: number }[], sheet: HTMLCanvasElement, calls: number }>}
 */
export async function findSamZones(o) {
  const { root, slots, views, concepts, rest, segment, signal } = o;
  const size = views[0].canvas.width;
  const cols = o.cols ?? 3;
  const rows = Math.ceil(views.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * size;
  sheet.height = rows * size;
  const g = sheet.getContext('2d');
  views.forEach((v, i) => g.drawImage(v.canvas, (i % cols) * size, Math.floor(i / cols) * size));
  const sheetUrl = sheet.toDataURL('image/png');

  // Every visible mesh occludes; only atlas-slot meshes get zones.
  root.updateMatrixWorld(true);
  const toRender = new THREE.Matrix4()
    .copy(views[0].rootMatrix ?? root.matrixWorld)
    .multiply(new THREE.Matrix4().copy(root.matrixWorld).invert());
  const meshes = [];
  let base = 0;
  root.traverse((m) => {
    if (!m.isMesh || !m.visible || !m.geometry?.getAttribute('position')) return;
    const positions = worldPositions(m);
    for (let i = 0; i < positions.length; i += 3) {
      _v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(toRender);
      positions[i] = _v.x;
      positions[i + 1] = _v.y;
      positions[i + 2] = _v.z;
    }
    const index = m.geometry.index?.array ?? null;
    const tris = Math.floor((index ? index.length : positions.length / 3) / 3);
    meshes.push({ mesh: m, positions, index, tris, base });
    base += tris;
  });

  const rasters = views.map((v, i) => ({
    ...rasterizeIds(meshes, v.projView, size),
    ox: (i % cols) * size,
    oy: Math.floor(i / cols) * size,
  }));

  // One SAM image per concept, all in parallel.
  const results = await Promise.all(concepts.map((c) => segment({ image: sheetUrl, prompt: c.concept, signal })));
  const { label, found } = labelPixels(results, sheet.width, sheet.height);
  const K = concepts.length;
  const zone = voteTriangles(rasters, label, sheet.width, size, base, K);

  // Per slot: drop zones too small to paint on their own, then fill what nobody saw.
  const out = new Map();
  for (const slot of slots) {
    const slotMeshes = meshes.filter((m) => slot.meshes.includes(m.mesh));
    if (!slotMeshes.length) continue;
    const z = new Int16Array(base).fill(-1);
    const uvArea = new Map();
    let total = 0;
    const share = new Float64Array(K + 1);
    for (const m of slotMeshes) {
      const src = uvSourceOf(m.mesh, slot.uvChannel, slot.texture);
      if (!src) continue;
      const areas = uvTriangleAreas(src);
      uvArea.set(m.mesh, areas);
      for (let t = 0; t < m.tris; t++) {
        const id = m.base + t;
        z[id] = zone[id];
        total += areas[t] ?? 0;
        if (zone[id] >= 0) share[zone[id]] += areas[t] ?? 0;
      }
    }
    if (!(total > 0)) continue;
    for (let k = 0; k <= K; k++) {
      const s = share[k] / total;
      const min = k === K ? (o.restMinShare ?? 0.04) : (o.minShare ?? 0.005);
      if (s > 0 && s < min) for (let id = 0; id < base; id++) if (z[id] === k) z[id] = -1;
    }
    fillUnseen(z, slotMeshes);
    const regions = [];
    for (let k = 0; k <= K; k++) {
      const tris = new Map();
      let area = 0;
      for (const m of slotMeshes) {
        const areas = uvArea.get(m.mesh);
        if (!areas) continue;
        const bits = new Uint8Array(m.tris);
        let any = false;
        for (let t = 0; t < m.tris; t++) {
          if (z[m.base + t] !== k) continue;
          bits[t] = 1;
          any = true;
          area += areas[t] ?? 0;
        }
        if (any) tris.set(m.mesh, bits);
      }
      if (!tris.size || !(area > 0)) continue;
      regions.push({ zone: k === K ? rest : concepts[k].zone, tris, area, share: area / total });
    }
    // Two concepts can map to one zone ("shirt" and "jacket" → torso): merge them.
    const merged = new Map();
    for (const r of regions) {
      const m = merged.get(r.zone);
      if (!m) {
        merged.set(r.zone, r);
        continue;
      }
      for (const [mesh, bits] of r.tris) {
        const t = m.tris.get(mesh);
        if (!t) m.tris.set(mesh, bits);
        else for (let i = 0; i < t.length; i++) t[i] |= bits[i];
      }
      m.area += r.area;
      m.share += r.share;
    }
    out.set(
      slot.id,
      [...merged.values()].sort((a, b) => b.area - a.area),
    );
  }
  return {
    zones: out,
    found: concepts.map((c, k) => ({ ...c, masks: found[k] })),
    sheet,
    calls: concepts.length,
  };
}

/** Area of each triangle in UV space. */
export function uvTriangleAreas(src) {
  const n = triangleCount(src);
  const out = new Float32Array(n);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [0, 1, 2].map((k) => (src.index ? src.index[t * 3 + k] : t * 3 + k));
    const u0 = src.uvs[a * 2],
      v0 = src.uvs[a * 2 + 1];
    out[t] =
      Math.abs((src.uvs[b * 2] - u0) * (src.uvs[c * 2 + 1] - v0) - (src.uvs[c * 2] - u0) * (src.uvs[b * 2 + 1] - v0)) /
      2;
  }
  return out;
}

/** Data makeRegion (anatomy.js) needs per mesh. */
export function regionData(slot, meshes) {
  return meshes.map((mesh) => {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    return { mesh, src, islands: islandIdPerTriangle(src) };
  });
}
