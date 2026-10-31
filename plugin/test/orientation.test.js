import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { chooseOrientation, islandUpDirections, transformParts } from '../src/analysis/parts.js';

function plane(flipV) {
  const g = new THREE.PlaneGeometry(1, 2);
  if (flipV) {
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  }
  const mesh = new THREE.Mesh(g);
  const src = { uvs: g.getAttribute('uv').array, index: g.getIndex().array };
  return { mesh, src };
}

describe('island orientation', () => {
  it('glTF-style UVs (v down) on an upright plane read as upright, not mirrored', () => {
    const { mesh, src } = plane(true);
    const [o] = islandUpDirections(mesh, src);
    expect(o.dir).toBe('up');
    expect(o.mirrored).toBe(false);
  });

  it('GL-style UVs (v up) read as upside down and mirrored = a vertical flip', () => {
    const { mesh, src } = plane(false);
    const [o] = islandUpDirections(mesh, src);
    expect(o.dir).toBe('down');
    expect(o.mirrored).toBe(true);
    const t = chooseOrientation([{ name: 'Head', up: 'down', mirrored: true, bbox: [0, 0, 1000, 1000] }]);
    expect(t).toEqual({ rot: 180, flipX: true, reason: 'Head' });
  });

  it('a rotated mesh is detected as sideways', () => {
    const { mesh, src } = plane(true);
    mesh.rotation.z = Math.PI / 2; // model up now points along the plane's -X
    const [o] = islandUpDirections(mesh, src);
    expect(['left', 'right']).toContain(o.dir);
  });

  it('prefers the head part when choosing the transform', () => {
    const t = chooseOrientation([
      { name: 'Body', up: 'up', mirrored: false },
      { name: 'Head', up: 'down', mirrored: false },
    ]);
    expect(t.rot).toBe(180);
    expect(t.flipX).toBe(false);
  });

  it('remaps part boxes and directions through the transform', () => {
    const [p] = transformParts([{ name: 'Head', bbox: [0, 600, 400, 1000], up: 'down', mirrored: false }], {
      rot: 180,
      flipX: false,
    });
    expect(p.bbox).toEqual([600, 0, 1000, 400]);
    expect(p.up).toBe('up');
  });
});

describe('texture orientation flags', () => {
  it('applies flipY and KHR_texture_transform before analysis', async () => {
    const { uvSourceOf } = await import('../src/analysis/textureLayout.js');
    const g = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(g);
    const raw = uvSourceOf(mesh, 0, null).uvs;
    const flipped = new THREE.Texture();
    flipped.flipY = true;
    const f = uvSourceOf(mesh, 0, flipped).uvs;
    for (let i = 0; i < raw.length; i += 2) {
      expect(f[i]).toBeCloseTo(raw[i]);
      expect(f[i + 1]).toBeCloseTo(1 - raw[i + 1]);
    }
    const scaled = new THREE.Texture();
    scaled.flipY = false;
    scaled.repeat.set(1, -1);
    scaled.offset.set(0, 1);
    const s = uvSourceOf(mesh, 0, scaled).uvs;
    for (let i = 0; i < raw.length; i += 2) expect(s[i + 1]).toBeCloseTo(1 - raw[i + 1]);
  });
});
