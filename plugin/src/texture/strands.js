import * as THREE from 'three';
import { uvSourceOf } from '../analysis/textureLayout.js';
import { islandIdPerTriangle } from '../analysis/uvIslands.js';
import { ctx2d } from './imageUtils.js';

/**
 * Per-strand hair. Hair meshes are usually many small cards or spikes, each its own UV
 * island, so a pattern painted across the hair texture (as for cloth) shows up as decals
 * cut across every strand. Instead each strand island is shaded on its own: a gradient
 * from root (dark, nearest the head) to tip (light), fine streaks running along the
 * strand, and a slight color shift per strand. The colors come from the painted image
 * (its median hair color), so the theme still picks the hair color.
 */

const _v = new THREE.Vector3();

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Smooth 1D value noise. */
function noise1(x, seed) {
  const i = Math.floor(x),
    f = x - i;
  const a = hash(i + seed * 57.3),
    b = hash(i + 1 + seed * 57.3);
  const s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

/** Median color of the canvas pixels covered by the given triangles' bounding pixels. */
function medianColor(data, W, pixels) {
  const ch = [[], [], []];
  const step = Math.max(1, Math.floor(pixels.length / 20000));
  for (let k = 0; k < pixels.length; k += step) {
    const i = pixels[k] * 4;
    ch[0].push(data[i]);
    ch[1].push(data[i + 1]);
    ch[2].push(data[i + 2]);
  }
  if (!ch[0].length) return null;
  return ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]);
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x);

/**
 * Repaints the hair `part` on `canvas` (the atlas, in UV space) strand by strand.
 * `center` is a world-space point inside the head (strand roots are the island points
 * nearest it). Hair with fewer than `minStrands` islands is left alone. Returns the
 * number of strands painted.
 * @param {HTMLCanvasElement} canvas
 * @param {{ uvChannel: number, texture: any }} slot
 * @param {{ meshes: THREE.Mesh[], tris?: Map<THREE.Mesh, Uint8Array>, islands?: Map<THREE.Mesh, Set<number>> }} part
 */
export function paintHairStrands(
  canvas,
  slot,
  part,
  { center = null, streaks = 1, color = null, minStrands = 4 } = {},
) {
  const W = canvas.width,
    H = canvas.height;
  const ctx = ctx2d(canvas);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  // Gather triangles: UVs (pixels) and world positions per vertex, grouped by UV island.
  const strands = new Map(); // key → { tris: [[px,py,wx,wy,wz]x3] }
  const box = new THREE.Box3();
  for (const mesh of part.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    const pos = mesh.geometry.getAttribute('position');
    if (!src || !pos) continue;
    mesh.updateWorldMatrix(true, false);
    const triCount = Math.floor((src.index ? src.index.length : src.uvs.length / 2) / 3);
    const keepTri = part.tris?.get(mesh);
    if (part.tris && !keepTri) continue;
    const keepIsland = part.islands?.get(mesh);
    const islandOf = islandIdPerTriangle(src);
    for (let t = 0; t < triCount; t++) {
      if (keepTri && !keepTri[t]) continue;
      if (keepIsland && !keepIsland.has(islandOf[t])) continue;
      const key = `${mesh.uuid}:${islandOf[t]}`;
      let s = strands.get(key);
      if (!s) strands.set(key, (s = { tris: [], seed: strands.size + 1 }));
      const tri = [];
      let ou = Infinity,
        ov = Infinity;
      for (let k = 0; k < 3; k++) {
        const v = src.index ? src.index[t * 3 + k] : t * 3 + k;
        ou = Math.min(ou, src.uvs[v * 2]);
        ov = Math.min(ov, src.uvs[v * 2 + 1]);
      }
      ou = Math.floor(ou);
      ov = Math.floor(ov);
      for (let k = 0; k < 3; k++) {
        const v = src.index ? src.index[t * 3 + k] : t * 3 + k;
        _v.fromBufferAttribute(pos, v).applyMatrix4(mesh.matrixWorld);
        box.expandByPoint(_v);
        tri.push([(src.uvs[v * 2] - ou) * W, (src.uvs[v * 2 + 1] - ov) * H, _v.x, _v.y, _v.z]);
      }
      s.tris.push(tri);
    }
  }
  // One big hair cap (a single skin) keeps the painted image: there are no strands to shade.
  if (strands.size < minStrands) return 0;
  const c = center ?? box.getCenter(new THREE.Vector3()).toArray();
  const [cx, cy, cz] = Array.isArray(c) ? c : [c.x, c.y, c.z];
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const dist = (p) => Math.hypot(p[2] - cx, p[3] - cy, p[4] - cz);
  let gMin = Infinity,
    gMax = -Infinity;
  for (const s of strands.values())
    for (const tri of s.tris)
      for (const p of tri) {
        const dd = dist(p);
        gMin = Math.min(gMin, dd);
        gMax = Math.max(gMax, dd);
      }

  // Covered pixels per strand, with a margin as wide as the paste-back mask grows, so the
  // painted edges are covered too.
  const margin = Math.max(1.5, (2.5 * W) / 1024);
  const raster = (tri, fn) => {
    const [a, b, e] = tri;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], e[0]) - margin)),
      x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], e[0]) + margin)),
      y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], e[1]) - margin)),
      y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], e[1]) + margin));
    const area = (b[0] - a[0]) * (e[1] - a[1]) - (e[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) return;
    const len = [
      Math.hypot(e[0] - b[0], e[1] - b[1]),
      Math.hypot(a[0] - e[0], a[1] - e[1]),
      Math.hypot(b[0] - a[0], b[1] - a[1]),
    ];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5,
          py = y + 0.5;
        const w0 = ((b[0] - px) * (e[1] - py) - (e[0] - px) * (b[1] - py)) / area;
        const w1 = ((e[0] - px) * (a[1] - py) - (a[0] - px) * (e[1] - py)) / area;
        const w2 = 1 - w0 - w1;
        // Signed distance (pixels) to each edge; keep pixels up to `margin` outside.
        if (
          (w0 * Math.abs(area)) / len[0] < -margin ||
          (w1 * Math.abs(area)) / len[1] < -margin ||
          (w2 * Math.abs(area)) / len[2] < -margin
        )
          continue;
        fn(y * W + x, Math.max(0, w0), Math.max(0, w1), Math.max(0, w2));
      }
    }
  };

  const all = [];
  for (const s of strands.values()) {
    s.pixels = [];
    for (const tri of s.tris) raster(tri, (i) => s.pixels.push(i));
    for (const i of s.pixels) all.push(i);
  }
  const base = color ?? medianColor(d, W, all);
  if (!base) return 0;

  for (const s of strands.values()) {
    // Root → tip: distance from the head center, normalized within the strand (or over
    // the whole hair when the strand is flat against the head).
    let lo = Infinity,
      hi = -Infinity;
    for (const tri of s.tris)
      for (const p of tri) {
        const dd = dist(p);
        lo = Math.min(lo, dd);
        hi = Math.max(hi, dd);
      }
    if (hi - lo < size * 0.04) {
      lo = gMin;
      hi = gMax;
    }
    // Strand direction in the texture: least-squares gradient of t over its vertices.
    let su = 0,
      sv = 0,
      st = 0,
      n = 0;
    const pts = [];
    for (const tri of s.tris)
      for (const p of tri) {
        const t = (dist(p) - lo) / (hi - lo || 1);
        pts.push([p[0], p[1], t]);
        su += p[0];
        sv += p[1];
        st += t;
        n++;
      }
    su /= n;
    sv /= n;
    st /= n;
    let uu = 0,
      uv = 0,
      vv = 0,
      ut = 0,
      vt = 0;
    for (const [u, v, t] of pts) {
      uu += (u - su) ** 2;
      vv += (v - sv) ** 2;
      uv += (u - su) * (v - sv);
      ut += (u - su) * (t - st);
      vt += (v - sv) * (t - st);
    }
    const det = uu * vv - uv * uv;
    let gx = det ? (ut * vv - vt * uv) / det : 0,
      gy = det ? (vt * uu - ut * uv) / det : 1;
    const gl = Math.hypot(gx, gy) || 1;
    // Perpendicular (across the strand), for streaks that run along it.
    const px = -gy / gl,
      py = gx / gl;
    // Per-strand tint: a little lighter / darker and warmer / cooler.
    const shade = 0.88 + hash(s.seed) * 0.24;
    const warm = (hash(s.seed + 9) - 0.5) * 16;
    const widthPx = Math.max(6, Math.sqrt(s.pixels.length) / 3);
    for (const tri of s.tris) {
      const ts = tri.map((p) => (dist(p) - lo) / (hi - lo || 1));
      raster(tri, (i, w0, w1, w2) => {
        const sum = w0 + w1 + w2 || 1;
        const t = Math.min(1, Math.max(0, (ts[0] * w0 + ts[1] * w1 + ts[2] * w2) / sum));
        const x = i % W,
          y = (i / W) | 0;
        const across = (x * px + y * py) / widthPx;
        const streak = streaks
          ? (noise1(across * 3, s.seed) - 0.5) * 0.35 + (noise1(across * 11, s.seed + 3) - 0.5) * 0.15
          : 0;
        // Root 55% → mid 100% → tip 125% brightness.
        const lum = (t < 0.5 ? mix(0.55, 1, t / 0.5) : mix(1, 1.25, (t - 0.5) / 0.5)) * shade * (1 + streak);
        d[i * 4] = clamp255(base[0] * lum + warm);
        d[i * 4 + 1] = clamp255(base[1] * lum);
        d[i * 4 + 2] = clamp255(base[2] * lum - warm);
      });
    }
  }
  ctx.putImageData(img, 0, 0);
  return strands.size;
}
