import { createCanvas, ctx2d, drawUvGuide, museSizeFor, resizeCanvas } from './imageUtils.js';

/**
 * Helpers for painting an atlas one part at a time: each part is cut out on its own,
 * the rest of the crop is greyed out, it is padded to an aspect ratio the image model
 * supports, and the painted result is pasted back only inside the part's own islands.
 */

export const OUTSIDE_GREY = '#808080';

/**
 * The part's UV area as an opaque-white-on-transparent canvas, grown by `grow` pixels
 * so the paste-back also covers antialiased island edges.
 */
export function partMask(slot, part, width, height, grow = 2) {
  return drawUvGuide(slot, width, height, {
    meshes: part.meshes,
    islands: part.islands,
    tris: part.tris,
    fill: true,
    wireframe: false,
    fillColor: '#ffffff',
    background: null,
    lineWidth: Math.max(1, grow * 2),
  });
}

/** Bounding rectangle of the mask's covered pixels plus `margin`, or null if empty. */
export function maskRect(mask, margin = 0) {
  const { width: w, height: h } = mask;
  const d = ctx2d(mask).getImageData(0, 0, w, h).data;
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1,
    count = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (d[(row + x) * 4 + 3] < 128) continue;
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - margin);
  y0 = Math.max(0, y0 - margin);
  x1 = Math.min(w - 1, x1 + margin);
  y1 = Math.min(h - 1, y1 + margin);
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, pixels: count };
}

/** Copies `rect` out of `src`. */
export function cropCanvas(src, rect) {
  const c = createCanvas(rect.width, rect.height);
  ctx2d(c).drawImage(src, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return c;
}

/** The part cut out of the atlas, with every pixel outside its mask filled flat grey. */
export function greyedCrop(atlas, mask, rect) {
  const c = cropCanvas(atlas, rect);
  const grey = createCanvas(rect.width, rect.height);
  const g = ctx2d(grey);
  g.fillStyle = OUTSIDE_GREY;
  g.fillRect(0, 0, rect.width, rect.height);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(mask, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  ctx2d(c).drawImage(grey, 0, 0);
  return c;
}

/** The mask cropped to `rect` as a white-on-black image (sent to the image model as a guide). */
export function maskImage(mask, rect) {
  const c = createCanvas(rect.width, rect.height);
  const g = ctx2d(c);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, rect.width, rect.height);
  g.drawImage(mask, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  return c;
}

/**
 * Pads `src` (centered, with `fill`) to the closest aspect ratio Muse can output, and
 * scales it so its longest side is at least `minSide`. Returns the padded canvas and
 * where the original sits inside it, so the painted result can be cut back out.
 */
export function padToMuseAspect(src, { fill = OUTSIDE_GREY, minSide = 768 } = {}) {
  const [tw, th] = museSizeFor(src.width, src.height).split('x').map(Number);
  const target = tw / th;
  let w = src.width,
    h = src.height;
  if (w / h > target) h = Math.round(w / target);
  else w = Math.round(h * target);
  const scale = Math.max(1, minSide / Math.max(w, h));
  const c = createCanvas(Math.round(w * scale), Math.round(h * scale));
  const g = ctx2d(c);
  g.fillStyle = fill;
  g.fillRect(0, 0, c.width, c.height);
  const box = {
    x: Math.round(((w - src.width) / 2) * scale),
    y: Math.round(((h - src.height) / 2) * scale),
    width: Math.round(src.width * scale),
    height: Math.round(src.height * scale),
  };
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, box.x, box.y, box.width, box.height);
  return { canvas: c, box };
}

/** Undoes padToMuseAspect on a painted result (any size): returns a canvas of `outW`×`outH`. */
export function unpad(painted, padded, box, outW, outH) {
  const sx = painted.width / padded.width;
  const sy = painted.height / padded.height;
  const c = createCanvas(outW, outH);
  const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.drawImage(painted, box.x * sx, box.y * sy, box.width * sx, box.height * sy, 0, 0, outW, outH);
  return c;
}

/** Draws `painted` (sized like `rect`) onto `target` at `rect`, only where the mask covers. */
export function pasteInsideMask(target, painted, mask, rect) {
  const piece = createCanvas(rect.width, rect.height);
  const g = ctx2d(piece);
  g.drawImage(painted, 0, 0, rect.width, rect.height);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mask, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  ctx2d(target).drawImage(piece, rect.x, rect.y);
  return target;
}

/** A fresh copy of `src`. */
export function copyCanvas(src) {
  return resizeCanvas(src, src.width, src.height);
}

/** Runs `fn` over `items` with at most `limit` running at once; resolves like Promise.allSettled. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Median color of `src` pixels where `mask` (same size, white = in) is set; null if none. */
export function maskedMedian(src, mask) {
  const w = src.width,
    h = src.height;
  const d = ctx2d(src).getImageData(0, 0, w, h).data;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const ch = [[], [], []];
  const step = Math.max(1, Math.floor((w * h) / 40000));
  for (let i = 0; i < w * h; i += step) {
    if (m[i * 4] < 128 || m[i * 4 + 3] < 128) continue;
    ch[0].push(d[i * 4]);
    ch[1].push(d[i * 4 + 1]);
    ch[2].push(d[i * 4 + 2]);
  }
  if (!ch[0].length) return null;
  return ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]);
}

/**
 * Skin leftovers: in a clothing area, pixels that came back skin-colored (close to `skin`)
 * are refilled from the surrounding paint, when they are only a small part of the area
 * (below `maxFraction`; more than that is taken as intended, e.g. short sleeves).
 * `mask` is white where the area is; `halo` pixels around each patch are refilled too. Returns the fraction of pixels refilled.
 */
export function fillSkinLeftovers(painted, mask, skin, { maxFraction = 0.35, tolerance = 48, halo = 2 } = {}) {
  const w = painted.width,
    h = painted.height;
  const ctx = ctx2d(painted);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(w * h);
  const bad = new Uint8Array(w * h);
  let n = 0,
    nBad = 0;
  const tol2 = tolerance * tolerance;
  for (let i = 0; i < w * h; i++) {
    if (m[i * 4] < 128) continue;
    inside[i] = 1;
    n++;
    const dr = d[i * 4] - skin[0],
      dg = d[i * 4 + 1] - skin[1],
      db = d[i * 4 + 2] - skin[2];
    if (dr * dr + dg * dg + db * db < tol2) {
      bad[i] = 1;
      nBad++;
    }
  }
  if (!n || !nBad) return 0;
  const frac = nBad / n;
  if (frac > maxFraction) return 0;
  growFill(d, w, h, inside, bad, halo);
  ctx.putImageData(img, 0, 0);
  return frac;
}

/**
 * One face only: in a face area made of several separate pieces (the face plus the back of
 * the head, ears, neck…), only the biggest piece keeps the painted face. The other pieces
 * get the painted skin color: the median of what the original skin pixels of the main piece
 * became. `painted` and `original` are crops of the same size; `mask` is white on the area.
 * Returns the number of pieces filled.
 */
export function oneFaceOnly(painted, original, mask, { tolerance = 40, maxShare = 0.6 } = {}) {
  const w = painted.width,
    h = painted.height;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const label = new Int32Array(w * h).fill(-1);
  const sizes = [];
  for (let i = 0; i < w * h; i++) {
    if (m[i * 4] < 128 || label[i] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [i];
    label[i] = id;
    while (stack.length) {
      const j = stack.pop();
      n++;
      const x = j % w;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        if (label[k] >= 0 || m[k * 4] < 128) continue;
        label[k] = id;
        stack.push(k);
      }
    }
    sizes.push(n);
  }
  if (sizes.length < 2) return 0;
  const main = sizes.indexOf(Math.max(...sizes));
  const od = ctx2d(original).getImageData(0, 0, w, h).data;
  const pctx = ctx2d(painted);
  const img = pctx.getImageData(0, 0, w, h);
  const d = img.data;
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
  const was = [[], [], []];
  for (let i = 0; i < w * h; i += 2) if (label[i] === main) for (let c = 0; c < 3; c++) was[c].push(od[i * 4 + c]);
  const skin = was.map(med);
  const now = [[], [], []];
  for (let i = 0; i < w * h; i += 2) {
    if (label[i] !== main) continue;
    if (Math.hypot(od[i * 4] - skin[0], od[i * 4 + 1] - skin[1], od[i * 4 + 2] - skin[2]) > tolerance) continue;
    for (let c = 0; c < 3; c++) now[c].push(d[i * 4 + c]);
  }
  if (!now[0].length) return 0;
  const newSkin = now.map(med);
  // Only when the face was painted as a face: most of its skin is now one color. (When the
  // image model drew a picture instead, the "skin" is many colors and nothing is spread.)
  let same = 0;
  for (let k = 0; k < now[0].length; k++)
    if (Math.hypot(now[0][k] - newSkin[0], now[1][k] - newSkin[1], now[2][k] - newSkin[2]) < tolerance) same++;
  if (same / now[0].length < 0.6) return 0;
  const fill = new Set();
  sizes.forEach((n, id) => {
    if (id !== main && n < sizes[main] * maxShare) fill.add(id);
  });
  if (!fill.size) return 0;
  for (let i = 0; i < w * h; i++) {
    if (!fill.has(label[i])) continue;
    d[i * 4] = newSkin[0];
    d[i * 4 + 1] = newSkin[1];
    d[i * 4 + 2] = newSkin[2];
  }
  pctx.putImageData(img, 0, 0);
  return fill.size;
}

/**
 * The skin color after painting: the median of `painted` where `original` (same size) was
 * close to `skin` inside `mask`. Null when no skin pixels are found.
 */
export function paintedSkin(painted, original, mask, skin, tolerance = 40) {
  const w = painted.width,
    h = painted.height;
  const d = ctx2d(painted).getImageData(0, 0, w, h).data;
  const od = ctx2d(original).getImageData(0, 0, w, h).data;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const ch = [[], [], []];
  const step = Math.max(1, Math.floor((w * h) / 40000));
  for (let i = 0; i < w * h; i += step) {
    if (m[i * 4] < 128) continue;
    if (Math.hypot(od[i * 4] - skin[0], od[i * 4 + 1] - skin[1], od[i * 4 + 2] - skin[2]) > tolerance) continue;
    for (let c = 0; c < 3; c++) ch[c].push(d[i * 4 + c]);
  }
  if (!ch[0].length) return null;
  return ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]);
}

/** Grows the good paint (inside && !bad) into the bad pixels; first widens `bad` by `halo` px. */
function growFill(d, w, h, inside, bad, halo = 2) {
  for (let ring = 0; ring < halo; ring++) {
    const grow = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!inside[i] || bad[i]) continue;
        if ((x > 0 && bad[i - 1]) || (x < w - 1 && bad[i + 1]) || (y > 0 && bad[i - w]) || (y < h - 1 && bad[i + w]))
          grow.push(i);
      }
    }
    for (const i of grow) bad[i] = 1;
  }
  const good = new Uint8Array(w * h);
  let left = 0;
  for (let i = 0; i < w * h; i++) {
    good[i] = inside[i] && !bad[i] ? 1 : 0;
    if (inside[i] && bad[i]) left++;
  }
  for (let pass = 0; pass < 400 && left > 0; pass++) {
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!bad[i] || good[i]) continue;
        let r = 0,
          g = 0,
          b = 0,
          c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!good[j]) continue;
            r += d[j * 4];
            g += d[j * 4 + 1];
            b += d[j * 4 + 2];
            c++;
          }
        }
        if (c) add.push(i, r / c, g / c, b / c);
      }
    }
    if (!add.length) break;
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k];
      d[i * 4] = add[k + 1];
      d[i * 4 + 1] = add[k + 2];
      d[i * 4 + 2] = add[k + 3];
      good[i] = 1;
      left--;
    }
  }
}

/**
 * Background leftovers: big near-black (or flat outside-grey) blobs inside a clothing area,
 * where the image model drew the gap between two trouser legs or a background instead of
 * fabric. Thin dark lines and small dark details are kept. Blobs are filled from the
 * surrounding paint when together they are under `maxFraction` of the area.
 * Returns the fraction of pixels refilled.
 */
export function fillBackgroundLeftovers(painted, mask, { maxFraction = 0.3, minSize = 0.03 } = {}) {
  const w = painted.width,
    h = painted.height;
  const ctx = ctx2d(painted);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(w * h);
  const dark = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (m[i * 4] < 128) continue;
    inside[i] = 1;
    n++;
    const r = d[i * 4],
      g = d[i * 4 + 1],
      b = d[i * 4 + 2];
    const grey = Math.abs(r - 128) < 10 && Math.abs(g - 128) < 10 && Math.abs(b - 128) < 10;
    if (Math.max(r, g, b) < 28 || grey) dark[i] = 1;
  }
  if (!n) return 0;
  const bad = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const minSide = Math.max(3, Math.min(w, h) * minSize);
  let nBad = 0;
  for (let i = 0; i < w * h; i++) {
    if (!dark[i] || seen[i]) continue;
    const cells = [];
    const stack = [i];
    seen[i] = 1;
    let x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0;
    while (stack.length) {
      const j = stack.pop();
      cells.push(j);
      const x = j % w,
        y = (j / w) | 0;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k] || !dark[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    const bw = x1 - x0 + 1,
      bh = y1 - y0 + 1;
    // A blob, not a line: wide in both directions and fairly solid.
    if (Math.min(bw, bh) < minSide || cells.length < bw * bh * 0.25) continue;
    for (const j of cells) bad[j] = 1;
    nBad += cells.length;
  }
  if (!nBad) return 0;
  const frac = nBad / n;
  if (frac > maxFraction) return 0;
  growFill(d, w, h, inside, bad, 2);
  ctx.putImageData(img, 0, 0);
  return frac;
}

/**
 * Fills the mask of `crop` with a tiled material texture, shaded by the original's
 * light and dark (relative to its median), so creases and finger lines stay visible.
 */
export function materialFill(crop, mask, tex) {
  const w = crop.width,
    h = crop.height;
  const out = createCanvas(w, h);
  const octx = ctx2d(out);
  const tile = Math.max(64, Math.round(Math.max(w, h) / 2));
  const t = resizeCanvas(tex, tile, tile);
  for (let y = 0; y < h; y += tile) for (let x = 0; x < w; x += tile) octx.drawImage(t, x, y);
  const o = octx.getImageData(0, 0, w, h);
  const src = ctx2d(crop).getImageData(0, 0, w, h).data;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const lum = (i) => 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  const ls = [];
  for (let i = 0; i < w * h; i += 7) if (m[i * 4] >= 128) ls.push(lum(i * 4));
  ls.sort((a, b) => a - b);
  const med = Math.max(1, ls[ls.length >> 1] ?? 128);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (m[i] < 128) {
      o.data[i] = src[i];
      o.data[i + 1] = src[i + 1];
      o.data[i + 2] = src[i + 2];
      o.data[i + 3] = src[i + 3];
      continue;
    }
    const k = Math.min(1.35, Math.max(0.55, lum(i) / med));
    for (let c = 0; c < 3; c++) o.data[i + c] = Math.min(255, o.data[i + c] * k);
    o.data[i + 3] = 255;
  }
  octx.putImageData(o, 0, 0);
  return out;
}

/**
 * Narrow pieces between wider ones (e.g. a crotch / inseam strip between two trouser legs,
 * laid out as its own column) are set to the median color of the wider pieces. Works on
 * column spans of the mask. Returns the number of pieces changed.
 */
export function plainNarrowSpans(painted, mask, { maxRatio = 0.35 } = {}) {
  const w = painted.width,
    h = painted.height;
  const m = ctx2d(mask).getImageData(0, 0, w, h).data;
  const pctx = ctx2d(painted);
  const img = pctx.getImageData(0, 0, w, h);
  const covered = (x) => {
    let n = 0;
    for (let y = 0; y < h; y++) if (m[(y * w + x) * 4] >= 128 && ++n >= 2) return true;
    return false;
  };
  const spans = [];
  for (let x = 0; x < w; x++) {
    if (!covered(x)) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === x - 1) last.end = x;
    else spans.push({ start: x, end: x });
  }
  if (spans.length < 3) return 0;
  const width = (s) => s.end - s.start + 1;
  const maxW = Math.max(...spans.map(width));
  const narrow = spans.filter((s, i) => i > 0 && i < spans.length - 1 && width(s) < maxW * maxRatio);
  // Only between two wide pieces (two limbs side by side).
  if (!narrow.length || spans.filter((s) => width(s) >= maxW * 0.6).length < 2) return 0;
  const ch = [[], [], []];
  for (const s of spans) {
    if (narrow.includes(s)) continue;
    for (let y = 0; y < h; y += 2)
      for (let x = s.start; x <= s.end; x += 2) {
        const i = (y * w + x) * 4;
        if (m[i] < 128) continue;
        for (let c = 0; c < 3; c++) ch[c].push(img.data[i + c]);
      }
  }
  if (!ch[0].length) return 0;
  const med = ch.map((a) => a.sort((x, y) => x - y)[a.length >> 1]);
  for (const s of narrow)
    for (let y = 0; y < h; y++)
      for (let x = s.start; x <= s.end; x++) {
        const i = (y * w + x) * 4;
        if (m[i] < 128) continue;
        img.data[i] = med[0];
        img.data[i + 1] = med[1];
        img.data[i + 2] = med[2];
        img.data[i + 3] = 255;
      }
  pctx.putImageData(img, 0, 0);
  return narrow.length;
}

/** Shifts a canvas horizontally by `dx` pixels, wrapping round (dx > 0 moves right). */
export function rollCanvas(src, dx) {
  const w = src.width;
  const c = createCanvas(w, src.height);
  const g = ctx2d(c);
  const d = ((Math.round(dx) % w) + w) % w;
  g.drawImage(src, d, 0);
  g.drawImage(src, d - w, 0);
  return c;
}

/**
 * Face check: the dark features of the original face (eyes, brows, mouth: dark blobs inside
 * the area, not touching its edge) must still show detail in the painted face. Returns
 * { total, kept, lost: [{x, y}] } with blob centers as fractions of the crop size.
 */
export function faceFeaturesKept(original, painted, mask) {
  const W = original.width,
    H = original.height;
  const s = Math.min(1, 160 / Math.max(W, H));
  const w = Math.max(8, Math.round(W * s)),
    h = Math.max(8, Math.round(H * s));
  const o = ctx2d(resizeCanvas(original, w, h)).getImageData(0, 0, w, h).data;
  const p = ctx2d(resizeCanvas(painted, w, h)).getImageData(0, 0, w, h).data;
  const m = ctx2d(resizeCanvas(mask, w, h)).getImageData(0, 0, w, h).data;
  const lum = (d, i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const inside = (i) => m[i * 4] >= 128;
  const ls = [];
  let area = 0;
  for (let i = 0; i < w * h; i++) if (inside(i)) (ls.push(lum(o, i)), area++);
  if (!area) return { total: 0, kept: 0, lost: [] };
  ls.sort((a, b) => a - b);
  const skinL = ls[ls.length >> 1];
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (inside(i) && lum(o, i) < skinL * 0.6) dark[i] = 1;
  const seen = new Uint8Array(w * h);
  let total = 0,
    kept = 0;
  const lost = [];
  for (let i0 = 0; i0 < w * h; i0++) {
    if (!dark[i0] || seen[i0]) continue;
    const stack = [i0];
    seen[i0] = 1;
    let n = 0,
      edge = false,
      x0 = w,
      y0 = h,
      x1 = 0,
      y1 = 0;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w,
        y = (i / w) | 0;
      n++;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          edge = true;
          continue;
        }
        const j = ny * w + nx;
        if (!inside(j)) edge = true;
        else if (dark[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (edge || n < area * 0.002 || n > area * 0.2) continue;
    total++;
    // Detail in the painted image over the blob's box (a little grown): its luminance spread.
    let sum = 0,
      sum2 = 0,
      c = 0;
    for (let y = Math.max(0, y0 - 1); y <= Math.min(h - 1, y1 + 1); y++)
      for (let x = Math.max(0, x0 - 1); x <= Math.min(w - 1, x1 + 1); x++) {
        const L = lum(p, y * w + x);
        sum += L;
        sum2 += L * L;
        c++;
      }
    const sd = Math.sqrt(Math.max(0, sum2 / c - (sum / c) ** 2));
    if (sd >= 16) kept++;
    else
      lost.push({
        x: (x0 + x1) / 2 / w,
        y: (y0 + y1) / 2 / h,
        box: [(x0 - 1) / w, (y0 - 1) / h, (x1 + 2) / w, (y1 + 2) / h],
        skinL,
      });
  }
  return { total, kept, lost };
}

/**
 * Last resort for lost face features: copies the original's dark feature pixels (eyes,
 * brows, mouth lines) inside each lost feature's box onto the painted face.
 */
export function restoreFeatures(painted, original, lost) {
  const w = painted.width,
    h = painted.height;
  const pg = ctx2d(painted);
  const img = pg.getImageData(0, 0, w, h);
  const o = ctx2d(original).getImageData(0, 0, w, h).data;
  for (const f of lost) {
    const [bx0, by0, bx1, by1] = f.box;
    for (let y = Math.max(0, Math.floor(by0 * h)); y < Math.min(h, Math.ceil(by1 * h)); y++)
      for (let x = Math.max(0, Math.floor(bx0 * w)); x < Math.min(w, Math.ceil(bx1 * w)); x++) {
        const i = (y * w + x) * 4;
        const L = 0.299 * o[i] + 0.587 * o[i + 1] + 0.114 * o[i + 2];
        if (L >= f.skinL * 0.75) continue;
        img.data[i] = o[i];
        img.data[i + 1] = o[i + 1];
        img.data[i + 2] = o[i + 2];
      }
  }
  pg.putImageData(img, 0, 0);
}
