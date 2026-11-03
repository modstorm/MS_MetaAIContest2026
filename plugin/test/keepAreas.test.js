import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  HEADLIGHT_NAME,
  WHEEL_NAME,
  bestSquare,
  cleanAroundLights,
  isColorful,
  dominantColor,
  namesOf,
  nearColor,
} from '../src/analysis/keepAreas.js';

const mesh = (name, parentName, matName = 'lambert1') => {
  const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ name: matName }));
  m.name = name;
  if (parentName != null) {
    const g = new THREE.Group();
    g.name = parentName;
    g.add(m);
  }
  return m;
};

describe('vehicle keep areas: names', () => {
  it('a body grouped with a wheel by the editor is not a wheel', () => {
    // ModStorm groups a car as "<body> + <wheel>": the whole body was kept as tyre tread.
    const body = mesh('vehicle_porsche_red_01', 'vehicle_porsche_red_01 + vehicle_wheel_sportscar_04');
    expect(WHEEL_NAME.test(namesOf(body))).toBe(false);
    const wheel = mesh('vehicle_wheel_sportscar_04', 'vehicle_porsche_red_01 + vehicle_wheel_sportscar_04');
    expect(WHEEL_NAME.test(namesOf(wheel))).toBe(true);
  });
  it('an unnamed primitive takes its parent name', () => {
    expect(WHEEL_NAME.test(namesOf(mesh('', 'Wheel_FL')))).toBe(true);
    expect(HEADLIGHT_NAME.test(namesOf(mesh('mesh_1', 'Headlight_L')))).toBe(true);
    expect(HEADLIGHT_NAME.test(namesOf(mesh('Mirror_L', 'Lights')))).toBe(false);
  });
});

describe('vehicle keep areas: body color', () => {
  it('finds the main color and the square richest in it', () => {
    const W = 16,
      H = 16;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const on = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const red = p % W >= 8;
      rgba.set(red ? [200, 20, 20, 255] : [250, 250, 250, 255], p * 4);
      if (red || p < 20) on[p] = red ? 1 : 0;
    }
    const c = dominantColor(rgba, (p) => p % W >= 4);
    expect(nearColor(c[0], c[1], c[2], [200, 20, 20], 4)).toBe(true);
    expect(nearColor(250, 250, 250, c)).toBe(false);
    const sq = bestSquare(on, W, H, 6);
    expect(sq.share).toBe(1);
    expect(sq.x).toBeGreaterThanOrEqual(8);
  });
});

import { parsePartRoles } from '../src/muse/prompts.js';
import { mergeBodyPanels, roleKey } from '../src/ReskinPlugin.js';

describe("Muse's part roles come before names", () => {
  it('parses roles and maps synonyms', () => {
    expect(parsePartRoles({ 'Wheel FL': 'tires', Body: 'body', X: 'banana', Lamp: 'headlight' })).toEqual({
      'Wheel FL': 'tyre',
      Body: 'body',
      Lamp: 'light',
    });
    expect(parsePartRoles(null)).toBeUndefined();
    expect(roleKey('Wheel_FL')).toBe(roleKey('wheel fl'));
  });
  it('a part Muse calls body is merged into the body even if its name says grille', () => {
    const p = (name) => ({ name, meshes: [], bbox: [0, 0, 1, 1], area: 1 });
    const parts = [p('Door'), p('Hood'), p('Grille'), p('Light Bar')];
    const merged = mergeBodyPanels(parts, { grille: 'trim', 'light bar': 'body', hood: 'glass' });
    expect(merged[0].mergedFrom.sort()).toEqual(['Door', 'Grille', 'Light Bar']);
    expect(mergeBodyPanels(parts)[0].mergedFrom.sort()).toEqual(['Door', 'Hood']);
  });
});

import { sameShade } from '../src/analysis/keepAreas.js';

describe('old body paint in SAM-found kept areas', () => {
  it('a shaded red mirror matches red body paint, a white lens does not', () => {
    const body = [200, 10, 25];
    expect(sameShade(110, 4, 12, body)).toBe(true); // dark red mirror side
    expect(sameShade(235, 235, 240, body)).toBe(false); // headlight lens
    expect(sameShade(20, 20, 20, body)).toBe(false); // black trim
    expect(sameShade(230, 160, 20, body)).toBe(false); // amber indicator
  });
  it('the most common paint counts all its shades together', () => {
    const px = [];
    for (let i = 0; i < 30; i++) px.push(90 + i * 4, 5, 10, 255); // 30 reds, all different
    for (let i = 0; i < 20; i++) px.push(240, 240, 240, 255); // 20 identical whites
    const c = dominantColor(new Uint8ClampedArray(px), () => true);
    expect(c[0]).toBeGreaterThan(100);
    expect(c[1]).toBeLessThan(20);
  });
});

describe('cleanAroundLights', () => {
  // 64×64: a light disc (radius 6) at the center. Original: white body, light grey lens.
  // Painted by "Muse": black body with a blue splash ring around the light and a blue line
  // over the lens.
  const W = 64,
    H = 64,
    N = W * H;
  const setup = (bodyColor) => {
    const orig = new Uint8ClampedArray(N * 4),
      painted = new Uint8ClampedArray(N * 4);
    const light = new Uint8Array(N),
      cover = new Uint8Array(N).fill(1);
    for (let p = 0; p < N; p++) {
      const x = p % W,
        y = (p - x) / W,
        r = Math.hypot(x - 32, y - 32);
      const i = p * 4;
      const o = r <= 3 ? [220, 220, 225] : bodyColor;
      orig.set([...o, 255], i);
      light[p] = r <= 6 ? 1 : 0;
      const splash = r > 6 && r <= 9;
      painted.set([...(splash ? [20, 80, 240] : [10, 10, 10]), 255], i);
    }
    return { orig, painted, light, cover };
  };
  it('a white body: the splash around the light gets the paint next to it, the lens stays', () => {
    const { orig, painted, light, cover } = setup([245, 245, 245]);
    const before = new Uint8ClampedArray(painted);
    for (let p = 0; p < N; p++) if (light[p]) painted.set(orig.subarray(p * 4, p * 4 + 3), p * 4);
    const r = cleanAroundLights({
      W,
      H,
      painted,
      before,
      orig,
      light,
      kept: light,
      cover,
      body: [245, 245, 245],
      bodyInside: () => false,
      bodyAround: (i) => nearColor(orig[i], orig[i + 1], orig[i + 2], [245, 245, 245], 64),
      ring: 4,
    });
    expect(r.lights).toBe(1);
    expect(r.around).toBeGreaterThan(0);
    const at = (x, y) => [...painted.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
    expect(at(32 + 8, 32)[2]).toBeLessThan(40); // splash gone
    expect(at(32, 32)).toEqual([220, 220, 225]); // lens original
    expect(at(32 + 5, 32)).toEqual([245, 245, 245]); // white housing kept (can't tell from a lens)
  });
  it('a red body: old red inside the light area gets the new paint too', () => {
    const red = [200, 20, 20];
    const { orig, painted, light, cover } = setup(red);
    const before = new Uint8ClampedArray(painted);
    for (let p = 0; p < N; p++) if (light[p]) painted.set(orig.subarray(p * 4, p * 4 + 3), p * 4);
    const isRed = (i) => isColorful(red) && sameShade(orig[i], orig[i + 1], orig[i + 2], red, 64);
    const r = cleanAroundLights({
      W,
      H,
      painted,
      before,
      orig,
      light,
      kept: light,
      cover,
      body: red,
      bodyInside: (i) => light[i / 4] && isRed(i),
      bodyAround: isRed,
      ring: 4,
    });
    expect(r.inside).toBeGreaterThan(0);
    const at = (x, y) => [...painted.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)];
    expect(at(32 + 5, 32)[0]).toBeLessThan(40); // red housing now black
    expect(at(32 + 8, 32)[2]).toBeLessThan(40);
    expect(at(32, 32)).toEqual([220, 220, 225]);
  });
  it('isColorful: red yes, white/grey/black no', () => {
    expect(isColorful([200, 20, 20])).toBe(true);
    expect(isColorful([245, 245, 245])).toBe(false);
    expect(isColorful([120, 120, 125])).toBe(false);
    expect(isColorful([10, 10, 12])).toBe(false);
  });
});
