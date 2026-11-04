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
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (d[i + 3] >= 128 && Math.min(d[i], d[i + 1], d[i + 2]) < 200) mask[p] = 1;
  }
  return growMask(mask, W, H, grow);
}

/**
 * Grows a 0/1 mask by `n` pixels (4-neighbours). With `vertical`, only up and down (a
 * horizontal line becomes a taller band); with `horizontal`, only left and right.
 */
export function growMask(mask, W, H, n, { vertical = false, horizontal = false } = {}) {
  for (let k = 0; k < n; k++) {
    const next = mask.slice();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (mask[p]) continue;
        if (
          (!vertical && x > 0 && mask[p - 1]) ||
          (!vertical && x < W - 1 && mask[p + 1]) ||
          (!horizontal && y > 0 && mask[p - W]) ||
          (!horizontal && y < H - 1 && mask[p + W])
        )
          next[p] = 1;
      }
    mask = next;
  }
  return mask;
}

/** The pixels of `mask` in vertical runs of at least `minRun` (long vertical lines, no text). */
export function verticalRuns(mask, W, H, minRun) {
  const out = new Uint8Array(W * H);
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; ) {
      if (!mask[y * W + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < H && mask[e * W + x]) e++;
      if (e - y >= minRun) for (let k = y; k < e; k++) out[k * W + x] = 1;
      y = e;
    }
  return out;
}

/** The pixels of `mask` in horizontal runs of at least `minRun` (long horizontal lines, no text). */
export function horizontalRuns(mask, W, H, minRun) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; ) {
      if (!mask[y * W + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < W && mask[y * W + e]) e++;
      if (e - x >= minRun) out.fill(1, y * W + x, y * W + e);
      x = e;
    }
  return out;
}

/**
 * Thin light lines already in the original texture (the toy's grey seams between panels, at
 * the knees and above the ankles): pixels at least `step` lighter than the pixels `reach` away
 * on both sides, up and down (a horizontal line) or left and right (a vertical line), in
 * straight runs of at least `minRun` pixels (so laces, badges and wrinkles are left alone).
 * Muse copies these seams from the reference picture, so they are cleaned like template lines.
 * Returns { mask, horizontal }: all line pixels, and those of horizontal lines.
 * @param {HTMLCanvasElement} original same size as the texture
 * @param {Uint8Array} [area] 0/1: only look here (e.g. where templates are drawn)
 */
export function seamLineMask(original, area = null, { step = 20, reach = 4, minRun = 40 } = {}) {
  const W = original.width,
    H = original.height;
  const d = original.getContext('2d').getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) lum[p] = 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  // Off the edge counts as darker, so a line along the border of the image is found too.
  const lighter = (p, q) => q < 0 || q >= W * H || lum[q] <= lum[p] - step;
  const h = new Uint8Array(W * H),
    v = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (area && !area[p]) continue;
      if (lighter(p, p - reach * W) && lighter(p, p + reach * W)) h[p] = 1;
      if ((x < reach || lighter(p, p - reach)) && (x + reach >= W || lighter(p, p + reach))) v[p] = 1;
    }
  const mask = new Uint8Array(W * H),
    horizontal = new Uint8Array(W * H);
  // Keep the straight runs only.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; ) {
      if (!h[y * W + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < W && h[y * W + e]) e++;
      if (e - x >= minRun) for (let k = x; k < e; k++) mask[y * W + k] = horizontal[y * W + k] = 1;
      x = e;
    }
  for (let x = 0; x < W; x++)
    for (let y = 0; y < H; ) {
      if (!v[y * W + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e < H && v[e * W + x]) e++;
      if (e - y >= minRun) for (let k = y; k < e; k++) mask[k * W + x] = 1;
      y = e;
    }
  return { mask, horizontal };
}

/**
 * Fills the masked pixels of `canvas` from the unmasked pixels around them (each pass takes
 * the average of already known 8-neighbours), so a thin line takes the color on both sides.
 * Pixels outside `inside` (0/1, optional: e.g. the texture's islands) are left alone.
 * With `onlyLighter` (a brightness step, e.g. 25), only pixels that much lighter than the fill
 * are changed (less on dark or pale paint, see below); with `minStep`, exactly that much
 * lighter (for wide bands, where only clear light lines may go). Returns the pixels changed.
 */
export function fillMasked(canvas, mask, inside = null, maxPasses = 24, { onlyLighter = 0, minStep = 0 } = {}) {
  const W = canvas.width,
    H = canvas.height;
  const g = canvas.getContext('2d');
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const was = onlyLighter || minStep ? new Uint8ClampedArray(d) : null;
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
      // Lighter than the paint beside it by `onlyLighter`, or by a few percent of that paint
      // (a faint line on a pale shirt), or near-white and lighter at all (the outline color).
      const diff = lum(was, i) - lum(d, i);
      const nearWhite = Math.min(was[i], was[i + 1], was[i + 2]) > 225 && diff > 3;
      const need = minStep || Math.min(onlyLighter, Math.max(6, 0.05 * lum(d, i)));
      if (!nearWhite && diff < need) {
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
