import * as THREE from 'three';
import { analyzeTextureLayout, summarizeLayout } from './analysis/textureLayout.js';
import { generateBoxUvs } from './analysis/uvGenerate.js';
import { REVIEW_VIEWS, renderAxisViews, stackCanvases } from './analysis/renderViews.js';
import {
  PART_COLORS,
  chooseOrientation,
  isIdentity,
  partName,
  resolveOrientation,
  slotParts,
  transformParts,
} from './analysis/parts.js';
import { drawFacingMap, facingSummary, splitPartRegions } from './analysis/facing.js';
import { assetClassRules, detectAssetClass, getAssetClass, normalizeAssetClass } from './assetClasses.js';
import { exportGLB, loadModel } from './io/modelIO.js';
import { MuseProvider } from './providers/MuseProvider.js';
import { isContentPolicyError } from './muse/MuseClient.js';
import {
  applyDetailPreserve,
  accentColor,
  averageColor,
  blobToCanvas,
  drawAtlasWithUvs,
  drawPartLabels,
  drawPartMap,
  drawUvGuide,
  fitSize,
  resizeCanvas,
  textureToCanvas,
  transformCanvas,
  untransformCanvas,
} from './texture/imageUtils.js';
import { deriveNormalMap, deriveRoughnessMap } from './texture/pbrMaps.js';
import { flattenTinyIslands, islandIdMap, padIslands } from './texture/islandPost.js';
import {
  copyCanvas,
  cropCanvas,
  greyedCrop,
  mapLimit,
  maskRect,
  padToMuseAspect,
  partMask,
  pasteInsideMask,
  unpad,
} from './texture/partPaint.js';

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
 *   request         { url, method, request, status, ms, error? }   every raw Muse call (images shortened)
 *   probe           { name, description, ok, ms, error? }      one per filter-probe test (postProbe)
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
  /** Per-part paint jobs of the last run, per slot (for review & repaint). */
  lastPartJobs = new Map();
  /** Paint areas per slot (UV island groups do not change for a loaded model). */
  regionCache = new Map();
  suggestionCache = new Map();
  busy = false;
  abort = null;

  model = null;
  layout = null;
  lastResult = null;
  lastPrompt = '';

  /** @param {ReskinPluginOptions} [opts] */
  constructor(opts = {}) {
    this.setProvider(opts.provider ?? new MuseProvider(opts.muse ?? {}));
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
    // Surface every raw model request (images shortened) as a `request` event, for debugging.
    if (provider?.client && 'onExchange' in provider.client) {
      provider.client.onExchange = (info) => this.emit('request', info);
    }
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
      this.lastPartJobs.clear();
      this.regionCache.clear();
      this.idMapSaved = null;
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
    this.regionCache.clear();
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
    const parts = this.idRegions(slot);
    const w = atlas?.width ?? width;
    const h = atlas?.height ?? height;
    return {
      atlas,
      atlasWithUvs: atlas ? drawAtlasWithUvs(atlas, slot) : drawUvGuide(slot, width, height, { fill: false }),
      uvGuide: drawUvGuide(slot, width, height),
      // Each part (mesh name) tinted, labelled, with an arrow toward the part's top on the model.
      partMap: drawPartMap(slot, parts, w, h, { atlas, alpha: atlas ? 0.45 : 1, labels: true }),
      parts: parts.map(({ meshes, ...p }) => p),
      orientation: chooseOrientation(slotParts(slot)),
    };
  }

  // ---------------------------------------------------------------- post: probe

  /**
   * Debug helper for content-filter rejections: sends a few small, separate requests
   * (theme only, full prompt without images, prompt + atlas, prompt + UV mask, neutral
   * prompt + atlas) and reports which ones pass, to find what triggers the filter.
   * Each image call is billed by the provider (Muse: about $0.01 each).
   * @param {string} theme
   * @param {{ signal?: AbortSignal, slotId?: string }} [opts]
   */
  async postProbe(theme, opts = {}) {
    this.guard();
    if (!this.model || !this.layout) throw new Error('Post a model first');
    if (typeof this.provider.probeFilter !== 'function') throw new Error(`${this.provider.name} has no filter probe`);
    const slot =
      (opts.slotId && this.layout.slots.find((s) => s.id === opts.slotId)) ||
      this.layout.slots.find((s) => s.texture && !s.tiled) ||
      this.layout.slots.find((s) => s.texture);
    if (!slot) throw new Error('The model has no textures to probe with');
    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    try {
      this.restoreSnapshots();
      this.status('reskinning', `Probing the content filter with "${theme}"…`);
      const atlas = textureToCanvas(slot.texture, 512);
      const uvGuide = drawUvGuide(slot, atlas.width, atlas.height);
      const results = await this.provider.probeFilter({
        theme: theme.trim(),
        atlas,
        uvGuide,
        plan: this.planCache.get(`${this.provider.name}:${slot.texture.uuid}`) ?? null,
        signal,
        onResult: (r) => this.emit('probe', r),
      });
      const failed = results.filter((r) => !r.ok).map((r) => r.name);
      this.status(
        'idle',
        failed.length ? `Filter probe: blocked → ${failed.join(', ')}` : 'Filter probe: everything passed',
      );
      return results;
    } catch (err) {
      this.fail(err, 'probe');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
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
    const cached = this.suggestionCache.get(`${theme}|${JSON.stringify(opts.orientation ?? 'auto')}`);
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
      // The same views with every area in its own flat color (matching the atlas part map).
      const idSheet = this.renderIdSheet({ size: Math.round((opts.viewSize ?? 384) * 0.75) });
      this.emit('views', { views, sheet, idSheet });

      const atlasSlots = this.layout.slots.filter((s) => s.texture && !s.tiled).slice(0, 4);
      const atlases = atlasSlots.map((slot) => {
        const original = textureToCanvas(slot.texture, 1024);
        const rawParts = this.idRegions(slot);
        // Same upright transform as the whole-atlas paint step, so region boxes line up.
        const orient = resolveOrientation(opts.orientation, slotParts(slot));
        const parts = transformParts(rawParts, orient);
        const atlas = transformCanvas(original, orient);
        return {
          slotId: slot.id,
          name: slot.name,
          meshNames: slot.meshes.map((m) => m.name),
          parts,
          // Atlas with each part tinted + labelled (name and an arrow to the part's top).
          atlasWithUvs:
            parts.length > 1
              ? drawPartLabels(
                  transformCanvas(
                    drawPartMap(slot, rawParts, original.width, original.height, { atlas: original, alpha: 0.35 }),
                    orient,
                  ),
                  parts,
                )
              : transformCanvas(drawAtlasWithUvs(original, slot), orient),
        };
      });

      this.status('analyzing', 'Muse is studying the model…');
      this.emit('progress', {
        stage: 'plan',
        message: 'Muse is studying the model and the texture layout',
        progress: 0.3,
      });
      const raw = await this.timed('suggest prompt', null, () =>
        this.provider.suggestPrompt({ theme, sheet, idSheet, atlases, signal }),
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
      // Model-written text is cleaned of common safety-filter triggers before it is shown or painted.
      for (const plan of Object.values(plans)) {
        for (const r of plan.regions) r.description = r.description && sanitizePrompt(r.description);
      }
      const suggestion = { ...raw, theme, prompt: sanitizePrompt(raw.prompt || theme), plans, sheet, idSheet, views };
      this.suggestionCache.set(`${theme}|${JSON.stringify(opts.orientation ?? 'auto')}`, suggestion);
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

      opts = { ...opts, assetClass: this.resolveAssetClass(opts) };
      this.emit('assetClass', { id: opts.assetClass, label: getAssetClass(opts.assetClass)?.label });

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

      // If every texture failed, report that error (not a follow-up one).
      if (firstError && !results.length && remote.length) throw firstError;

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
      const { signal: _s, fixes: _f, ...runOpts } = opts;
      this.lastRun = { theme, opts: runOpts };
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
    let orient = null;
    let parts = null;
    let usedPrompt = theme;
    let original = null;

    if (atlasMode) {
      original = textureToCanvas(slot.texture, maxSize);
      // Parts from the 3D file (one per mesh name), with which way "up" points in the image.
      const rawParts = slotParts(slot);
      const byParts =
        (opts.paintMode ?? 'auto') !== 'atlas' && typeof this.provider.reskinPart === 'function' && rawParts.length > 1;
      if (byParts) {
        // Per-part mode: each part is painted on its own, upright, and pasted back inside its islands.
        parts = rawParts;
        plan = opts.suggestion?.plans?.[slot.id] ?? null;
        raw = await this.paintByParts(slot, theme, rawParts, original, plan, opts, signal, report);
      } else {
        // If the key part (head/face, else the largest) is stored upside down, sideways or
        // mirrored, turn the whole atlas upright before painting and turn the result back.
        orient = resolveOrientation(opts.orientation, rawParts);
        if (orient && !isIdentity(orient)) {
          this.emit('warning', {
            message:
              orient.reason === 'manual'
                ? `"${slot.name}": using the manual orientation (${orient.rot}°${orient.flipX ? ', mirrored' : ''}).`
                : `"${slot.name}": "${orient.reason}" is stored ${orient.rot ? `rotated ${orient.rot}°` : ''}${orient.rot && orient.flipX ? ' and ' : ''}${orient.flipX ? 'mirrored' : ''} in the atlas; painting it upright and turning it back.`,
          });
        }
        parts = transformParts(rawParts, orient);
        const guide =
          rawParts.length > 1
            ? drawPartMap(slot, rawParts, original.width, original.height)
            : drawUvGuide(slot, original.width, original.height, { lineWidth: Math.max(1, original.width / 1024) });
        const uvGuide = transformCanvas(guide, orient);
        const sendAtlas = transformCanvas(original, orient);
        const planKey = `${this.provider.name}:${slot.texture.uuid}:${orient ? `${orient.rot}${orient.flipX}` : ''}`;
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
                atlas: sendAtlas,
                atlasWithUvs: transformCanvas(drawAtlasWithUvs(original, slot), orient),
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
          await this.withFilterRetry('paint atlas', slot, theme, (plain, t) =>
            this.provider.reskinAtlas({
              theme: t,
              slotName: slot.name,
              atlas: sendAtlas,
              uvGuide,
              parts: plain ? undefined : parts,
              width: sendAtlas.width,
              height: sendAtlas.height,
              plan: plain ? null : plan,
              extraInstructions: plain ? undefined : opts.extraInstructions,
              plain,
              signal,
            }),
          ),
        );
      }
    } else {
      report(0.2, 'generate', `Generating seamless texture for "${slot.name}"`);
      raw = await this.toCanvas(
        await this.withFilterRetry('generate texture', slot, theme, (plain, t) =>
          this.provider.generateTexture({
            theme: t,
            materialName: slot.name,
            width,
            height,
            extraInstructions: plain ? undefined : opts.extraInstructions,
            plain,
            signal,
          }),
        ),
      );
    }
    signal.throwIfAborted();
    // Undo the upright transform so the texture matches the model's UVs again.
    if (orient && !isIdentity(orient)) raw = untransformCanvas(raw, orient);

    report(0.7, 'postprocess', `Post-processing "${slot.name}"`);
    let baseColor = resizeCanvas(raw, width, height); // always a fresh copy; `raw` stays as returned
    const islandMap = atlasMode ? islandIdMap(slot, width, height) : null;
    if (islandMap && (opts.cleanTinyIslands ?? true)) {
      // Fingers, buttons and other tiny packed islands: one solid color each, no stray patterns.
      const n = flattenTinyIslands(baseColor, islandMap, opts.tinyIslandFraction ?? 0.002);
      if (n) this.emit('warning', { message: `"${slot.name}": cleaned up ${n} tiny island(s) to solid colors.` });
    }
    const detail = opts.detailPreserve ?? 0.35;
    if (original && detail > 0) baseColor = applyDetailPreserve(baseColor, original, detail);
    if (islandMap && (opts.edgePadding ?? 12) > 0) {
      // Edge padding: grow island colors into the gaps so seams never sample dark pixels.
      padIslands(baseColor, islandMap, Math.max(1, Math.round(((opts.edgePadding ?? 12) * width) / 1024)));
    }

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
    this.showIdMap(false); // never export the ID-map preview materials
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

  /**
   * Runs a paint call; if the model's safety filter rejects it, retries once with a
   * plain prompt (no generated region text) and a toned-down theme.
   */
  /**
   * The asset class for this run: a manual choice, else what the art-director step named,
   * else a guess from the model's part names.
   */
  resolveAssetClass(opts = {}) {
    if (opts.assetClass && opts.assetClass !== 'auto' && getAssetClass(opts.assetClass)) return opts.assetClass;
    const fromMuse = normalizeAssetClass(opts.suggestion?.assetClass);
    if (fromMuse) return fromMuse;
    const partNames = (this.layout?.slots ?? []).flatMap((s) => s.meshes.map((m) => partName(m)));
    return detectAssetClass({ subject: opts.suggestion?.subject, partNames, modelName: this.model?.name });
  }

  /**
   * Paints an atlas part by part. Each part is cut out of the atlas, turned upright by its
   * own orientation, greyed outside its islands, padded to a supported aspect ratio and
   * sent with a part-specific prompt. The results are pasted back only inside each part's
   * (slightly grown) UV area, on top of a copy of the original atlas. Returns that canvas,
   * in the atlas's own orientation.
   */
  async paintByParts(slot, theme, parts, original, plan, opts, signal, report) {
    const W = original.width,
      H = original.height;
    const grow = Math.max(1, Math.round((2 * W) / 1024));
    const manual =
      opts.orientation != null && opts.orientation !== 'auto' ? resolveOrientation(opts.orientation, parts) : null;
    const regions = this.idRegions(slot, opts);
    // Review & fix: areas Muse did not flag reuse their last painted image.
    const prev = opts.fixes ? this.lastPartJobs.get(slot.id) : null;
    const prevByName = new Map((prev?.jobs ?? []).filter((j) => j.painted).map((j) => [j.part.name, j]));
    const jobs = [];
    for (const part of regions) {
      const mask = partMask(slot, part, W, H, grow);
      const rect = maskRect(mask, Math.round(W / 128));
      if (!rect) continue;
      const t = manual ?? chooseOrientation([part]);
      const facing = drawFacingMap(slot, part, W, H, { grow });
      const job = { part, mask, rect, facing, orient: isIdentity(t) ? null : t };
      if (opts.fixes) {
        const fix = opts.fixes[part.name];
        const old = prevByName.get(part.name);
        if (fix) job.note = `Correction from a review of the last attempt: ${fix}`;
        else if (old) job.reuse = old.painted;
      }
      jobs.push(job);
    }
    // Largest area first: it is painted alone and then shown to the others as the style reference.
    jobs.sort((a, b) => b.rect.pixels - a.rect.pixels);
    const turned = jobs.filter((j) => j.orient).map((j) => j.part.name);
    if (turned.length && !manual) {
      this.emit('warning', {
        message: `"${slot.name}": ${turned.join(', ')} ${turned.length > 1 ? 'are' : 'is'} stored rotated or mirrored; painting upright and turning back.`,
      });
    }
    this.emit('regions', {
      slotId: slot.id,
      regions: jobs.map((j) => ({ name: j.part.name, color: j.part.color, hex: j.part.hex, facing: j.facing.share })),
    });
    const names = jobs.map((j) => j.part.name);
    const regionPaint = (part) => {
      const keys = [part.name, part.baseName].filter(Boolean).map((n) => n.toLowerCase());
      const hits = (plan?.regions ?? []).filter((r) => {
        const m = r.name.toLowerCase();
        return keys.some((n) => m === n || m.includes(n) || n.includes(m));
      });
      return (
        hits
          .map((r) => r.description)
          .filter(Boolean)
          .join(' ') || undefined
      );
    };
    const out = copyCanvas(original);
    let done = 0;
    let styleRef = null;
    const toPaint = jobs.filter((j) => !j.reuse).length;
    report(
      0.2,
      'generate',
      toPaint < jobs.length
        ? `Repainting ${toPaint} of ${jobs.length} areas of "${slot.name}"`
        : `Painting "${slot.name}" part by part (${jobs.length} areas)`,
    );
    const paintOne = async (job) => {
      const { part, mask, rect, orient, facing } = job;
      if (job.reuse) {
        pasteInsideMask(out, untransformCanvas(job.reuse, orient), mask, rect);
        job.painted = job.reuse;
        done++;
        return job.reuse;
      }
      const crop = transformCanvas(greyedCrop(original, mask, rect), orient);
      const guide = transformCanvas(cropCanvas(facing.canvas, rect), orient);
      const padded = padToMuseAspect(crop);
      const paddedGuide = padToMuseAspect(guide, { fill: '#000000' });
      const rules = assetClassRules(opts.assetClass, [part.baseName ?? part.name]);
      const img = await this.withFilterRetry(`paint ${part.name}`, slot, theme, (plain, t) =>
        this.provider.reskinPart({
          theme: t,
          slotName: slot.name,
          partName: part.name,
          image: padded.canvas,
          mask: paddedGuide.canvas,
          facing: facingSummary(facing.share),
          styleRef: plain ? null : styleRef,
          subject: plain ? undefined : plan?.subject,
          paint: plain ? undefined : regionPaint(part),
          others: names.filter((n) => n !== part.name),
          classRules: plain ? undefined : rules,
          extra: plain ? undefined : [opts.extraInstructions, job.note].filter(Boolean).join('\n') || undefined,
          plain,
          signal,
        }),
      );
      signal.throwIfAborted();
      const painted = await this.toCanvas(img);
      const upright = unpad(painted, padded.canvas, padded.box, crop.width, crop.height);
      pasteInsideMask(out, untransformCanvas(upright, orient), mask, rect);
      job.painted = upright;
      done++;
      report(0.2 + (0.5 * done) / jobs.length, 'generate', `Painted ${part.name} (${done}/${jobs.length})`);
      return upright;
    };
    const results = [];
    const rest = jobs.slice();
    const reused = jobs.find((j) => j.reuse && !j.note);
    if (reused) styleRef = reused.reuse;
    const styleFirst = !reused && (opts.styleReference ?? true) && jobs.length > 2;
    if (styleFirst) {
      // Paint the biggest area first so every other call can match its palette and style.
      const first = rest.shift();
      const [r] = await mapLimit([first], 1, paintOne);
      results.push(r);
      if (r.status === 'fulfilled') styleRef = r.value;
    }
    results.push(...(await mapLimit(rest, opts.partConcurrency ?? 4, paintOne)));
    signal.throwIfAborted();
    const ordered = styleFirst ? jobs : rest;
    const failed = results.map((r, i) => [r, ordered[i]]).filter(([r]) => r.status === 'rejected');
    if (failed.length === jobs.length && failed.length) throw failed[0][0].reason;
    for (const [r, job] of failed) {
      this.emit('warning', {
        message: `"${slot.name}": could not paint ${job.part.name} (${toError(r.reason).message}); it keeps its old colors.`,
      });
    }
    this.lastPartJobs.set(slot.id, { jobs, original, out, theme, plan, opts });
    return out;
  }

  /**
   * The areas of an atlas slot, each with its own color: every part, split into regions
   * when its UV islands sit in clearly separate groups. These are the areas painted one by
   * one, shown in the ID map, and named in the suggestion and review prompts.
   */
  idRegions(slot, opts = {}) {
    const key = `${slot.id}|${opts.splitRegions !== false}|${opts.maxPaintAreas ?? 12}`;
    const hit = this.regionCache.get(key);
    if (hit) return hit;
    const regions = this.paintRegions(slot, slotParts(slot), opts);
    const out = regions.map((r, i) => ({
      ...r,
      color: PART_COLORS[i % PART_COLORS.length][0],
      hex: PART_COLORS[i % PART_COLORS.length][1],
    }));
    this.regionCache.set(key, out);
    return out;
  }

  /** ID-map textures: per atlas slot, each area filled with its own flat color. */
  idMapTextures(size = 1024) {
    const out = new Map();
    for (const slot of this.layout?.slots ?? []) {
      if (!slot.texture || slot.tiled) continue;
      const { width, height } = fitSize(slot.width || size, slot.height || size, size);
      const c = drawPartMap(slot, this.idRegions(slot), width, height);
      const tex = new THREE.CanvasTexture(c);
      tex.flipY = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.channel = slot.uvChannel;
      out.set(slot.id, { canvas: c, texture: tex, regions: this.idRegions(slot) });
    }
    return out;
  }

  /**
   * Shows (or hides) the ID map on the model: every area in its own flat, unlit color,
   * the same colors as the part map, so you can see which atlas area is which part.
   * Untextured materials get a flat grey.
   */
  showIdMap(on) {
    if (!this.model) return;
    if (!on) {
      for (const [mesh, mat] of this.idMapSaved ?? []) mesh.material = mat;
      this.idMapSaved = null;
      this.emit('idMap', { on: false });
      return;
    }
    if (this.idMapSaved) return;
    const textures = this.idMapTextures();
    const bySlotMat = new Map();
    for (const slot of this.layout.slots) {
      const t = textures.get(slot.id);
      for (const mat of slot.materials) bySlotMat.set(mat, t);
    }
    this.idMapSaved = new Map();
    this.model.scene.traverse((o) => {
      if (!o.isMesh) return;
      this.idMapSaved.set(o, o.material);
      const swap = (m) => {
        const t = bySlotMat.get(m);
        return new THREE.MeshBasicMaterial(
          t ? { map: t.texture, side: m.side } : { color: 0x5a5f6a, side: m?.side ?? THREE.FrontSide },
        );
      };
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    this.emit('idMap', {
      on: true,
      slots: [...textures.entries()].map(([slotId, t]) => ({
        slotId,
        canvas: t.canvas,
        regions: t.regions.map(({ meshes, islands, ...r }) => r),
      })),
    });
  }

  get idMapVisible() {
    return !!this.idMapSaved;
  }

  /** One labelled image of the model from many angles with the ID map shown. */
  renderIdSheet({ size = 288, views, cols } = {}) {
    const wasOn = this.idMapVisible;
    this.showIdMap(true);
    try {
      return renderAxisViews(this.model.scene, { size, views, cols }).sheet;
    } finally {
      if (!wasOn) this.showIdMap(false);
    }
  }

  /** Whether the provider can review a painted result. */
  get canReview() {
    return typeof this.provider.reviewResult === 'function';
  }

  /**
   * Review & fix: renders the painted model from eight angles (the six axis views plus
   * 45° views of the front and back) above the same views as an ID map, all in ONE image,
   * and asks Muse to compare it with the prompt. Muse returns notes per area; the flagged
   * areas are repainted with the note as a correction while the other areas keep their
   * painted image. Repeats up to `passes` times (default 1) or until Muse finds nothing.
   * Returns { passes: [{ notes, sheet, repainted }] }.
   */
  async postReview(opts = {}) {
    this.guard();
    if (!this.lastRun || !this.lastResult) throw new Error('Paint the model before reviewing it');
    if (!this.canReview) throw new Error(`${this.provider.name} cannot review results`);
    const passes = Math.max(1, Math.min(opts.passes ?? 1, 3));
    const out = [];
    for (let i = 0; i < passes; i++) {
      const review = await this.reviewOnce(opts);
      const fixable = review.issues.filter((x) => x.area && this.areaNames().includes(x.area));
      const pass = { notes: review, sheet: review.sheet, repainted: [] };
      out.push(pass);
      if (opts.fix === false || !fixable.length) break;
      const fixes = {};
      for (const x of fixable) fixes[x.area] = [fixes[x.area], x.fix || x.problem].filter(Boolean).join(' ');
      pass.repainted = Object.keys(fixes);
      this.status('reskinning', `Repainting ${pass.repainted.join(', ')}`);
      await this.postPrompt(this.lastRun.theme, { ...this.lastRun.opts, fixes, signal: opts.signal });
    }
    return { passes: out };
  }

  /** Names of all areas painted one by one in the last run. */
  areaNames() {
    return [...this.lastPartJobs.values()].flatMap((r) => r.jobs.map((j) => j.part.name));
  }

  async reviewOnce(opts = {}) {
    this.busy = true;
    this.abort = new AbortController();
    const signal = opts.signal ? anySignal([opts.signal, this.abort.signal]) : this.abort.signal;
    try {
      this.status('analyzing', 'Rendering the result from 8 angles for review…');
      this.emit('progress', { stage: 'review', message: 'Rendering the result for review', progress: 0.1 });
      const size = opts.viewSize ?? 256;
      const idWasOn = this.idMapVisible;
      if (idWasOn) this.showIdMap(false);
      const painted = renderAxisViews(this.model.scene, { size, views: REVIEW_VIEWS, cols: 4 }).sheet;
      if (idWasOn) this.showIdMap(true);
      const ids = this.renderIdSheet({ size, views: REVIEW_VIEWS, cols: 4 });
      const sheet = stackCanvases([painted, ids]);
      this.emit('progress', { stage: 'review', message: 'Muse is reviewing the result', progress: 0.4 });
      const areas = [];
      for (const slot of this.layout.slots) {
        const run = this.lastPartJobs.get(slot.id);
        if (!run) continue;
        const regions = this.idRegions(slot);
        for (const j of run.jobs) {
          const r = regions.find((x) => x.name === j.part.name);
          areas.push({ name: j.part.name, color: r?.color, facing: facingSummary(j.facing.share) });
        }
      }
      const theme = this.lastRun.theme;
      const notes = await this.timed('review result', null, () =>
        this.provider.reviewResult({
          theme,
          sheet,
          areas,
          subject: this.lastRun.opts.suggestion?.subject,
          classRules: assetClassRules(
            this.lastRun.opts.assetClass,
            areas.map((a) => a.name),
          ),
          signal,
        }),
      );
      for (const x of notes.issues) {
        x.problem = x.problem && sanitizePrompt(x.problem);
        x.fix = x.fix && sanitizePrompt(x.fix);
      }
      const review = { ...notes, sheet };
      this.emit('review', review);
      this.status('idle', notes.issues.length ? `Review: ${notes.issues.length} issue(s)` : 'Review: looks good');
      return review;
    } catch (err) {
      this.fail(err, 'review');
      throw err;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  /**
   * The areas painted one by one: each part, split into regions when its UV islands sit
   * in clearly separate groups (for example a torso and two sleeves). At most 12 in total;
   * the smallest parts are left whole if there are more.
   */
  paintRegions(slot, parts, opts = {}) {
    if (opts.splitRegions === false) return parts;
    const max = opts.maxPaintAreas ?? 12;
    const out = [];
    let left = max;
    parts.forEach((p, i) => {
      const remainingParts = parts.length - i - 1;
      const split = left - remainingParts > 1 ? splitPartRegions(slot, p) : [p];
      const take = split.length <= left - remainingParts ? split : [p];
      out.push(...take);
      left -= take.length;
    });
    return out.slice(0, max);
  }

  async withFilterRetry(step, slot, theme, call) {
    try {
      return await this.timed(step, slot.id, () => call(false, theme));
    } catch (err) {
      if (!isContentPolicyError(err)) throw err;
      const softer = softenTheme(theme);
      this.emit('warning', {
        message: `Muse's safety filter rejected the "${step}" request for "${slot.name}". Retrying with a plainer prompt: "${softer}".`,
      });
      try {
        return await this.timed(`${step} (plain retry)`, slot.id, () => call(true, softer));
      } catch (err2) {
        if (isContentPolicyError(err2)) {
          const e = new Error(
            `Muse's safety filter rejected the theme "${theme}" (${step}, also after a plainer retry). Try rewording it: gentler words usually pass (e.g. "spooky" instead of "scary", no blood or weapons).`,
          );
          e.code = 'content_policy_violation';
          e.step = step;
          throw e;
        }
        throw err2;
      }
    }
  }

  /** Runs one provider call and emits a `timing` event with how long it took. */
  async timed(step, slotId, fn) {
    const t0 = performance.now();
    let ok = false;
    let error = null;
    try {
      const out = await fn();
      ok = true;
      return out;
    } catch (err) {
      if (err && typeof err === 'object' && !err.step) err.step = step;
      error = err;
      throw err;
    } finally {
      const slot = slotId ? this.layout?.slots.find((s) => s.id === slotId) : null;
      this.emit('timing', {
        step,
        slotId,
        slotName: slot?.name,
        ms: performance.now() - t0,
        ok,
        error: error ? String(error.message ?? error) : undefined,
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

/** Word swaps that keep the look but avoid phrases image safety filters commonly reject. */
const SAFE_WORDING = [
  [/\bblood[- ]red\b/gi, 'crimson'],
  [/\bblood[- ]?(stained|soaked|spattered|splattered)\b/gi, 'paint-splattered'],
  [/\bdripping blood\b/gi, 'dripping red paint'],
  [/\bblood\b/gi, 'red paint'],
  [/\bbloody\b/gi, 'crimson'],
  [/\b(gore|gory|guts|entrails)\b/gi, 'messy paint'],
  [/\b(wounds?|gashes|gash|injur(y|ies))\b/gi, 'cracks'],
  [/\beye sockets\b/gi, 'eye makeup'],
  [/\b(corpse|cadaver)\b/gi, 'ghost'],
  [/\b(severed|mutilated|decapitated)\b/gi, 'patchwork'],
];

/** Rewrites generated prompt text to avoid common safety-filter triggers. */
export function sanitizePrompt(text) {
  let t = String(text ?? '');
  for (const [re, word] of SAFE_WORDING) t = t.replace(re, word);
  return t;
}

const SOFTEN = [
  [
    /\b(scary|creepy|horror|horrifying|terrifying|frightening|evil|sinister|menacing|demonic|nightmare\w*)\b/gi,
    'spooky',
  ],
  [/\b(blood\w*|gor(e|y)|guts)\b/gi, 'red paint'],
  [/\b(dead|death|zombie|corpse|undead|skull\w*)\b/gi, 'ghostly'],
  [/\b(kill\w*|murder\w*|weapon\w*|gun\w*|knife|knives|violent|violence)\b/gi, 'bold'],
];

/** Tones a theme down for a retry after a content-filter rejection ("scary clown" -> "spooky clown, playful Halloween style"). */
export function softenTheme(theme) {
  let t = theme;
  for (const [re, word] of SOFTEN) t = t.replace(re, word);
  t = t.replace(/\b(\w+)( \1\b)+/gi, '$1').trim();
  return t === theme ? `${theme}, playful cartoon style` : `${t}, playful Halloween style`;
}
