import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  HEADLIGHT_NAME,
  WHEEL_NAME,
  bestSquare,
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
