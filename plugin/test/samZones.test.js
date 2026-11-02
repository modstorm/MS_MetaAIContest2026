import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { encodeSegmentationMask } from '../../node_modules/@meta-sam/parser/dist/mask-codec.js';
import {
  fillUnseen,
  labelPixels,
  rasterizeIds,
  voteTriangles,
  worldPositions,
  zoneConceptsFor,
} from '../src/analysis/samZones.js';

/** A SAM image result with one rectangular mask per entry: [left, top, right, bottom]. */
function samResult(rects, confidence = 0.9) {
  return {
    records: rects.map(([left, top, right, bottom]) => ({
      kind: 'mask',
      bounds: { left, top, right, bottom },
      mask: encodeSegmentationMask(new Uint8Array(16).fill(1), 4, 4),
      confidence,
    })),
  };
}

function meshEntry(mesh, base) {
  const positions = worldPositions(mesh);
  const index = mesh.geometry.index?.array ?? null;
  const tris = Math.floor((index ? index.length : positions.length / 3) / 3);
  return { mesh, positions, index, tris, base };
}

/** Front orthographic camera framing x, y in [-3, 3]. */
function frontCamera() {
  const cam = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
}

describe('SAM zones', () => {
  it('takes phrases from the asset class, else from Muse part names', () => {
    const avatar = zoneConceptsFor('avatar');
    expect(avatar.concepts.map((c) => c.zone)).toEqual(['face', 'hair', 'hands', 'arms', 'shoes', 'legs', 'torso']);
    expect(avatar.concepts.find((c) => c.zone === 'hands').concept).toBe('hand');
    const prop = zoneConceptsFor('prop', ['Red Lid!', 'metal body', 'red lid', '']);
    expect(prop.concepts.map((c) => c.concept)).toEqual(['red lid', 'metal body']);
    expect(zoneConceptsFor('generic', []).concepts).toEqual([]);
  });

  it('smaller masks win where masks overlap', () => {
    // Concept 0 covers the whole 8x8 image, concept 1 only the top-left 4x4.
    const { label, found } = labelPixels([samResult([[0, 0, 8, 8]]), samResult([[0, 0, 4, 4]])], 8, 8);
    expect(found).toEqual([1, 1]);
    expect(label[0]).toBe(1);
    expect(label[7 * 8 + 7]).toBe(0);
    // Low confidence masks are ignored.
    expect(labelPixels([samResult([[0, 0, 8, 8]], 0.1)], 8, 8).found).toEqual([0]);
  });

  it('rasterizes the nearest triangle, votes zones and fills the hidden sides', () => {
    const left = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    left.position.x = -1.5;
    const right = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    right.position.x = 1.5;
    const scene = new THREE.Scene();
    scene.add(left, right);
    scene.updateMatrixWorld(true);
    const a = meshEntry(left, 0);
    const b = meshEntry(right, a.tris);
    const size = 60;
    const raster = rasterizeIds([a, b], frontCamera(), size);
    // The centre of the left box's front face is a triangle of the left box's front (+Z) face.
    const id = raster.ids[30 * size + 15];
    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBeLessThan(a.tris);
    const n = left.geometry.getAttribute('normal');
    expect(n.getZ(left.geometry.index.array[id * 3])).toBe(1);

    // SAM: concept 0 on the left half of the image; the right half is "rest" (K = 1).
    const { label } = labelPixels([samResult([[0, 0, 30, 60]])], size, size);
    const zone = voteTriangles([{ ...raster, ox: 0, oy: 0 }], label, size, size, a.tris + b.tris, 1);
    // Only the front faces were seen.
    const seen = [...zone].filter((z) => z >= 0).length;
    expect(seen).toBeGreaterThan(0);
    expect(seen).toBeLessThan(zone.length);
    fillUnseen(zone, [a, b]);
    expect([...zone.slice(0, a.tris)].every((z) => z === 0)).toBe(true);
    expect([...zone.slice(a.tris)].every((z) => z === 1)).toBe(true);
  });

  it('counts triangles smaller than a pixel by their centroid', () => {
    const tiny = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01));
    tiny.position.z = 1;
    tiny.updateMatrixWorld(true);
    const e = meshEntry(tiny, 0);
    const r = rasterizeIds([e], frontCamera(), 30);
    expect(r.ids.every((i) => i < 0)).toBe(true);
    expect(r.extra.length).toBeGreaterThan(0);
  });
});
