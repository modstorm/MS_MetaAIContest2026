import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { uniqueSlotNames } from '../src/analysis/textureLayout.js';
import { mergeStackedNames } from '../src/analysis/parts.js';

describe('uniqueSlotNames', () => {
  it('tells same-named slots apart by their first mesh', () => {
    const slots = uniqueSlotNames([
      { name: 'lambert1', meshes: [{ name: 'carBody' }] },
      { name: 'lambert1', meshes: [{ name: 'tireBackR_1' }, { name: 'tireBackR_2' }] },
      { name: 'glass', meshes: [{ name: 'window' }] },
    ]);
    expect(slots.map((s) => s.name)).toEqual(['lambert1 · carBody', 'lambert1 · tireBackR', 'glass']);
  });

  it('never gives two slots the same name', () => {
    const slots = uniqueSlotNames([
      { name: 'm', meshes: [{ name: 'a' }] },
      { name: 'm', meshes: [{ name: 'a' }] },
      { name: 'm', meshes: [] },
    ]);
    expect(new Set(slots.map((s) => s.name)).size).toBe(3);
  });
});

/** A mesh whose UVs are one quad over [u0,v0]-[u1,v1]. */
function quadMesh(name, [u0, v0, u1, v1]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.Mesh(g);
  m.name = name;
  return m;
}

describe('mergeStackedNames', () => {
  const slot = { uvChannel: 0, texture: null };
  it('joins meshes stacked on the same UVs into one area named by their shared start', () => {
    const byName = new Map(
      ['tireBackR', 'tireBackL', 'tireFrontR', 'tireFrontL'].map((n) => [n, [quadMesh(n, [0.1, 0.1, 0.9, 0.9])]]),
    );
    mergeStackedNames(byName, slot);
    expect([...byName.keys()]).toEqual(['tire']);
    expect(byName.get('tire')).toHaveLength(4);
  });

  it('keeps meshes on different parts of the texture apart', () => {
    const byName = new Map([
      ['door', [quadMesh('door', [0, 0, 0.5, 0.5])]],
      ['hood', [quadMesh('hood', [0.5, 0.5, 1, 1])]],
    ]);
    mergeStackedNames(byName, slot);
    expect([...byName.keys()]).toEqual(['door', 'hood']);
  });
});
