import { describe, expect, it } from 'vitest';
import { calmPoles, seamRatio, wrapAxis } from '../src/texture/seamless.js';
import { reskinTexturePrompt, plainReskinTexturePrompt } from '../src/muse/prompts.js';
import { normalizeAssetClass, getAssetClass } from '../src/assetClasses.js';

/** A w×h RGBA image from f(x, y) → grey value. */
const img = (w, h, f) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  return { data, width: w, height: h };
};

describe('seam tools', () => {
  it('sees a ramp as not tiling and a sine as tiling', () => {
    const ramp = img(64, 32, (x) => x * 4);
    const sine = img(64, 32, (x) => 128 + 100 * Math.sin((2 * Math.PI * x) / 64));
    expect(seamRatio(ramp, 'x')).toBeGreaterThan(10);
    expect(seamRatio(sine, 'x')).toBeLessThan(2);
    // A ramp along x is constant along y, so it tiles vertically.
    expect(seamRatio(ramp, 'y')).toBeLessThan(2);
  });

  it('wrapAxis makes a ramp tile left to right and keeps the middle', () => {
    const ramp = img(64, 8, (x) => x * 4);
    const mid = ramp.data[(4 * 64 + 32) * 4];
    wrapAxis(ramp, 'x', 0.125);
    expect(seamRatio(ramp, 'x')).toBeLessThan(2);
    expect(ramp.data[(4 * 64 + 32) * 4]).toBe(mid);
  });

  it('wrapAxis on y', () => {
    const ramp = img(16, 64, (_x, y) => y * 4);
    wrapAxis(ramp, 'y');
    expect(seamRatio(ramp, 'y')).toBeLessThan(2);
  });

  it('calmPoles flattens the top and bottom rows', () => {
    const noisy = img(32, 100, (x) => (x % 2 ? 255 : 0));
    calmPoles(noisy, 0.05);
    const row0 = [0, 1, 2, 3].map((x) => noisy.data[x * 4]);
    expect(new Set(row0).size).toBe(1);
    const mid = [0, 1].map((x) => noisy.data[(50 * 32 + x) * 4]);
    expect(mid).toEqual([0, 255]);
  });
});

describe('texture prompts', () => {
  it('equirect sky asks for a level horizon and joined edges', () => {
    const p = reskinTexturePrompt('stormy dusk', { wrap: 'equirect', context: 'skybox' });
    expect(p).toMatch(/equirectangular/);
    expect(p).toMatch(/horizon/);
    expect(p).toMatch(/left and right edges must join/);
    expect(p).toContain('stormy dusk');
  });
  it('tiling material asks for all four edges', () => {
    const p = reskinTexturePrompt('lava', { wrap: 'both', name: 'track' });
    expect(p).toMatch(/top\/bottom edges must tile/);
    expect(plainReskinTexturePrompt('lava', 'both')).toMatch(/tile seamlessly/);
  });
  it('track maps to the tiling material class', () => {
    expect(normalizeAssetClass('track')).toBe('material');
    expect(getAssetClass('material').seamless).toBe(true);
    expect(normalizeAssetClass('sky')).toBe('sky');
  });
});
