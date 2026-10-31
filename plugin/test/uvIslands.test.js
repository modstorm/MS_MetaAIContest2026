import { describe, expect, it } from 'vitest';
import { computeUvBounds, computeUvCoverage, computeUvIslands, isTiled } from '../src/analysis/uvIslands.js';
import { parseLayoutPlan } from '../src/muse/prompts.js';

// Two quads: one in the left half, one in the right half (separate islands).
const quadLeft = [0, 0, 0.5, 0, 0.5, 1, 0, 1];
const quadRight = [0.5, 0, 1, 0, 1, 1, 0.5, 1];
const twoQuads = { uvs: new Float32Array([...quadLeft, ...quadRight]), index: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] };

describe('computeUvIslands', () => {
  it('welds vertices that share a UV coordinate', () => {
    // Quads share the edge u=0.5, so welding by UV joins them into one island.
    const islands = computeUvIslands(twoQuads);
    expect(islands).toHaveLength(1);
    expect(islands[0].triangleCount).toBe(4);
    expect(islands[0].area).toBeCloseTo(1, 5);
  });

  it('finds separate islands', () => {
    const uvs = new Float32Array([0, 0, 0.4, 0, 0.4, 0.4, 0.6, 0.6, 1, 0.6, 1, 1]);
    const islands = computeUvIslands({ uvs, index: null });
    expect(islands).toHaveLength(2);
    expect(islands[0].bounds).toEqual({ minU: 0, minV: 0, maxU: expect.closeTo(0.4, 5), maxV: expect.closeTo(0.4, 5) });
  });
});

describe('computeUvCoverage', () => {
  it('measures full coverage with no overlap', () => {
    const c = computeUvCoverage([twoQuads], 64);
    expect(c.coverage).toBeCloseTo(1, 2);
    expect(c.overlap).toBe(0);
  });

  it('detects overlapping (stacked) islands', () => {
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1].map((v, i) => (i >= 6 ? v * 0.999 + 0.0005 : v)));
    const c = computeUvCoverage([{ uvs, index: null }], 64);
    expect(c.coverage).toBeGreaterThan(0.4);
    expect(c.overlap).toBeGreaterThan(0.8);
  });
});

describe('bounds / tiling', () => {
  it('flags UVs outside 0..1 as tiled', () => {
    const b = computeUvBounds({ uvs: [0, 0, 2, 0, 2, 2], index: null });
    expect(b.maxU).toBe(2);
    expect(isTiled(b)).toBe(true);
    expect(isTiled(computeUvBounds(twoQuads))).toBe(false);
  });
});

describe('parseLayoutPlan', () => {
  it('parses JSON wrapped in prose / code fences', () => {
    const plan = parseLayoutPlan(
      'Here you go:\n```json\n{"subject":"robot","regions":[{"name":"head","bbox":[0,0,500,500]},{"nope":1}]}\n```',
    );
    expect(plan?.subject).toBe('robot');
    expect(plan?.regions).toEqual([{ name: 'head', description: undefined, bbox: [0, 0, 500, 500] }]);
  });
  it('returns null for non-JSON', () => {
    expect(parseLayoutPlan('no json here')).toBeNull();
  });
});
