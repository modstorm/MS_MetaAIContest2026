import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createCanvas, ctx2d } from '../texture/imageUtils.js';

/** The six axis views, in contact-sheet order. `dir` points from the model toward the camera. */
export const AXIS_VIEWS = [
  { name: 'front', axis: '+Z', dir: [0, 0, 1], up: [0, 1, 0] },
  { name: 'back', axis: '-Z', dir: [0, 0, -1], up: [0, 1, 0] },
  { name: 'left', axis: '-X', dir: [-1, 0, 0], up: [0, 1, 0] },
  { name: 'right', axis: '+X', dir: [1, 0, 0], up: [0, 1, 0] },
  { name: 'top', axis: '+Y', dir: [0, 1, 0], up: [0, 0, -1] },
  { name: 'bottom', axis: '-Y', dir: [0, -1, 0], up: [0, 0, 1] },
];

const D = Math.SQRT1_2;
/** Review views: the six axis views plus three-quarter (45°) views of the front and the back. */
export const REVIEW_VIEWS = [
  { name: 'front', axis: '+Z', dir: [0, 0, 1], up: [0, 1, 0] },
  { name: 'front 45°', axis: "model's front-left", dir: [D, 0, D], up: [0, 1, 0] },
  { name: 'side', axis: "model's left, +X", dir: [1, 0, 0], up: [0, 1, 0] },
  { name: 'top', axis: '+Y', dir: [0, 1, 0], up: [0, 0, -1] },
  { name: 'back', axis: '-Z', dir: [0, 0, -1], up: [0, 1, 0] },
  { name: 'back 45°', axis: "model's back-right", dir: [-D, 0, -D], up: [0, 1, 0] },
  { name: 'side', axis: "model's right, -X", dir: [-1, 0, 0], up: [0, 1, 0] },
  { name: 'bottom', axis: '-Y', dir: [0, -1, 0], up: [0, 0, 1] },
];

/** Three-quarter view from above the front-left: two sides and the top show (History thumbnails). */
const tq = Math.hypot(1, 0.8, 1);
export const THUMB_VIEW = {
  name: '3/4',
  axis: 'front-left, from above',
  dir: [1 / tq, 0.8 / tq, 1 / tq],
  up: [0, 1, 0],
};

/**
 * Renders the model from the six axis directions with orthographic cameras and
 * neutral studio lighting. Returns one canvas per view plus a labelled 3×2
 * contact sheet (one image is cheaper to send to a vision model than six).
 *
 * The object is briefly moved into a private scene and put back where it was,
 * so the host's scene is unchanged afterwards.
 *
 * @param {import('three').Object3D} object
 * @param {{ size?: number, background?: string, views?: typeof AXIS_VIEWS, cols?: number }} [opts]
 * @returns {{ views: { name: string, axis: string, canvas: HTMLCanvasElement, projView: THREE.Matrix4, rootMatrix: THREE.Matrix4 }[], sheet: HTMLCanvasElement }}
 */
export function renderAxisViews(object, opts = {}) {
  const size = opts.size ?? 384;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.background ?? '#9aa0a8');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  scene.add(key);

  const parent = object.parent;
  const index = parent ? parent.children.indexOf(object) : -1;
  const views = [];
  try {
    scene.add(object);
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    const size3 = box.getSize(new THREE.Vector3());
    const radius = Math.max(1e-6, size3.length() / 2);
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, radius * 0.01, radius * 10);

    for (const v of opts.views ?? AXIS_VIEWS) {
      const dir = new THREE.Vector3(...v.dir);
      cam.position.copy(center).addScaledVector(dir, radius * 3);
      cam.up.set(...v.up);
      cam.lookAt(center);
      // Frame tightly: half of the larger box extent across this view, plus a margin.
      // Diagonal views see the box's diagonal, so they use the full radius.
      const axial = v.dir.filter((n) => n !== 0).length === 1;
      // A view from above (or below) at an angle sees the whole box diagonal.
      const across = axial
        ? [Math.abs(v.dir[0]) ? 0 : size3.x, Math.abs(v.dir[1]) ? 0 : size3.y, Math.abs(v.dir[2]) ? 0 : size3.z]
        : v.dir[1]
          ? [size3.length()]
          : [Math.hypot(size3.x, size3.z), size3.y];
      const half = Math.max(1e-6, Math.max(...across) / 2) * 1.08;
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
      key.position.copy(cam.position).add(new THREE.Vector3(radius, radius * 2, radius));
      key.target.position.copy(center);
      key.target.updateMatrixWorld();
      renderer.render(scene, cam);
      const c = createCanvas(size, size);
      ctx2d(c).drawImage(renderer.domElement, 0, 0);
      // The camera and the object's placement while rendering, so pixels can be matched to
      // triangles afterwards (see samZones.js).
      const projView = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      views.push({ name: v.name, axis: v.axis, canvas: c, projView, rootMatrix: object.matrixWorld.clone() });
    }
  } finally {
    scene.remove(object);
    if (parent) {
      parent.add(object);
      // Restore the original child order.
      parent.children.splice(parent.children.indexOf(object), 1);
      parent.children.splice(index, 0, object);
    }
    object.updateMatrixWorld(true);
    env.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  return { views, sheet: contactSheet(views, size, opts.cols ?? 3) };
}

export function contactSheet(views, size, cols = 3) {
  const rows = Math.ceil(views.length / cols);
  const sheet = createCanvas(cols * size, rows * size);
  const g = ctx2d(sheet);
  g.font = `bold ${Math.round(size / 14)}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  views.forEach((v, i) => {
    const x = (i % cols) * size;
    const y = Math.floor(i / cols) * size;
    g.drawImage(v.canvas, x, y);
    const label = `${v.name} (${v.axis})`;
    const pad = size / 40;
    const w = g.measureText(label).width + pad * 2;
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.fillRect(x + pad, y + pad, w, size / 14 + pad * 2);
    g.fillStyle = '#fff';
    g.fillText(label, x + pad * 2, y + pad * 2);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
  });
  return sheet;
}

/** Stacks canvases vertically into one image (each scaled to the first one's width). */
export function stackCanvases(list) {
  const w = list[0].width;
  const heights = list.map((c) => Math.round((c.height * w) / c.width));
  const out = createCanvas(
    w,
    heights.reduce((a, b) => a + b, 0),
  );
  const g = ctx2d(out);
  let y = 0;
  list.forEach((c, i) => {
    g.drawImage(c, 0, y, w, heights[i]);
    y += heights[i];
  });
  return out;
}
