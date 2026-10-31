import * as THREE from 'three';
import { analyzeTextureLayout, summarizeLayout } from './analysis/textureLayout.js';
import { generateBoxUvs } from './analysis/uvGenerate.js';
import { renderAxisViews } from './analysis/renderViews.js';
import { exportGLB, loadModel } from './io/modelIO.js';
import { MuseProvider } from './providers/MuseProvider.js';
import {
  applyDetailPreserve,
  accentColor,
  averageColor,
  blobToCanvas,
  drawAtlasWithUvs,
  drawUvGuide,
  fitSize,
  resizeCanvas,
  textureToCanvas,
} from './texture/imageUtils.js';
import { deriveNormalMap, deriveRoughnessMap } from './texture/pbrMaps.js';

/**
 * Events the plugin emits. Subscribe to one with `plugin.on(type, cb)` or to
 * everything with `plugin.onUpdate(({ type, data }) => ...)`.
 *
 *   status          { state: 'idle'|'loading'|'analyzing'|'reskinning'|'exporting'|'error', message }
 *   loaded          { model: LoadedModel, layout: TextureLayout }
 *   progress        { stage, slotId?, message, progress: 0..1 }
 *   plan            { slotId, plan: LayoutPlan | null }   what Muse Spark read from the atlas
 *   textureUpdated  { slotId, kind: 'baseColor'|'normal'|'roughness', canvas }
 *   reskinned       ReskinResult
 *   reverted        {}
 *   exported        { glb: ArrayBuffer, filename }
 *   views           { views: [{ name, axis, canvas }], sheet }       six axis renders sent to Muse
 *   suggestion      Suggestion   Muse's recommended prompt + per-region plan (from postSuggest)
 *   timing          { step, slotId, slotName, ms, ok, provider }   one per model call
 *   warning         { message }
 *   error           { error: Error, stage }
 *
 * @typedef {import('./types.js').LoadedModel} LoadedModel
 * @typedef {import('./types.js').TextureLayout} TextureLayout
 * @typedef {import('./types.js').TextureSlot} TextureSlot
 * @typedef {import('./types.js').ReskinResult} ReskinResult
 * @typedef {import('./types.js').PostPromptOptions} PostPromptOptions
 * @typedef {import('./providers/types.js').TextureProvider} TextureProvider
 *
 * @typedef {object} ReskinPluginOptions
 * @property {TextureProvider} [provider] A custom provider. Defaults to a MuseProvider built from `muse`.
 * @property {import('./providers/MuseProvider.js').MuseProviderOptions} [muse]
 *   Options for the default Muse provider (apiKey, baseUrl, fallbackBaseUrl, models...).
 */

/**
 * The reskin plugin: one object that owns loading, analysis, all Muse calls,
 * texture processing and GLB export. A host (like the harness) just posts
 * inputs and listens for updates:
 *
 *   const plugin = new ReskinPlugin({ muse: { apiKey } });
 *   plugin.onUpdate((e) => console.log(e.type, e.data));
 *   const { model } = await plugin.postModel(file);
 *   scene.add(model.scene);
 *   await plugin.postPrompt('haunted pumpkin armor');
 *   const { glb } = await plugin.postExport();
 */
export class ReskinPlugin {
  provider;
  listeners = new Map();
  anyListeners = new Set();
  snapshots = new Map();
  /** Layout readings per texture, reused across prompts (the layout doesn't depend on the theme). */
  planCache = new Map();
  /** Art-director suggestions per theme for the current model. */
  suggestionCache = new Map();
  busy = false;
  abort = null;

  model = null;
  layout = null;
  lastResult = null;
  lastPrompt = '';

  /** @param {ReskinPluginOptions} [opts] */
  constructor(opts = {}) {
    this.provider = opts.provider ?? new MuseProvider(opts.muse ?? {});
  }

  // ---------------------------------------------------------------- listeners

  /** Subscribe to one event type. Returns an unsubscribe function. */
  on(type, cb) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Subscribe to every update. Returns an unsubscribe function. */
  onUpdate(cb) {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  emit(type, data) {
    for (const cb of this.listeners.get(type) ?? []) safeCall(cb, data);
    for (const cb of this.anyListeners) safeCall(cb, { type, data });
  }

  status(state, message) {
    this.emit('status', { state, message });
  }

  // ---------------------------------------------------------------- config

  setProvider(provider) {
    this.provider = provider;
  }

  getProvider() {
    return this.provider;
  }

  get isBusy() {
    return this.busy;
  }

  /** Cancels a running postPrompt. */
  cancel() {
    this.abort?.abort(new DOMException('Cancelled', 'AbortError'));
  }

  // ---------------------------------------------------------------- post: model

  /**
   * Load a model (File(s), Blob, ArrayBuffer or URL), analyze it and make it the current model.
   * @param {import('./io/modelIO.js').ModelInput} input
   * @param {import('./io/modelIO.js').LoadOptions} [opts]
   * @returns {Promise<{ model: LoadedModel, layout: TextureLayout }>}
   */
  async postModel(input, opts = {}) {
    this.guard();
    this.busy = true;
    try {
      this.status('loading', 'Loading model…');
      const model = await loadModel(input, opts);
      this.model = model;
      this.snapshots.clear();
      this.planCache.clear();
      this.suggestionCache.clear();
      this.lastResult = null;
      this.status('analyzing', 'Analyzing texture layout…');
      const layout = this.analyze();
      for (const w of layout.warnings) this.emit('warning', { message: w });
      this.emit('loaded', { model, layout });
      this.status(
        'idle',
        `Loaded "${model.name}": ${layout.slots.length} texture slot(s), ${layout.triangleCount} triangles`,
      );
      return { model, layout };
    } catch (err) {
      this.fail(err, 'load');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Re-runs layout analysis on the current model. */
  analyze() {
    if (!this.model) throw new Error('No model loaded');
    this.layout = analyzeTextureLayout(this.model.scene);
    return this.layout;
  }

  /** JSON summary of the current layout (no three.js objects). */
  summary() {
    return this.layout ? summarizeLayout(this.layout) : null;
  }

  /** Preview images for one slot: atlas, atlas with UV wireframe, and the island mask. */
  slotPreview(slotId, maxSize = 512) {
    const slot = this.requireSlot(slotId);
    const { width, height } = fitSize(slot.width || 512, slot.height || 512, maxSize);
    const atlas = slot.texture ? textureToCanvas(slot.texture, maxSize) : null;
    return {
      atlas,
      atlasWithUvs: atlas ? drawAtlasWithUvs(atlas, slot) : drawUvGuide(slot, width, height, { fill: false }),
      uvGuide: drawUvGuide(slot, width, height),
    };
  }

  // ---------------------------------------------------------------- post: prompt

  /** True if the current provider can recommend prompts (postSuggest). */
  get canSuggest() {
    return typeof this.provider.suggestPrompt === 'function';
  }

  /**
   * Art-director step, run before painting: renders the model from the six axis
   * directions (±X, ±Y, ±Z), sends those views plus the UV atlases to the vision
   * model, and returns what it thinks the object is, a stronger prompt for the
   * theme, and a per-region paint plan. Nothing is painted. Pass the result to
   * `postPrompt(text, { suggestion })` to use it (the text may be edited first).
   * @param {string} theme
   * @param {{ signal?: AbortSignal, fast?: boolean, viewSize?: number }} [opts]
   * @returns {Promise<import('./types.js').Suggestion>}
   */
  async postSuggest(theme, opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model before asking for a suggestion');
    if (!this.canSuggest) throw new Error(`${this.provider.name} cannot suggest prompts`);
    theme = theme.trim();
    if (!theme) throw new Error('Prompt is empty');
    const cached = this.suggestionCache.get(theme);
    if (cached) {
      this.emit('suggestion', cached);
      return cached;
    }

    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    try {
      if (opts.fast !== undefined) this.provider.setFast?.(opts.fast);
      this.restoreSnapshots(); // study the original look
      this.status('analyzing', 'Rendering six views of the model…');
      this.emit('progress', { stage: 'plan', message: 'Rendering six views of the model', progress: 0.1 });
      const { views, sheet } = renderAxisViews(this.model.scene, { size: opts.viewSize ?? 384 });
      this.emit('views', { views, sheet });

      const atlasSlots = this.layout.slots.filter((s) => s.texture && !s.tiled).slice(0, 4);
      const atlases = atlasSlots.map((slot) => {
        const atlas = textureToCanvas(slot.texture, 1024);
        return {
          slotId: slot.id,
          name: slot.name,
          meshNames: slot.meshes.map((m) => m.name),
          atlasWithUvs: drawAtlasWithUvs(atlas, slot),
        };
      });

      this.status('analyzing', 'Muse is studying the model…');
      this.emit('progress', {
        stage: 'plan',
        message: 'Muse is studying the model and the texture layout',
        progress: 0.3,
      });
      const raw = await this.timed('suggest prompt', null, () =>
        this.provider.suggestPrompt({ theme, sheet, atlases, signal }),
      );

      const plans = {};
      for (const a of raw.atlases ?? []) {
        const slot = atlasSlots[a.index - 1];
        if (!slot || !a.regions?.length) continue;
        plans[slot.id] = {
          subject: raw.subject,
          regions: a.regions.map((r) => ({ name: r.name, bbox: r.bbox, description: r.paint })),
        };
      }
      const suggestion = { ...raw, theme, prompt: raw.prompt || theme, plans, sheet, views };
      this.suggestionCache.set(theme, suggestion);
      this.emit('progress', { stage: 'plan', message: 'Suggestion ready', progress: 1 });
      this.emit('suggestion', suggestion);
      this.status('idle', `Muse sees: ${suggestion.subject || 'unknown object'}`);
      return suggestion;
    } catch (err) {
      this.fail(err, 'suggest');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /**
   * Reskin the current model from a theme prompt. Updates the model's materials in place.
   * @param {string} prompt
   * @param {PostPromptOptions} [opts]
   * @returns {Promise<ReskinResult>}
   */
  async postPrompt(prompt, opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model before posting a prompt');
    const theme = prompt.trim();
    if (!theme) throw new Error('Prompt is empty');

    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    const started = performance.now();
    const results = [];
    let recolored = 0;
    let firstError = null;

    try {
      if (opts.fast !== undefined) this.provider.setFast?.(opts.fast);
      this.status('reskinning', `Reskinning with "${theme}" via ${this.provider.name}…`);
      // Start from the original look every time, so prompts don't compound.
      this.restoreSnapshots();

      const wanted = (s) => !opts.slotIds || opts.slotIds.includes(s.id);
      // Small untextured parts (a button, an eye, an antenna ball) are tinted locally
      // from the new palette instead of costing a Muse call.
      const modelRadius = boundingRadius(this.model.scene);
      const isSmallUntextured = (s) =>
        (opts.localSmallParts ?? true) &&
        !s.texture &&
        boundingRadius(s.meshes) < modelRadius * (opts.smallPartRatio ?? 0.2);
      const localIds = new Set(this.layout.slots.filter((s) => wanted(s) && isSmallUntextured(s)).map((s) => s.id));

      // Meshes with no UVs get box-projected UVs, then the layout is re-analyzed.
      let addedUvs = false;
      for (const slot of this.layout.slots) {
        if (!slot.missingUvs || localIds.has(slot.id) || !wanted(slot)) continue;
        for (const mesh of slot.meshes) addedUvs = generateBoxUvs(mesh, slot.uvChannel) || addedUvs;
      }
      if (addedUvs) {
        this.analyze();
        this.emit('warning', { message: 'Generated box-projected UVs for meshes without UVs.' });
      }

      const remote = this.layout.slots.filter((s) => wanted(s) && !localIds.has(s.id));
      const local = this.layout.slots.filter((s) => localIds.has(s.id));
      const fractions = remote.map(() => 0);
      const progress = (i, frac, stage, message, slotId) => {
        fractions[i] = Math.max(fractions[i], frac);
        const total = fractions.reduce((a, b) => a + b, 0) / (fractions.length || 1);
        this.emit('progress', { stage, slotId, message, progress: Math.min(0.98, total) });
      };

      // All texture slots run in parallel: each one is independent.
      const settled = await Promise.allSettled(
        remote.map((slot, i) =>
          this.reskinSlot(slot, theme, opts, signal, (frac, stage, msg) => progress(i, frac, stage, msg, slot.id)),
        ),
      );
      signal.throwIfAborted();
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          if (r.value) results.push(r.value);
          else recolored += remote[i].materials.length;
        } else {
          const e = toError(r.reason);
          firstError ??= e;
          this.emit('warning', { message: `Slot "${remote[i].name}" failed: ${e.message}` });
        }
      });

      if (local.length) {
        // Pick an accent color from the largest new texture so small parts match the theme.
        const biggest = [...results].sort(
          (a, b) => b.canvas.width * b.canvas.height - a.canvas.width * a.canvas.height,
        )[0];
        let color = biggest ? accentColor(biggest.canvas) : null;
        if (!color) {
          const swatch = await this.timed('swatch', local[0].id, () =>
            this.provider.generateTexture({ theme, materialName: local[0].name, width: 256, height: 256, signal }),
          );
          color = averageColor(await this.toCanvas(swatch));
        }
        for (const slot of local) {
          for (const mat of slot.materials) {
            this.snapshot(mat);
            mat.color.copy(color);
            mat.needsUpdate = true;
          }
          recolored += slot.materials.length;
        }
      }

      if ((remote.length || local.length) && !results.length && !recolored) {
        throw firstError ?? new Error('No texture slot could be reskinned');
      }
      if (firstError && !results.length && remote.length) throw firstError;

      const result = {
        prompt: theme,
        slots: results,
        recoloredMaterials: recolored,
        durationMs: performance.now() - started,
      };
      this.lastResult = result;
      this.lastPrompt = theme;
      this.emit('progress', { stage: 'done', message: 'Done', progress: 1 });
      this.emit('reskinned', result);
      this.status('idle', `Reskinned ${results.length} texture(s) in ${(result.durationMs / 1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      this.fail(err, 'reskin');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  async reskinSlot(slot, theme, opts, signal, report) {
    const maxSize = Math.min(opts.maxTextureSize ?? 2048, 4096);
    const hasUvs = slot.meshes.some((m) =>
      m.geometry.getAttribute(slot.uvChannel === 0 ? 'uv' : `uv${slot.uvChannel}`),
    );
    if (!hasUvs) {
      // Nothing to map a texture onto: tint from a generated swatch.
      report(0.1, 'generate', `Generating color swatch for "${slot.name}"`);
      const swatch = await this.toCanvas(
        await this.timed('swatch', slot.id, () =>
          this.provider.generateTexture({ theme, materialName: slot.name, width: 256, height: 256, signal }),
        ),
      );
      const color = averageColor(swatch);
      for (const mat of slot.materials) {
        this.snapshot(mat);
        mat.color.copy(color);
        mat.needsUpdate = true;
      }
      return null;
    }

    const atlasMode = !!slot.texture && !slot.tiled;
    const { width, height } = slot.texture
      ? fitSize(slot.width, slot.height, maxSize)
      : { width: Math.min(1024, maxSize), height: Math.min(1024, maxSize) };

    let raw;
    let plan = null;
    let usedPrompt = theme;
    let original = null;

    if (atlasMode) {
      original = textureToCanvas(slot.texture, maxSize);
      const uvGuide = drawUvGuide(slot, original.width, original.height, {
        lineWidth: Math.max(1, original.width / 1024),
      });
      const planKey = `${this.provider.name}:${slot.texture.uuid}`;
      const suggested = opts.suggestion?.plans?.[slot.id];
      if (suggested) {
        // The art-director step already mapped this atlas's regions.
        plan = suggested;
      } else if ((opts.useVisionPlanning ?? true) && this.planCache.has(planKey)) {
        // The layout doesn't depend on the theme, so it is read once per model.
        plan = this.planCache.get(planKey);
      } else if ((opts.useVisionPlanning ?? true) && this.provider.planLayout) {
        report(0.05, 'plan', `Reading atlas layout of "${slot.name}"`);
        try {
          plan = await this.timed('read layout', slot.id, () =>
            this.provider.planLayout({
              slotName: slot.name,
              meshNames: slot.meshes.map((m) => m.name),
              atlas: original,
              atlasWithUvs: drawAtlasWithUvs(original, slot),
              signal,
            }),
          );
          if (plan) this.planCache.set(planKey, plan);
        } catch (err) {
          if (signal.aborted) throw err;
          this.emit('warning', { message: `Layout planning skipped: ${toError(err).message}` });
        }
        this.emit('plan', { slotId: slot.id, plan });
      }
      report(0.2, 'generate', `Painting "${slot.name}" (${width}×${height})`);
      raw = await this.toCanvas(
        await this.timed('paint atlas', slot.id, () =>
          this.provider.reskinAtlas({
            theme,
            slotName: slot.name,
            atlas: original,
            uvGuide,
            width,
            height,
            plan,
            extraInstructions: opts.extraInstructions,
            signal,
          }),
        ),
      );
    } else {
      report(0.2, 'generate', `Generating seamless texture for "${slot.name}"`);
      raw = await this.toCanvas(
        await this.timed('generate texture', slot.id, () =>
          this.provider.generateTexture({
            theme,
            materialName: slot.name,
            width,
            height,
            extraInstructions: opts.extraInstructions,
            signal,
          }),
        ),
      );
    }
    signal.throwIfAborted();

    report(0.7, 'postprocess', `Post-processing "${slot.name}"`);
    let baseColor = raw.width === width && raw.height === height ? raw : resizeCanvas(raw, width, height);
    const detail = opts.detailPreserve ?? 0.35;
    if (original && detail > 0) baseColor = applyDetailPreserve(baseColor, original, detail);

    report(0.8, 'apply', `Applying "${slot.name}"`);
    const baseTex = this.makeTexture(baseColor, slot.texture, THREE.SRGBColorSpace, slot.uvChannel, !atlasMode);
    for (const mat of slot.materials) {
      this.snapshot(mat);
      mat.map = baseTex;
      mat.color.set(0xffffff);
      mat.needsUpdate = true;
    }
    this.emit('textureUpdated', { slotId: slot.id, kind: 'baseColor', canvas: baseColor });

    // ---- normal maps
    if (opts.normalMaps ?? true) {
      report(0.85, 'postprocess', `Normal map for "${slot.name}"`);
      const cache = new Map();
      for (const mat of slot.materials) {
        const src = this.snapshots.get(mat).normalMap;
        const key = src?.uuid ?? 'none';
        let tex = cache.get(key);
        if (!tex) {
          const srcCanvas = src?.image ? textureToCanvas(src, maxSize) : null;
          const canvas = await this.auxMap('normal', theme, srcCanvas, baseColor, signal, () =>
            deriveNormalMap(baseColor, srcCanvas, opts.normalStrength ?? 2),
          );
          tex = this.makeTexture(canvas, src ?? slot.texture, THREE.NoColorSpace, slot.uvChannel, !atlasMode);
          cache.set(key, tex);
          this.emit('textureUpdated', { slotId: slot.id, kind: 'normal', canvas });
        }
        mat.normalMap = tex;
        mat.needsUpdate = true;
      }
    }

    // ---- roughness (glTF packs roughness in G and metalness in B of one texture)
    if (opts.roughnessMaps ?? true) {
      report(0.92, 'postprocess', `Roughness map for "${slot.name}"`);
      const cache = new Map();
      for (const mat of slot.materials) {
        const snap = this.snapshots.get(mat);
        const src = snap.roughnessMap;
        const key = src?.uuid ?? 'none';
        let tex = cache.get(key);
        if (!tex) {
          const srcCanvas = src?.image ? textureToCanvas(src, maxSize) : null;
          const canvas = await this.auxMap('roughness', theme, srcCanvas, baseColor, signal, () =>
            deriveRoughnessMap(baseColor, srcCanvas, { baseRoughness: snap.roughness }),
          );
          tex = this.makeTexture(canvas, src ?? slot.texture, THREE.NoColorSpace, slot.uvChannel, !atlasMode);
          cache.set(key, tex);
          this.emit('textureUpdated', { slotId: slot.id, kind: 'roughness', canvas });
        }
        const packed = snap.metalnessMap && snap.metalnessMap === snap.roughnessMap;
        mat.roughnessMap = tex;
        if (packed) mat.metalnessMap = tex;
        if (!src) mat.roughness = 1; // the map now carries the value
        mat.needsUpdate = true;
      }
    }

    report(1, 'apply', `Finished "${slot.name}"`);
    return { slotId: slot.id, canvas: baseColor, raw, plan, prompt: usedPrompt };
  }

  async auxMap(kind, theme, source, newBaseColor, signal, derive) {
    if (source && this.provider.reskinAuxMap) {
      try {
        const img = await this.timed(`paint ${kind} map`, null, () =>
          this.provider.reskinAuxMap({
            kind,
            theme,
            source,
            newBaseColor,
            width: newBaseColor.width,
            height: newBaseColor.height,
            signal,
          }),
        );
        const c = await this.toCanvas(img);
        return c.width === newBaseColor.width && c.height === newBaseColor.height
          ? c
          : resizeCanvas(c, newBaseColor.width, newBaseColor.height);
      } catch (err) {
        if (signal.aborted) throw err;
        this.emit('warning', { message: `AI ${kind} map failed, deriving locally: ${toError(err).message}` });
      }
    }
    return derive();
  }

  // ---------------------------------------------------------------- post: export

  /**
   * Export the current (reskinned) model as GLB.
   * @param {string} [filename]
   * @returns {Promise<{ glb: ArrayBuffer, filename: string }>}
   */
  async postExport(filename) {
    this.guard();
    if (!this.model) throw new Error('No model loaded');
    this.busy = true;
    try {
      this.status('exporting', 'Exporting GLB…');
      const glb = await exportGLB(this.model.scene, { animations: this.model.gltf.animations });
      const name = filename ?? `${this.model.name}${this.lastPrompt ? '-' + slug(this.lastPrompt) : ''}.glb`;
      this.emit('exported', { glb, filename: name });
      this.status('idle', `Exported ${name} (${(glb.byteLength / 1024 / 1024).toFixed(2)} MB)`);
      return { glb, filename: name };
    } catch (err) {
      this.fail(err, 'export');
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Put the original materials back. */
  revert() {
    this.restoreSnapshots();
    this.lastResult = null;
    this.lastPrompt = '';
    this.emit('reverted', {});
    this.status('idle', 'Reverted to original textures');
  }

  /** Toggle between original and last reskin without regenerating. */
  showOriginal(show) {
    if (!this.lastResult) return;
    for (const [mat, snap] of this.snapshots) {
      const cur = (mat.userData.__reskin ??= {
        map: mat.map,
        normalMap: mat.normalMap,
        roughnessMap: mat.roughnessMap,
        metalnessMap: mat.metalnessMap,
        color: mat.color.clone(),
        roughness: mat.roughness,
      });
      const s = show ? snap : cur;
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.roughnessMap;
      mat.metalnessMap = s.metalnessMap;
      mat.color.copy(s.color);
      mat.roughness = s.roughness;
      mat.needsUpdate = true;
      if (!show) delete mat.userData.__reskin;
    }
  }

  dispose() {
    this.cancel();
    this.listeners.clear();
    this.anyListeners.clear();
    this.snapshots.clear();
    this.model = null;
    this.layout = null;
  }

  // ---------------------------------------------------------------- helpers

  /** Runs one provider call and emits a `timing` event with how long it took. */
  async timed(step, slotId, fn) {
    const t0 = performance.now();
    let ok = false;
    try {
      const out = await fn();
      ok = true;
      return out;
    } finally {
      const slot = slotId ? this.layout?.slots.find((s) => s.id === slotId) : null;
      this.emit('timing', {
        step,
        slotId,
        slotName: slot?.name,
        ms: performance.now() - t0,
        ok,
        provider: this.provider.name,
      });
    }
  }

  guard() {
    if (this.busy) throw new Error('The plugin is busy with another request');
  }

  fail(err, stage) {
    const e = toError(err);
    this.emit('error', { error: e, stage });
    this.status('error', e.name === 'AbortError' ? 'Cancelled' : e.message);
  }

  requireSlot(id) {
    const slot = this.layout?.slots.find((s) => s.id === id);
    if (!slot) throw new Error(`Unknown slot ${id}`);
    return slot;
  }

  snapshot(mat) {
    if (this.snapshots.has(mat)) return;
    this.snapshots.set(mat, {
      map: mat.map,
      normalMap: mat.normalMap,
      roughnessMap: mat.roughnessMap,
      metalnessMap: mat.metalnessMap,
      color: mat.color.clone(),
      roughness: mat.roughness,
    });
  }

  restoreSnapshots() {
    for (const [mat, s] of this.snapshots) {
      delete mat.userData.__reskin;
      mat.map = s.map;
      mat.normalMap = s.normalMap;
      mat.roughnessMap = s.roughnessMap;
      mat.metalnessMap = s.metalnessMap;
      mat.color.copy(s.color);
      mat.roughness = s.roughness;
      mat.needsUpdate = true;
    }
  }

  async toCanvas(img) {
    return img instanceof Blob ? blobToCanvas(img) : img;
  }

  makeTexture(canvas, like, colorSpace, channel, repeat) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; // glTF convention
    tex.colorSpace = colorSpace;
    tex.channel = channel;
    if (like) {
      tex.wrapS = like.wrapS;
      tex.wrapT = like.wrapT;
      tex.magFilter = like.magFilter;
      tex.minFilter = like.minFilter;
      tex.offset.copy(like.offset);
      tex.repeat.copy(like.repeat);
      tex.rotation = like.rotation;
      tex.center.copy(like.center);
    }
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.name = `${like?.name || 'reskin'}_${colorSpace === THREE.SRGBColorSpace ? 'baseColor' : 'data'}`;
    tex.userData.mimeType = 'image/png';
    tex.needsUpdate = true;
    return tex;
  }
}

export function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'reskin'
  );
}

function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function safeCall(cb, d) {
  try {
    cb(d);
  } catch (e) {
    console.error('[ReskinPlugin] listener error', e);
  }
}

function anySignal(signals) {
  const anyFn = AbortSignal.any;
  if (anyFn) return anyFn(signals);
  const ctrl = new AbortController();
  for (const s of signals) s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  return ctrl.signal;
}

/** Bounding-sphere radius of one object or a list of objects (world space). */
function boundingRadius(objs) {
  const box = new THREE.Box3();
  for (const o of Array.isArray(objs) ? objs : [objs]) box.expandByObject(o);
  return box.isEmpty() ? 0 : box.getSize(new THREE.Vector3()).length() / 2;
}
