import * as THREE from 'three';

/**
 * Generates UVs for a mesh that has none, using per-face box (cube) projection
 * scaled to the mesh bounds. The geometry is converted to non-indexed so each
 * face can pick its own projection axis. Returns true if UVs were added.
 * Box-projected UVs tile, so the reskinner pairs them with a seamless texture.
 */
export function generateBoxUvs(mesh, channel = 0, tilesPerMeter = 1) {
  const name = channel === 0 ? 'uv' : `uv${channel}`;
  let geom = mesh.geometry;
  if (geom.getAttribute(name)) return false;
  if (geom.index) geom = geom.toNonIndexed();
  const pos = geom.getAttribute('position');
  if (!pos) return false;

  geom.computeBoundingBox();
  const size = new THREE.Vector3();
  geom.boundingBox.getSize(size);
  const scale = tilesPerMeter / Math.max(1e-6, Math.max(size.x, size.y, size.z));
  const min = geom.boundingBox.min;

  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3();
  const n = new THREE.Vector3(),
    e1 = new THREE.Vector3(),
    e2 = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    const ax = Math.abs(n.x),
      ay = Math.abs(n.y),
      az = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u, v;
      if (ax >= ay && ax >= az) {
        u = p.z - min.z;
        v = p.y - min.y;
      } else if (ay >= az) {
        u = p.x - min.x;
        v = p.z - min.z;
      } else {
        u = p.x - min.x;
        v = p.y - min.y;
      }
      uv[(t + k) * 2] = u * scale;
      uv[(t + k) * 2 + 1] = 1 - v * scale;
    }
  }
  geom.setAttribute(name, new THREE.BufferAttribute(uv, 2));
  if (geom !== mesh.geometry) {
    mesh.geometry.dispose();
    mesh.geometry = geom;
  }
  return true;
}
