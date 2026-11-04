// Removes the artists' template outlines and labels that Muse copied into the paint.
// Templates show panel borders and words ("knee", "ankle"); they help Muse place the design,
// but Muse also draws them, which shows as thin light lines on the model (the toy's trousers).

/**
 * Pixels of `template` that are drawn (not white), grown by `grow` pixels: a 0/1 map.
 * @param {HTMLCanvasElement} template same size as the texture, white where nothing is drawn
 */
export function templateLineMask(template, grow = 2) {
  const W = template.width,
    H = template.height;
  const d = template.getContext('2d').getImageData(0, 0, W, H).data;
  let mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (d[i + 3] >= 128 && Math.min(d[i], d[i + 1], d[i + 2]) < 200) mask[p] = 1;
  }
  for (let k = 0; k < grow; k++) {
    const next = mask.slice();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (mask[p]) continue;
        if (
          (x > 0 && mask[p - 1]) ||
          (x < W - 1 && mask[p + 1]) ||
          (y > 0 && mask[p - W]) ||
          (y < H - 1 && mask[p + W])
        )
          next[p] = 1;
      }
    mask = next;
  }
  return mask;
}

/**
 * Fills the masked pixels of `canvas` from the unmasked pixels around them (each pass takes
 * the average of already known 8-neighbours), so a thin line takes the color on both sides.
 * Pixels outside `inside` (0/1, optional: e.g. the texture's islands) are left alone.
 * With `onlyLighter` (a brightness step, e.g. 25), only pixels that much lighter than the fill
 * are changed. Returns the number of pixels changed.
 */
export function fillMasked(canvas, mask, inside = null, maxPasses = 24, { onlyLighter = 0 } = {}) {
  const W = canvas.width,
    H = canvas.height;
  const g = canvas.getContext('2d');
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const was = onlyLighter ? new Uint8ClampedArray(d) : null;
  const todo = new Uint8Array(W * H);
  let left = 0;
  for (let p = 0; p < W * H; p++)
    if (mask[p] && (!inside || inside[p])) {
      todo[p] = 1;
      left++;
    }
  const total = left;
  for (let pass = 0; pass < maxPasses && left; pass++) {
    const done = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!todo[p]) continue;
        let r = 0,
          gg = 0,
          b = 0,
          n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx,
              yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const q = yy * W + xx;
            if (todo[q] || (inside && !inside[q])) continue;
            r += d[q * 4];
            gg += d[q * 4 + 1];
            b += d[q * 4 + 2];
            n++;
          }
        if (n) done.push([p, r / n, gg / n, b / n]);
      }
    if (!done.length) break;
    for (const [p, r, gg, b] of done) {
      d[p * 4] = r;
      d[p * 4 + 1] = gg;
      d[p * 4 + 2] = b;
      todo[p] = 0;
      left--;
    }
  }
  let filled = total - left;
  if (was) {
    // Only light lines: a pixel keeps its paint unless it is clearly lighter than what is
    // around the line (a copied outline), so drawn design along a guide line (a collar) stays.
    const lum = (a, i) => 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    for (let p = 0; p < W * H; p++) {
      if (!mask[p] || (inside && !inside[p])) continue;
      const i = p * 4;
      if (lum(was, i) - lum(d, i) < onlyLighter) {
        d[i] = was[i];
        d[i + 1] = was[i + 1];
        d[i + 2] = was[i + 2];
        filled--;
      }
    }
  }
  g.putImageData(img, 0, 0);
  return filled;
}
