// Transparent images from Muse: Muse paints the subject on a flat key color, and the key color is
// turned into transparency here (soft edges, the key's tint taken out of the edge pixels).

import { createCanvas, ctx2d } from './imageUtils.js';

const dist = (r, g, b, c) => Math.hypot(r - c[0], g - c[1], b - c[2]);

const KEYS = {
  magenta: { name: 'magenta', hex: '#FF00FF', rgb: [255, 0, 255] },
  green: { name: 'bright green', hex: '#00FF00', rgb: [0, 255, 0] },
};

/**
 * The key color: magenta, or green when the subject is likely pink or purple (from the theme
 * text, and from the input image's own colors when there is one). `wanted` may be 'auto' /
 * undefined, 'magenta', 'green' or a hex color like '#00ff00'.
 * @param {HTMLCanvasElement} [image] the image Muse repaints
 * @returns {{ name: string, hex: string, rgb: number[] }}
 */
export function pickKeyColor(wanted, text = '', image = null) {
  if (typeof wanted === 'string' && /^#?[0-9a-f]{6}$/i.test(wanted)) {
    const h = wanted.replace('#', '');
    const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return { name: `#${h.toUpperCase()}`, hex: `#${h.toUpperCase()}`, rgb };
  }
  if (wanted === 'green' || wanted === 'magenta') return KEYS[wanted];
  const pinkText = /\b(pink|purple|magenta|violet|fuchsia|lilac|lavender|mauve|orchid|plum)\b/i.test(text);
  if (image) {
    // Share of the image's visible pixels close to each key: the key must not be in the subject.
    const d = ctx2d(image).getImageData(0, 0, image.width, image.height).data;
    let m = 0,
      g = 0,
      n = 0;
    for (let i = 0; i < d.length; i += 16) {
      if (d[i + 3] < 128) continue;
      n++;
      if (dist(d[i], d[i + 1], d[i + 2], KEYS.magenta.rgb) < 130) m++;
      if (dist(d[i], d[i + 1], d[i + 2], KEYS.green.rgb) < 130) g++;
    }
    if (n) {
      m /= n;
      g /= n;
      if (Math.abs(m - g) > 0.002) return m > g ? KEYS.green : KEYS.magenta;
    }
  }
  return pinkText ? KEYS.green : KEYS.magenta;
}

/** The instruction for Muse: the subject alone on a flat key-color backdrop. */
export function keyColorInstruction(key) {
  return `Transparent cut-out: paint only the subject, whole and fully inside the frame, on a perfectly flat, solid ${key.name} (${key.hex}) background that fills everything around it and every gap. No gradient, texture, floor, horizon, frame or shadow on the background, and do not use ${key.name} or anything close to it anywhere in the subject.`;
}

/**
 * Turns the key color of `canvas` into transparency (in place) and returns
 * { keyColor: '#rrggbb' actually stripped, share: see-through share 0..1 }.
 * The backdrop color is read from the image border (Muse's "magenta" is rarely exact); pixels
 * within `inner` of it become fully transparent, beyond `outer` stay opaque, a soft ramp between.
 * Edge pixels are unmixed from the backdrop (no colored fringe), and tiny specks are removed.
 */
export function keyOut(canvas, key, { inner = 60, outer = 130, speck = 0.0002 } = {}) {
  const W = canvas.width,
    H = canvas.height;
  const g = ctx2d(canvas);
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  // Backdrop: median of the border pixels near the key (if the border is mostly the key).
  const border = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 1; y < H - 1; y++) border.push(y * W, y * W + W - 1);
  const near = border.filter((p) => dist(d[p * 4], d[p * 4 + 1], d[p * 4 + 2], key.rgb) < 160);
  let bg = key.rgb;
  if (near.length > border.length * 0.3) {
    const med = (c) => {
      const v = near.map((p) => d[p * 4 + c]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    bg = [med(0), med(1), med(2)];
  }
  const N = W * H;
  const alpha = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const t = (dist(d[i], d[i + 1], d[i + 2], bg) - inner) / (outer - inner);
    alpha[p] = (d[i + 3] / 255) * Math.min(1, Math.max(0, t));
  }
  // Specks: small separate bits that are not see-through (noise Muse left on the backdrop).
  const minSize = Math.max(8, Math.round(N * speck));
  const seen = new Uint8Array(N);
  const stack = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || alpha[s] <= 0.05) continue;
    const comp = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const x = p % W;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W])
        if (q >= 0 && q < N && !seen[q] && alpha[q] > 0.05) {
          seen[q] = 1;
          stack.push(q);
        }
      if (comp.length >= minSize) break;
    }
    if (comp.length < minSize && !stack.length) for (const p of comp) alpha[p] = 0;
    else {
      // A big part: mark the rest of it as seen without collecting it.
      while (stack.length) {
        const p = stack.pop();
        const x = p % W;
        for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W])
          if (q >= 0 && q < N && !seen[q] && alpha[q] > 0.05) {
            seen[q] = 1;
            stack.push(q);
          }
      }
    }
  }
  let clear = 0;
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const a = alpha[p];
    if (a <= 0.02) {
      d[i + 3] = 0;
      clear++;
      continue;
    }
    if (a < 1) {
      // Pixel = a·subject + (1−a)·backdrop: take the backdrop out of the edge pixels.
      for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.max(0, (d[i + c] - (1 - a) * bg[c]) / a));
    }
    d[i + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  const hex = `#${bg.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return { keyColor: hex, share: clear / N };
}

/** The part of `canvas` that is not see-through, plus a margin (a share of the size): a new canvas. */
export function trimTransparent(canvas, margin = 0.02) {
  const W = canvas.width,
    H = canvas.height;
  const d = ctx2d(canvas).getImageData(0, 0, W, H).data;
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (d[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return canvas;
  const m = Math.round(Math.max(W, H) * margin);
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(W - 1, x1 + m);
  y1 = Math.min(H - 1, y1 + m);
  const out = createCanvas(x1 - x0 + 1, y1 - y0 + 1);
  ctx2d(out).drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Hard edges for alpha-test cut-outs: alpha becomes 0 or 255 (in place). */
export function hardenAlpha(canvas, threshold = 128) {
  const g = ctx2d(canvas);
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] >= threshold ? 255 : 0;
  g.putImageData(img, 0, 0);
  return canvas;
}
