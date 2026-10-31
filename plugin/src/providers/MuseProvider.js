import { MuseApiError, MuseClient } from '../muse/MuseClient.js';
import {
  normalMapPrompt,
  parseLayoutPlan,
  reskinAtlasPrompt,
  roughnessMapPrompt,
  seamlessTexturePrompt,
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

  toUploadSized(c, max) {
    const { width, height } = fitSize(c.width, c.height, max);
    return canvasToDataUrl(resizeCanvas(c, width, height), 'image/jpeg', 0.9);
  }

  reskinAtlas(req) {
    return this.paint('editImage', {
      prompt: reskinAtlasPrompt(req.theme, req.plan, req.extraInstructions),
      images: [this.toUpload(req.atlas), this.toUpload(req.uvGuide, 'guide')],
      size: museSizeFor(req.width, req.height),
      signal: req.signal,
    });
  }

  generateTexture(req) {
    return this.paint('generateImage', {
      prompt: seamlessTexturePrompt(req.theme, req.materialName, req.extraInstructions),
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
