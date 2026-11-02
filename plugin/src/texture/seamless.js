import { createCanvas, ctx2d } from './imageUtils.js';

/**
 * Seam tools for single textures that must wrap: tiling materials (both axes) and
 * equirectangular skies (left/right edge, plus calm poles).
 *
 * The pure functions work on ImageData-shaped objects ({ data, width, height }), so they
 * run in Node tests too; the canvas wrappers below are what the plugin calls.
 */

const lumAt = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/**
 * How visible the wrap seam is on one axis: the mean color step across the edge
 * (last column → first column) divided by the steps between neighbouring columns
 * inside the image (their mean, or 3/4 of the largest). About 1 means it tiles; a photo that does not tile is usually 3+.
 * @param {{ data: Uint8ClampedArray, width: number, height: number }} img
 * @param {'x' | 'y'} axis
 */
export function seamRatio(img, axis = 'x') {
  const { data: d, width: w, height: h } = img;
  const n = axis === 'x' ? w : h;
  const m = axis === 'x' ? h : w;
  if (n < 4) return 1;
  const idx = (a, b) => (axis === 'x' ? (b * w + a) * 4 : (a * w + b) * 4);
  const step = (a0, a1) => {
    let s = 0;
    for (let b = 0; b < m; b++) {
      const i = idx(a0, b),
        j = idx(a1, b);
      s += Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]);
    }
    return s / m;
  };
  const edge = step(n - 1, 0);
  // Interior baseline: the mean step, or most of the largest one. A pattern with hard lines
  // (a checker, planks) whose line falls on the edge then still counts as tiling.
  let sum = 0,
    max = 0;
  for (let a = 0; a < n - 1; a++) {
    const v = step(a, a + 1);
    sum += v;
    if (v > max) max = v;
  }
  return edge / Math.max(2, sum / (n - 1), 0.75 * max);
}

/** True if the image already wraps on that axis (seamRatio under `threshold`). */
export function tilesOn(img, axis, threshold = 2) {
  return seamRatio(img, axis) < threshold;
}

/**
 * Makes one axis wrap with the offset-by-half method: the image rolled by half has
 * seamless edges (they come from the middle) and its seam in the middle; the original
 * is kept in the middle and the rolled copy fades in over a band at each edge.
 * Changes `img` in place. `band` is the fraction of the size used for the fade (each side).
 */
export function wrapAxis(img, axis = 'x', band = 0.125) {
  const { data: d, width: w, height: h } = img;
  const n = axis === 'x' ? w : h;
  const src = new Uint8ClampedArray(d);
  const half = Math.floor(n / 2);
  const bandPx = Math.max(1, Math.round(n * band));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = axis === 'x' ? x : y;
      const edgeDist = Math.min(a, n - 1 - a);
      if (edgeDist >= bandPx) continue;
      const t = edgeDist / bandPx;
      const wA = t * t * (3 - 2 * t); // smoothstep: 0 at the edge, 1 at the band's inner end
      const ra = (a + half) % n;
      const i = (y * w + x) * 4;
      const j = axis === 'x' ? (y * w + ra) * 4 : (ra * w + x) * 4;
      for (let c = 0; c < 3; c++) d[i + c] = src[i + c] * wA + src[j + c] * (1 - wA);
    }
  }
  return img;
}

/**
 * Equirect poles: the top and bottom rows of a sky panorama map to one point each, so
 * any detail there pinches. Fades the first and last `fraction` of rows to their row
 * average (a calm zenith and nadir). Changes `img` in place.
 */
export function calmPoles(img, fraction = 0.03) {
  const { data: d, width: w, height: h } = img;
  const rows = Math.max(1, Math.round(h * fraction));
  for (const top of [true, false]) {
    for (let r = 0; r < rows; r++) {
      const y = top ? r : h - 1 - r;
      const avg = [0, 0, 0];
      for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) avg[c] += d[(y * w + x) * 4 + c];
      for (let c = 0; c < 3; c++) avg[c] /= w;
      const k = 1 - r / rows; // 1 at the pole row
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * (1 - k) + avg[c] * k;
      }
    }
  }
  return img;
}

/** Mean luminance of the top and bottom thirds (sky vs ground check for panoramas). */
export function bandLuminance(img) {
  const { data: d, width: w, height: h } = img;
  const third = Math.floor(h / 3);
  const mean = (y0, y1) => {
    let s = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) s += lumAt(d, (y * w + x) * 4);
    return s / Math.max(1, (y1 - y0) * w);
  };
  return { top: mean(0, third), bottom: mean(h - third, h) };
}

// ---------------------------------------------------------------- canvas wrappers

const imageOf = (c) => ctx2d(c).getImageData(0, 0, c.width, c.height);

/** seamRatio for a canvas on both axes: { x, y }. */
export function canvasSeams(c) {
  const img = imageOf(c);
  return { x: seamRatio(img, 'x'), y: seamRatio(img, 'y') };
}

/**
 * Returns a copy of `c` that wraps as asked.
 * @param {HTMLCanvasElement} c
 * @param {{ x?: boolean, y?: boolean, poles?: boolean, band?: number, threshold?: number, force?: boolean }} o
 *   Axes already under `threshold` are left alone unless `force`.
 * @returns {{ canvas: HTMLCanvasElement, fixed: { x: boolean, y: boolean, poles: boolean }, before: { x: number, y: number }, after: { x: number, y: number } }}
 */
export function makeSeamless(c, o = {}) {
  const out = createCanvas(c.width, c.height);
  ctx2d(out).drawImage(c, 0, 0);
  const img = imageOf(out);
  const threshold = o.threshold ?? 1.5;
  const before = { x: seamRatio(img, 'x'), y: seamRatio(img, 'y') };
  const fixed = { x: false, y: false, poles: false };
  if (o.x && (o.force || before.x >= threshold)) {
    wrapAxis(img, 'x', o.band);
    fixed.x = true;
  }
  if (o.y && (o.force || before.y >= threshold)) {
    wrapAxis(img, 'y', o.band);
    fixed.y = true;
  }
  if (o.poles) {
    calmPoles(img, o.poleFraction);
    fixed.poles = true;
  }
  ctx2d(out).putImageData(img, 0, 0);
  return { canvas: out, fixed, before, after: { x: seamRatio(img, 'x'), y: seamRatio(img, 'y') } };
}
