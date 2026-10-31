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
