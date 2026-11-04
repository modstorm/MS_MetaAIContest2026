// Prototyping textures (a level grid, a checker, a near-blank swatch) say nothing about the look:
// an editor can send such a model with ignoreSource so Muse paints from the prompt alone.

/**
 * True when the picture is a prototyping grid, a checker or nearly blank: a few flat colours
 * (allowing light noise and small labels) whose edges are straight, axis-aligned lines.
 * @param {HTMLCanvasElement | OffscreenCanvas | HTMLImageElement | ImageBitmap | ImageData | { width: number, height: number, data: ArrayLike<number> }} image
 * @returns {boolean}
 */
export function isPrototypeGrid(image) {
  const px = pixelsOf(image, 128);
  if (!px) return false;
  const { width: W, height: H, data: d } = px;
  const N = W * H;
  // Colour buckets (4 bits a channel) and the overall spread.
  const bucket = new Uint16Array(N);
  let sum = [0, 0, 0],
    sq = [0, 0, 0];
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const b = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    bucket[p] = b;
    for (let c = 0; c < 3; c++) {
      sum[c] += d[i + c];
      sq[c] += d[i + c] * d[i + c];
    }
  }
  const spread = Math.max(...[0, 1, 2].map((c) => Math.sqrt(Math.max(0, sq[c] / N - (sum[c] / N) ** 2))));
  if (spread < 10) return true; // nearly blank
  // A small palette: buckets merged by their mean colour (noise across a bucket edge, too).
  const means = new Map();
  for (let p = 0; p < N; p++) {
    const m = means.get(bucket[p]) ?? [0, 0, 0, 0];
    for (let c = 0; c < 3; c++) m[c] += d[p * 4 + c];
    m[3]++;
    means.set(bucket[p], m);
  }
  const palette = [];
  for (const m of [...means.values()].sort((a, b) => b[3] - a[3]).slice(0, 64)) {
    const col = [m[0] / m[3], m[1] / m[3], m[2] / m[3]];
    const near = palette.find((q) => Math.hypot(q[0] - col[0], q[1] - col[1], q[2] - col[2]) < 30);
    if (near) near[3] += m[3];
    else if (palette.length < 6) palette.push([...col, m[3]]);
  }
  palette.sort((a, b) => b[3] - a[3]);
  const main = palette.slice(0, 4);
  // Each pixel: its palette colour, or 255 (something else).
  const label = new Uint8Array(N);
  let covered = 0;
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    let best = 255,
      bd = 40;
    main.forEach((q, k) => {
      const dd = Math.hypot(d[i] - q[0], d[i + 1] - q[1], d[i + 2] - q[2]);
      if (dd < bd) {
        bd = dd;
        best = k;
      }
    });
    label[p] = best;
    if (best !== 255) covered++;
  }
  if (covered / N < 0.9) return false;
  // Straight edges: a change between neighbours continues along the line (grid lines, checker squares).
  let ev = 0,
    evc = 0,
    eh = 0,
    ehc = 0;
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const p = y * W + x;
      if (label[p] !== label[p + 1]) {
        ev++;
        if (label[p + W] !== label[p + W + 1]) evc++;
      }
      if (label[p] !== label[p + W]) {
        eh++;
        if (label[p + 1] !== label[p + W + 1]) ehc++;
      }
    }
  if (ev + eh === 0) return true;
  return (evc + ehc) / (ev + eh) >= 0.75;
}

/** RGBA pixels of `image`, scaled down to at most `max` on its long side. */
function pixelsOf(image, max) {
  if (!image) return null;
  if (image.data && image.width && image.height) {
    // ImageData-like: sample every step-th pixel.
    const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / max));
    const W = Math.floor(image.width / step),
      H = Math.floor(image.height / step);
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const s = (y * step * image.width + x * step) * 4,
          t = (y * W + x) * 4;
        for (let c = 0; c < 4; c++) data[t + c] = image.data[s + c];
      }
    return { width: W, height: H, data };
  }
  const w = image.width,
    h = image.height;
  if (!w || !h) return null;
  const k = Math.min(1, max / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)),
    H = Math.max(1, Math.round(h * k));
  const c =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d', { willReadFrequently: true });
  // Nearest pixels: smoothing would blur thin grid lines into extra colours.
  g.imageSmoothingEnabled = false;
  g.drawImage(image, 0, 0, W, H);
  return { width: W, height: H, data: g.getImageData(0, 0, W, H).data };
}
