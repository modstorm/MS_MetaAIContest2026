import { uvSourceOf } from '../analysis/textureLayout.js';
import { islandIdPerTriangle, triangleCount } from '../analysis/uvIslands.js';
import { createCanvas, ctx2d } from './imageUtils.js';

/**
 * Pixel-level island tools used after painting:
 *  - islandIdMap: which UV island covers each texel
 *  - flattenTinyIslands: one solid color per very small island (fingers, buttons)
 *  - padIslands: edge padding, so filtering at UV seams never samples gap pixels
 */

const MARK = 0x80; // blue channel marker for "this pixel is an island id"

/**
 * Rasterizes every UV island of a slot with a unique color id.
 * Returns ids (Int32Array, -1 = no island) and per-island pixel counts.
 * Edge pixels blended by antialiasing are left as -1 (padding fills them).
 */
export function islandIdMap(slot, width, height) {
  const c = createCanvas(width, height);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  let next = 0;
  for (const mesh of slot.meshes) {
    const src = uvSourceOf(mesh, slot.uvChannel, slot.texture);
    if (!src) continue;
    const tris = triangleCount(src);
    const isl = islandIdPerTriangle(src);
    const paths = new Map();
    for (let t = 0; t < tris; t++) {
      let p = paths.get(isl[t]);
      if (!p) paths.set(isl[t], (p = new Path2D()));
      const pts = [];
      for (let k = 0; k < 3; k++) {
        const v = src.index ? src.index[t * 3 + k] : t * 3 + k;
        pts.push(src.uvs[v * 2], src.uvs[v * 2 + 1]);
      }
      const ou = Math.floor(Math.min(pts[0], pts[2], pts[4]));
      const ov = Math.floor(Math.min(pts[1], pts[3], pts[5]));
      // Same winding for every triangle: mirrored islands stacked on top of each other
      // would otherwise cancel out under the nonzero fill rule and leave holes.
      const ccw = (pts[2] - pts[0]) * (pts[5] - pts[1]) - (pts[4] - pts[0]) * (pts[3] - pts[1]) >= 0;
      const [i1, i2] = ccw ? [2, 4] : [4, 2];
      p.moveTo((pts[0] - ou) * width, (pts[1] - ov) * height);
      p.lineTo((pts[i1] - ou) * width, (pts[i1 + 1] - ov) * height);
      p.lineTo((pts[i2] - ou) * width, (pts[i2 + 1] - ov) * height);
      p.closePath();
    }
    for (const p of paths.values()) {
      const id = ++next; // 1..65535
      const col = `rgb(${id & 255},${(id >> 8) & 255},${MARK})`;
      ctx.fillStyle = col;
      ctx.fill(p);
    }
  }
  const d = ctx.getImageData(0, 0, width, height).data;
  const ids = new Int32Array(width * height).fill(-1);
  const counts = new Int32Array(next + 1);
  for (let i = 0; i < ids.length; i++) {
    if (d[i * 4 + 2] !== MARK) continue;
    const id = d[i * 4] | (d[i * 4 + 1] << 8);
    if (id > 0 && id <= next) {
      ids[i] = id;
      counts[id]++;
    }
  }
  return { ids, counts, islandCount: next, width, height };
}

/**
 * Fills every island smaller than `maxFraction` of the image with one solid color:
 * the median (per channel) of what was painted inside it. Cleans stray patterns
 * off tiny packed islands such as fingers. Returns the number of islands flattened.
 */
export function flattenTinyIslands(canvas, map, maxFraction = 0.002) {
  const { ids, counts, width, height } = map;
  const limit = Math.max(4, Math.round(width * height * maxFraction));
  const tiny = new Set();
  for (let id = 1; id < counts.length; id++) if (counts[id] > 0 && counts[id] <= limit) tiny.add(id);
  if (!tiny.size) return 0;
  const ctx = ctx2d(canvas);
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const samples = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (!tiny.has(ids[i])) continue;
    let s = samples.get(ids[i]);
    if (!s) samples.set(ids[i], (s = [[], [], []]));
    s[0].push(d[i * 4]);
    s[1].push(d[i * 4 + 1]);
    s[2].push(d[i * 4 + 2]);
  }
  const median = (a) => {
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  const colors = new Map();
  for (const [id, s] of samples) colors.set(id, [median(s[0]), median(s[1]), median(s[2])]);
  for (let i = 0; i < ids.length; i++) {
    const col = colors.get(ids[i]);
    if (!col) continue;
    d[i * 4] = col[0];
    d[i * 4 + 1] = col[1];
    d[i * 4 + 2] = col[2];
  }
  ctx.putImageData(img, 0, 0);
  return colors.size;
}

/**
 * Edge padding (dilation): pixels outside all islands take the average color of
 * neighbouring island pixels, growing outward `radius` pixels. Prevents dark seams
 * when the texture is filtered / mip-mapped across UV island borders.
 * Pixels further than `radius` from any island keep their color.
 */
export function padIslands(canvas, map, radius = 12, inset = true) {
  const { ids, width: w, height: h } = map;
  const ctx = ctx2d(canvas);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let filled = new Uint8Array(w * h);
  for (let i = 0; i < ids.length; i++) if (ids[i] > 0) filled[i] = 1;
  // Inset by one pixel first: the outermost island pixels are often where the painted
  // image is least aligned, so the padding takes its colors from just inside.
  if (inset) {
    const shrunk = filled.slice();
    for (let i = 0; i < filled.length; i++) {
      if (!filled[i]) continue;
      const x = i % w,
        y = (i / w) | 0;
      if (
        (x > 0 && !filled[i - 1]) ||
        (x < w - 1 && !filled[i + 1]) ||
        (y > 0 && !filled[i - w]) ||
        (y < h - 1 && !filled[i + w])
      )
        shrunk[i] = 0;
    }
    // Keep islands that would vanish entirely (1-2 px slivers).
    for (let i = 0; i < filled.length; i++)
      if (filled[i] && !shrunk[i] && (map.counts[ids[i]] ?? 0) < 16) shrunk[i] = 1;
    filled = shrunk;
  }
  // Bounded full-image passes over typed arrays: predictable cost (radius × pixels × 8).
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = d[i * 4];
    rgb[i * 3 + 1] = d[i * 4 + 1];
    rgb[i * 3 + 2] = d[i * 4 + 2];
  }
  const touched = new Uint8Array(w * h);
  for (let pass = 0; pass < radius; pass++) {
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0,
          g = 0,
          b = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!filled[j]) continue;
            r += rgb[j * 3];
            g += rgb[j * 3 + 1];
            b += rgb[j * 3 + 2];
            n++;
          }
        }
        if (n) add.push(i, r / n, g / n, b / n);
      }
    }
    if (!add.length) break;
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k];
      rgb[i * 3] = add[k + 1];
      rgb[i * 3 + 1] = add[k + 2];
      rgb[i * 3 + 2] = add[k + 3];
      filled[i] = 1;
      touched[i] = 1;
    }
  }
  for (let i = 0; i < w * h; i++) {
    if (!touched[i]) continue;
    d[i * 4] = rgb[i * 3];
    d[i * 4 + 1] = rgb[i * 3 + 1];
    d[i * 4 + 2] = rgb[i * 3 + 2];
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Skin swatches: tiny islands that were skin-colored in the original (often little squares
 * next to the face that give the rest of the head, ears or neck their skin color). They
 * keep their original color unless the face's skin color itself changed (a full head mask,
 * a clown, a robot): then they all take the new skin color, so the head stays one color.
 * `faceMask` (white = face area) and `original` are the same size as `canvas`.
 * Returns { swatches, recolored } (recolored: the new skin color, or null if kept).
 */
export function keepSkinSwatches(canvas, original, map, faceMask, { maxFraction = 0.002, tolerance = 40 } = {}) {
  const { ids, counts, width, height } = map;
  const limit = Math.max(4, Math.round(width * height * maxFraction));
  const od = ctx2d(original).getImageData(0, 0, width, height).data;
  const md = ctx2d(faceMask).getImageData(0, 0, width, height).data;
  const ctx = ctx2d(canvas);
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  const median = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
  const med3 = (ch) => ch.map(median);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tolerance;

  // Skin color of the original face, and what those skin pixels became.
  const was = [[], [], []];
  for (let i = 0; i < ids.length; i += 3) {
    if (md[i * 4] < 128) continue;
    for (let c = 0; c < 3; c++) was[c].push(od[i * 4 + c]);
  }
  if (!was[0].length) return { swatches: 0, recolored: null };
  const skin = med3(was);
  const now = [[], [], []];
  for (let i = 0; i < ids.length; i += 3) {
    if (md[i * 4] < 128) continue;
    if (!near([od[i * 4], od[i * 4 + 1], od[i * 4 + 2]], skin)) continue;
    for (let c = 0; c < 3; c++) now[c].push(d[i * 4 + c]);
  }
  const newSkin = now[0].length ? med3(now) : skin;
  const changed = !near(newSkin, skin);

  // Tiny islands that were skin-colored.
  const samples = new Map();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id || counts[id] > limit) continue;
    let s = samples.get(id);
    if (!s) samples.set(id, (s = [[], [], []]));
    for (let c = 0; c < 3; c++) s[c].push(od[i * 4 + c]);
  }
  const swatch = new Set();
  for (const [id, s] of samples) if (near(med3(s), skin)) swatch.add(id);
  if (!swatch.size) return { swatches: 0, recolored: null };
  for (let i = 0; i < ids.length; i++) {
    if (!swatch.has(ids[i])) continue;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = changed ? newSkin[c] : od[i * 4 + c];
  }
  ctx.putImageData(img, 0, 0);
  return { swatches: swatch.size, recolored: changed ? newSkin : null };
}
