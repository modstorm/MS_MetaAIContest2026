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

import { areaThemesPrompt } from '../src/muse/prompts.js';

describe('area themes for buildings', () => {
  it('asks for a roofing material that fits the theme only when there is a roof', () => {
    const withRoof = areaThemesPrompt('overgrown ruin', ['Building (walls) (center)', 'Building (roof)'], 'a house');
    expect(withRoof).toMatch(/simple, uniform roofing surface/);
    expect(areaThemesPrompt('lava', ['Body', 'Head'])).not.toMatch(/roof/);
  });
});

import { detectAssetClass } from '../src/assetClasses.js';

describe('building detection', () => {
  it('car parts named window / door do not make a building', () => {
    expect(detectAssetClass({ partNames: ['Body', 'Window_L', 'Door_FL', 'Door_FR', 'Wheel_FL'] })).not.toBe(
      'building',
    );
    expect(detectAssetClass({ partNames: ['Floor', 'Wall', 'Door'] })).not.toBe('building');
  });
  it('a house is still a building', () => {
    expect(detectAssetClass({ subject: 'a small brick house', partNames: ['Walls', 'Roof'] })).toBe('building');
  });
});

describe('barrels are props', () => {
  it('Prop_Barrel and Muse class text map to prop, not building', async () => {
    const { normalizeAssetClass } = await import('../src/assetClasses.js');
    expect(detectAssetClass({ modelName: 'Prop_Barrel', partNames: ['Prop_Barrel'] })).toBe('prop');
    expect(normalizeAssetClass('prop (wooden barrel structure)')).toBe('prop');
    expect(normalizeAssetClass('Storage barrel')).toBe('prop');
    expect(normalizeAssetClass('building')).toBe('building');
  });
});

describe('vehicle rule in prompts', () => {
  it('puts the lights / tread rule right after the theme, in both paint modes', async () => {
    const { reskinAtlasPrompt, reskinPartPrompt } = await import('../src/muse/prompts.js');
    const { assetClassRules } = await import('../src/assetClasses.js');
    const rules = assetClassRules('vehicle');
    expect(rules[0]).toMatch(/^MOST IMPORTANT RULE: DO NOT CHANGE THE LIGHTS OR THE TYRE TREADS/);
    expect(rules[0]).toMatch(/tail light/);
    const atlas = reskinAtlasPrompt('lava', null, rules.join('\n')).split('\n');
    expect(atlas.findIndex((l) => l.startsWith('MOST IMPORTANT RULE'))).toBe(2);
    const part = reskinPartPrompt('lava', { partName: 'Body', classRules: rules }).split('\n');
    expect(part.findIndex((l) => l.startsWith('MOST IMPORTANT RULE'))).toBeLessThan(4);
    expect(part.filter((l) => /MOST IMPORTANT RULE/.test(l))).toHaveLength(1);
  });
});

describe('vehicle body panels', () => {
  it('doors, fenders and hood are painted as one area; wheels, lights and glass stay apart', async () => {
    const { mergeBodyPanels } = await import('../src/ReskinPlugin.js');
    const part = (name, area, bbox = [0, 0, 100, 100]) => ({ name, area, bbox, meshes: [{ name }] });
    const merged = mergeBodyPanels([
      part('Body', 10, [0, 0, 500, 500]),
      part('Door_L', 3, [600, 0, 700, 200]),
      part('DoorRight', 3),
      part('Hood', 2),
      part('Wheel_FL', 2),
      part('Headlight_L', 1),
      part('Window Glass', 1),
    ]);
    expect(merged[0].name).toBe('Body panels');
    expect(merged[0].mergedFrom).toEqual(['Body', 'Door_L', 'DoorRight', 'Hood']);
    expect(merged[0].meshes).toHaveLength(4);
    expect(merged[0].bbox).toEqual([0, 0, 700, 500]);
    expect(merged.slice(1).map((p) => p.name)).toEqual(['Wheel_FL', 'Headlight_L', 'Window Glass']);
    expect(mergeBodyPanels([part('Body', 1), part('Wheel', 1)])).toBeNull();
  });
  it('the vehicle prompt asks for stripes across every panel and no longer keeps them inside one', async () => {
    const { assetClassRules } = await import('../src/assetClasses.js');
    const rules = assetClassRules('vehicle').join('\n');
    expect(rules).toMatch(/STRIPES AND LINES ARE CONTINUOUS/);
    expect(rules).not.toMatch(/stay inside one panel|whole inside one area/);
  });
});
