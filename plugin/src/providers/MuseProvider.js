import { MuseApiError, MuseClient, isContentPolicyError } from '../muse/MuseClient.js';
import {
  normalMapPrompt,
  parseLayoutPlan,
  reskinAtlasPrompt,
  roughnessMapPrompt,
  parseSuggestion,
  plainReskinAtlasPrompt,
  plainSeamlessTexturePrompt,
  seamlessTexturePrompt,
  suggestPrompt as suggestPromptText,
  visionPlanPrompt,
} from '../muse/prompts.js';
import { canvasToDataUrl, fitSize, museSizeFor, resizeCanvas } from '../texture/imageUtils.js';

/**
 * @typedef {import('../muse/MuseClient.js').MuseClientOptions & {
 *   fast?: boolean,
 *   aiAuxMaps?: boolean,
 *   uploadMaxSize?: number,
 *   reasoningStrength?: 'low' | 'high',
 *   disableSearchTools?: boolean,
 * }} MuseProviderOptions
 *
 * fast (default true): turn off Muse's web / image search and shell tools, use low
 *   reasoning strength, and send smaller images. Much quicker; the texture prompt is
 *   self-contained, so search rarely helps.
 * aiAuxMaps (default false): also ask Muse to repaint normal / roughness maps
 *   (2 extra image calls per texture). Otherwise they are derived locally.
 * uploadMaxSize: longest side of images uploaded to Muse. Default 1024 (fast) / 1536.
 */

/** Texture provider backed by Meta Muse: muse-spark reads the layout, muse-image paints. */
export class MuseProvider {
  name = 'Meta Muse';
  client;
  opts;
  /** Set if the API rejected the speed options, so they are not sent again. */
  extrasRejected = false;

  /** @param {MuseProviderOptions | MuseClient} [opts] */
  constructor(opts = {}) {
    if (opts instanceof MuseClient) {
      this.client = opts;
      this.opts = {};
    } else {
      this.client = new MuseClient(opts);
      this.opts = opts;
    }
    if (this.opts.aiAuxMaps) this.reskinAuxMap = this.aiReskinAuxMap;
  }

  reskinAuxMap;

  get fast() {
    return this.opts.fast ?? true;
  }

  /** Turn fast mode on or off. */
  setFast(on) {
    this.opts = { ...this.opts, fast: on };
  }

  toUpload(c, kind = 'photo') {
    const max = this.opts.uploadMaxSize ?? (this.fast ? 1024 : 1536);
    const { width, height } = fitSize(c.width, c.height, max);
    const scaled = width === c.width && height === c.height ? c : resizeCanvas(c, width, height);
    // Painted atlases compress well as JPEG (much smaller upload); line guides stay PNG.
    return kind === 'guide' ? canvasToDataUrl(scaled, 'image/png') : canvasToDataUrl(scaled, 'image/jpeg', 0.9);
  }

  get imageExtras() {
    if (this.extrasRejected) return { outputFormat: 'png' };
    const fast = this.fast;
    const disable = fast || this.opts.disableSearchTools;
    return {
      outputFormat: 'png',
      reasoningStrength: this.opts.reasoningStrength ?? (fast ? 'low' : undefined),
      toolEnablement: disable
        ? { enable_image_search: false, enable_web_search: false, enable_shell: false }
        : undefined,
    };
  }

  /** Calls an image endpoint; if the speed options are rejected (400), retries once without them. */
  async paint(method, args) {
    try {
      return await this.client[method]({ ...args, ...this.imageExtras });
    } catch (err) {
      const extrasSent =
        !this.extrasRejected && (this.imageExtras.reasoningStrength || this.imageExtras.toolEnablement);
      if (
        extrasSent &&
        err instanceof MuseApiError &&
        err.status === 400 &&
        /reasoning_strength|tool_enablement|enable_/i.test(`${err.param ?? ''} ${err.message}`)
      ) {
        this.extrasRejected = true;
        return this.client[method]({ ...args, ...this.imageExtras });
      }
      throw err;
    }
  }

  async planLayout(req) {
    // Fast mode: one image (atlas with UV outlines drawn on it) at 768px, minimal reasoning.
    const images = this.fast
      ? [this.toUploadSized(req.atlasWithUvs, 768)]
      : [this.toUpload(req.atlas), this.toUpload(req.atlasWithUvs)];
    const text = await this.client.chat({
      reasoningEffort: this.fast ? 'minimal' : 'low',
      signal: req.signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPlanPrompt(req.slotName, req.meshNames, images.length) },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
    });
    return parseLayoutPlan(text);
  }

  /**
   * Art-director step: Muse Spark looks at six renders of the model plus the UV atlases
   * and recommends a better prompt and a per-region paint plan.
   * @param {{ theme: string, sheet?: HTMLCanvasElement, atlases: { name: string, meshNames: string[], atlasWithUvs: HTMLCanvasElement }[], signal?: AbortSignal }} req
   */
  async suggestPrompt(req) {
    const images = [];
    if (req.sheet) images.push(this.toUploadSized(req.sheet, this.fast ? 1152 : 1536));
    for (const a of req.atlases.slice(0, 4)) images.push(this.toUploadSized(a.atlasWithUvs, this.fast ? 768 : 1024));
    const text = await this.client.chat({
      reasoningEffort: this.fast ? 'low' : 'medium',
      signal: req.signal,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: suggestPromptText(req.theme, req.atlases.slice(0, 4), !!req.sheet) },
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ],
        },
      ],
    });
    const s = parseSuggestion(text);
    if (!s) throw new Error('Muse returned a suggestion that could not be read');
    return s;
  }

  /**
   * Content-filter probe: small separate requests to isolate what Muse rejects.
   * Runs one after another so each result is independent. Returns
   * [{ name, description, ok, ms, error? }].
   */
  async probeFilter({ theme, atlas, uvGuide, plan, signal, onResult }) {
    const small = (c, kind) =>
      kind === 'guide' ? canvasToDataUrl(resizeCanvas(c, 512, 512), 'image/png') : this.toUploadSized(c, 512);
    const fullPrompt = reskinAtlasPrompt(theme, plan);
    const neutral = 'Recolor this texture image in calm shades of blue. Keep every shape in exactly the same place.';
    const tests = [
      {
        name: 'theme only',
        description: `text→image with just "${theme}"`,
        run: () => this.paint('generateImage', { prompt: theme, size: '1024x1024', signal }),
      },
      {
        name: 'full prompt, no images',
        description: 'text→image with the complete paint prompt',
        run: () => this.paint('generateImage', { prompt: fullPrompt, size: '1024x1024', signal }),
      },
      {
        name: 'prompt + atlas',
        description: 'edit: paint prompt + the texture atlas only',
        run: () => this.paint('editImage', { prompt: fullPrompt, images: [small(atlas)], size: '1024x1024', signal }),
      },
      {
        name: 'prompt + UV mask',
        description: 'edit: paint prompt + the UV mask only',
        run: () =>
          this.paint('editImage', { prompt: fullPrompt, images: [small(uvGuide, 'guide')], size: '1024x1024', signal }),
      },
      {
        name: 'neutral + atlas',
        description: 'edit: harmless "recolor blue" prompt + the texture atlas',
        run: () => this.paint('editImage', { prompt: neutral, images: [small(atlas)], size: '1024x1024', signal }),
      },
    ];
    const results = [];
    for (const t of tests) {
      signal?.throwIfAborted();
      const t0 = performance.now();
      let r;
      try {
        await t.run();
        r = { name: t.name, description: t.description, ok: true, ms: performance.now() - t0 };
      } catch (err) {
        if (signal?.aborted) throw err;
        r = {
          name: t.name,
          description: t.description,
          ok: false,
          ms: performance.now() - t0,
          error: String(err?.message ?? err),
          filtered: isContentPolicyError(err),
        };
      }
      results.push(r);
      onResult?.(r);
    }
    return results;
  }

  toUploadSized(c, max) {
    const { width, height } = fitSize(c.width, c.height, max);
    return canvasToDataUrl(resizeCanvas(c, width, height), 'image/jpeg', 0.9);
  }

  reskinAtlas(req) {
    return this.paint('editImage', {
      prompt: req.plain
        ? plainReskinAtlasPrompt(req.theme)
        : reskinAtlasPrompt(req.theme, req.plan, req.extraInstructions, req.parts),
      // The plain retry sends only the atlas (no wireframe guide image).
      images: req.plain ? [this.toUpload(req.atlas)] : [this.toUpload(req.atlas), this.toUpload(req.uvGuide, 'guide')],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
  }

  generateTexture(req) {
    return this.paint('generateImage', {
      prompt: req.plain
        ? plainSeamlessTexturePrompt(req.theme)
        : seamlessTexturePrompt(req.theme, req.materialName, req.extraInstructions),
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
  }

  aiReskinAuxMap = (req) =>
    this.paint('editImage', {
      prompt: req.kind === 'normal' ? normalMapPrompt(req.theme) : roughnessMapPrompt(req.theme),
      images: [this.toUpload(req.source, 'guide'), this.toUpload(req.newBaseColor)],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
}
