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
