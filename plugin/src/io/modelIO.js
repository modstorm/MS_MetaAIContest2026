import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/**
 * Loads a .glb, a .gltf (+ its .bin / textures when dropped together), an
 * ArrayBuffer or a URL. Draco and meshopt compressed models are supported.
 */
export async function loadModel(input, opts = {}) {
  const manager = new THREE.LoadingManager();
  const objectUrls = [];
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  // Draco: three.js ships the decoders and resolves them relative to the module,
  // so compressed models work out of the box. The decoder is only fetched when needed.
  const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
  const draco = new DRACOLoader();
  if (opts.dracoDecoderPath) draco.setDecoderPath(opts.dracoDecoderPath);
  loader.setDRACOLoader(draco);

  try {
    let gltf;
    let name = opts.name ?? 'model';
    if (typeof input === 'string') {
      name =
        opts.name ??
        input
          .split('/')
          .pop()
          .replace(/\.(glb|gltf)$/i, '');
      gltf = await loader.loadAsync(input);
    } else if (input instanceof ArrayBuffer) {
      gltf = await loader.parseAsync(input, '');
    } else {
      const files =
        input instanceof File ? [input] : Array.isArray(input) ? input : 'length' in input ? Array.from(input) : [];
      if (!files.length && input instanceof Blob) {
        gltf = await loader.parseAsync(await input.arrayBuffer(), '');
      } else {
        const main = files.find((f) => /\.(glb|gltf)$/i.test(f.name));
        if (!main) throw new Error('No .glb or .gltf file found in the dropped files');
        name = opts.name ?? main.name.replace(/\.(glb|gltf)$/i, '');
        // Resolve sibling files (.bin, textures) referenced by a .gltf from the dropped set.
        const byName = new Map(files.map((f) => [f.name, f]));
        manager.setURLModifier((url) => {
          const file = byName.get(decodeURIComponent(url.split('/').pop() ?? ''));
          if (!file) return url;
          const u = URL.createObjectURL(file);
          objectUrls.push(u);
          return u;
        });
        gltf = await loader.parseAsync(await main.arrayBuffer(), '');
      }
    }
    // Wait for textures to decode so analysis can read image sizes.
    await waitForTextures(gltf.scene);
    return { name, gltf, scene: gltf.scene };
  } finally {
    draco.dispose();
    for (const u of objectUrls) setTimeout(() => URL.revokeObjectURL(u), 10_000);
  }
}

async function waitForTextures(root) {
  const pending = [];
  root.traverse((o) => {
    const mesh = o;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) {
        const tex = v;
        const img = tex && tex.isTexture ? tex.image : undefined;
        if (img && 'complete' in img && !img.complete) {
          pending.push(
            new Promise((r) => {
              img.addEventListener('load', () => r(), { once: true });
              img.addEventListener('error', () => r(), { once: true });
            }),
          );
        }
      }
    }
  });
  await Promise.all(pending);
}

/** Exports a scene to a binary .glb. */
export async function exportGLB(root, opts = {}) {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(root, {
    binary: true,
    onlyVisible: true,
    maxTextureSize: opts.maxTextureSize ?? 2048,
    animations: opts.animations ?? [],
  });
  if (!(result instanceof ArrayBuffer)) throw new Error('GLTFExporter did not return binary output');
  return result;
}
