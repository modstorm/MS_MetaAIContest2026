import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** A minimal three.js viewer: PBR lighting, orbit controls, auto-framing, animation playback. */
export class Viewer {
  renderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  controls;
  content = null;
  mixer = null;
  timer = new THREE.Timer();
  /** Before/after split: { before(), after() } called around the two half renders, or null. */
  compare = null;
  /** Where the split is, 0..1 across the canvas (left = before). */
  split = 0.5;

  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.prepend(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.background = new THREE.Color(0x15171d);

    const grid = new THREE.GridHelper(10, 20, 0x2b2f3a, 0x1d2029);
    grid.name = '__grid';
    this.scene.add(grid);
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(3, 5, 2);
    this.scene.add(sun);

    this.camera.position.set(2, 1.5, 3);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    // Turntable: spins until the user grabs the model.
    this.controls.autoRotateSpeed = 1.6;
    this.controls.addEventListener('start', () => this.setSpin(false));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** Shows `obj`, playing its idle animation if it has one, else the first (kept in `this.clip`). */
  setContent(obj, animations = []) {
    if (this.content) this.scene.remove(this.content);
    this.mixer?.stopAllAction();
    this.content = obj;
    this.scene.add(obj);
    this.mixer = null;
    this.clip = pickIdleClip(animations);
    if (this.clip) {
      this.mixer = new THREE.AnimationMixer(obj);
      this.mixer.clipAction(this.clip).play();
    }
    this.frame(obj);
    this.setSpin(true);
  }

  /** Turntable on/off. Calls onSpinChange so the UI can follow. */
  setSpin(on) {
    if (this.controls.autoRotate === on) return;
    this.controls.autoRotate = on;
    this.onSpinChange?.(on);
  }

  /** Points the camera at the object and puts the grid at its feet. */
  frame(obj) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.1;
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.35, 1).normalize().multiplyScalar(dist));
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    const grid = this.scene.getObjectByName('__grid');
    grid.position.y = box.min.y;
    grid.scale.setScalar(Math.max(1, radius));
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    this.timer.update();
    const dt = this.timer.getDelta();
    this.mixer?.update(dt);
    this.controls.update();
    if (!this.compare) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    // Split view: left of the handle shows "before", right shows "after".
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const x = Math.round(w * this.split);
    this.renderer.setScissorTest(true);
    this.compare.before();
    this.renderer.setScissor(0, 0, x, h);
    this.renderer.render(this.scene, this.camera);
    this.compare.after();
    this.renderer.setScissor(x, 0, w - x, h);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
  }
}

/**
 * The clip to play on load: one named idle (exactly "idle" first, then any name with
 * "idle"), else a standing / breathing loop, else the first clip.
 */
export function pickIdleClip(animations = []) {
  if (!animations.length) return null;
  const name = (c) => (c.name ?? '').toLowerCase();
  return (
    animations.find((c) => /^(idle|anim[_ ]?idle|idle[_ ]?0*1?)$/.test(name(c).replace(/^.*[|:]/, ''))) ??
    animations.find((c) => /idle/.test(name(c))) ??
    animations.find((c) => /\b(stand(ing)?|breath(e|ing)?|rest)\b/.test(name(c))) ??
    animations[0]
  );
}
