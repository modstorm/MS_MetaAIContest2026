import { createCanvas, ctx2d, resizeCanvas } from './imageUtils.js';

/**
 * Local derivation of PBR maps from a new base color, so normal and roughness
 * follow the new theme without extra model calls.
 */

function heightField(albedo) {
  const d = ctx2d(albedo).getImageData(0, 0, albedo.width, albedo.height).data;
  const h = new Float32Array(albedo.width * albedo.height);
  for (let i = 0; i < h.length; i++) {
    h[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  }
  return h;
}

/**
 * Builds a tangent-space normal map: Sobel normals from the new albedo's
 * luminance, blended over the original normal map (if any) with a
 * whiteout-style blend so the original large-scale detail survives.
 */
export function deriveNormalMap(newAlbedo, originalNormal, strength = 2.0) {
  const w = newAlbedo.width;
  const hgt = newAlbedo.height;
  const h = heightField(newAlbedo);
  const base = originalNormal
    ? ctx2d(
        originalNormal.width === w && originalNormal.height === hgt
          ? originalNormal
          : resizeCanvas(originalNormal, w, hgt),
      ).getImageData(0, 0, w, hgt).data
    : null;
  const out = createCanvas(w, hgt);
  const img = ctx2d(out).createImageData(w, hgt);
  const at = (x, y) => h[Math.min(hgt - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      // Detail normal (glTF: +Y up in tangent space, image y grows downward).
      let nx = -dx * strength;
      let ny = dy * strength;
      let nz = 1;
      const i = (y * w + x) * 4;
      if (base) {
        const bx = base[i] / 127.5 - 1;
        const by = base[i + 1] / 127.5 - 1;
        const bz = base[i + 2] / 127.5 - 1;
        // Whiteout blend: (b.xy + d.xy, b.z * d.z)
        nx = bx + nx;
        ny = by + ny;
        nz = bz * nz;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      img.data[i] = (nx / len + 1) * 127.5;
      img.data[i + 1] = (ny / len + 1) * 127.5;
      img.data[i + 2] = (nz / len + 1) * 127.5;
      img.data[i + 3] = 255;
    }
  }
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}

/**
 * Builds a roughness map from the new albedo (darker / more saturated = slightly
 * glossier), mixed with the original roughness so painted gloss regions stay.
 * If `originalPacked` is a glTF metallicRoughness texture, the result is written
 * into its G channel and B (metalness) is preserved.
 */
export function deriveRoughnessMap(newAlbedo, originalPacked, options = {}) {
  const { baseRoughness = 0.7, mix = 0.5 } = options;
  const w = newAlbedo.width;
  const hgt = newAlbedo.height;
  const a = ctx2d(newAlbedo).getImageData(0, 0, w, hgt).data;
  const o = originalPacked
    ? ctx2d(
        originalPacked.width === w && originalPacked.height === hgt
          ? originalPacked
          : resizeCanvas(originalPacked, w, hgt),
      ).getImageData(0, 0, w, hgt).data
    : null;
  const out = createCanvas(w, hgt);
  const img = ctx2d(out).createImageData(w, hgt);
  for (let i = 0; i < w * hgt; i++) {
    const r = a[i * 4] / 255,
      g = a[i * 4 + 1] / 255,
      b = a[i * 4 + 2] / 255;
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const sat = max === 0 ? 0 : (max - min) / max;
    let rough = baseRoughness + (lum - 0.5) * 0.3 - sat * 0.15;
    if (o) rough = rough * (1 - mix) + (o[i * 4 + 1] / 255) * mix;
    rough = Math.min(1, Math.max(0.04, rough));
    const v = rough * 255;
    img.data[i * 4] = o ? o[i * 4] : 255; // R unused in glTF (often AO when packed ORM)
    img.data[i * 4 + 1] = v; // G = roughness
    img.data[i * 4 + 2] = o ? o[i * 4 + 2] : 0; // B = metalness
    img.data[i * 4 + 3] = 255;
  }
  ctx2d(out).putImageData(img, 0, 0);
  return out;
}
