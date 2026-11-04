import { describe, expect, it } from 'vitest';
import { isPrototypeGrid } from '../src/texture/prototype.js';
import { isPlaceholderName, seamlessTexturePrompt } from '../src/muse/prompts.js';

const img = (W, H, f) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
};
// A repeatable "random" for noisy pictures.
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

describe('isPrototypeGrid', () => {
  it('finds grids, checkers and blank swatches', () => {
    expect(
      isPrototypeGrid(img(256, 256, (x, y) => (x % 32 < 2 || y % 32 < 2 ? [230, 230, 230] : [120, 120, 125]))),
    ).toBe(true);
    expect(isPrototypeGrid(img(256, 128, (x, y) => (((x >> 4) + (y >> 4)) % 2 ? [40, 40, 40] : [200, 200, 200])))).toBe(
      true,
    );
    expect(isPrototypeGrid(img(64, 64, () => [128, 128, 128]))).toBe(true);
    // Light noise on a grid still counts.
    expect(
      isPrototypeGrid(
        img(256, 256, (x, y) =>
          (x % 32 < 2 || y % 32 < 2 ? [230, 230, 230] : [120, 120, 125]).map((v) => v + Math.round(rnd() * 4)),
        ),
      ),
    ).toBe(true);
  });
  it('leaves painted textures alone', () => {
    expect(isPrototypeGrid(img(128, 128, () => [rnd() * 255, rnd() * 255, rnd() * 255]))).toBe(false);
    expect(isPrototypeGrid(img(256, 64, (x) => [x, 255 - x, 128]))).toBe(false);
    // Round blobs in a few flat colours (a stylized texture): edges are not straight lines.
    expect(
      isPrototypeGrid(
        img(128, 128, (x, y) =>
          Math.hypot((x % 40) - 20, (y % 40) - 20) < 12 + 3 * Math.sin(x / 5) ? [200, 60, 40] : [40, 90, 160],
        ),
      ),
    ).toBe(false);
  });
});

describe('placeholder material names', () => {
  it('are left out of the seamless prompt', () => {
    expect(isPlaceholderName('Grid')).toBe(true);
    expect(isPlaceholderName('Material.001')).toBe(true);
    expect(isPlaceholderName('Wood_Floor')).toBe(false);
    expect(seamlessTexturePrompt('lava', 'Grid')).not.toMatch(/Grid/);
    expect(seamlessTexturePrompt('lava', 'Wood_Floor')).toMatch(/Wood_Floor/);
  });
});
