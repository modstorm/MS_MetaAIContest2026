/**
 * Minimal client for the Meta Model API (Muse models).
 * Docs: https://dev.meta.ai/docs/image-generation, https://dev.meta.ai/docs/image-understanding
 *
 *  - POST {base}/images/generations  text -> image   (muse-image-1.0)
 *  - POST {base}/images/edits        image(s) + text -> image (JSON body with `images: [{image_url}]`)
 *  - POST {base}/chat/completions    vision / text  (muse-spark-1.3)
 *
 * Works in the browser with an API key (direct), or against a proxy that adds the key
 * (see `@metaai26/reskin-plugin/server`). If the direct call fails at the network level
 * (for example CORS), it retries once against `fallbackBaseUrl` when one is set.
 */

export const MUSE_DEFAULT_BASE = 'https://api.meta.ai/v1';
export const MUSE_IMAGE_MODEL = 'muse-image-1.0';
export const MUSE_VISION_MODEL = 'muse-spark-1.3';

export class MuseApiError extends Error {
  constructor(message, status, type, code, body) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.body = body;
    this.param = body && typeof body === 'object' ? body.error?.param : undefined;
    this.name = 'MuseApiError';
  }

  /** True when Muse's safety filter rejected the prompt or the output. */
  get isContentPolicy() {
    return isContentPolicyError(this);
  }
}

/** True for content-filter rejections (from Muse or any error with a matching message). */
export function isContentPolicyError(err) {
  if (!err) return false;
  if (err.code === 'content_policy_violation') return true;
  return /content (management |moderation )?polic|filtered due to|safety (system|filter)/i.test(
    String(err.message ?? ''),
  );
}

export class MuseClient {
  /** Optional hook called after every request: { url, method, request, status, ms, error }. Images are shortened. */
  onExchange = null;
  options;
  fetchImpl;

  constructor(opts = {}) {
    this.options = {
      apiKey: opts.apiKey,
      baseUrl: (opts.baseUrl ?? MUSE_DEFAULT_BASE).replace(/\/+$/, ''),
      fallbackBaseUrl: opts.fallbackBaseUrl?.replace(/\/+$/, ''),
      imageModel: opts.imageModel ?? MUSE_IMAGE_MODEL,
      visionModel: opts.visionModel ?? MUSE_VISION_MODEL,
      timeoutMs: opts.timeoutMs ?? 180_000,
      maxRetries: opts.maxRetries ?? 2,
      user: opts.user,
    };
    this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  /** Text -> image. Returns the image as a Blob. */
  async generateImage(o) {
    const json = await this.post('/images/generations', this.imageBody(o), o.signal);
    return this.firstImage(json, o.outputFormat ?? 'png');
  }

  /** Image(s) + text -> image. Returns the image as a Blob. */
  async editImage(o) {
    if (!o.images.length || o.images.length > 10) throw new Error('editImage needs 1 to 10 images');
    const body = { ...this.imageBody(o), images: o.images.map((image_url) => ({ image_url })) };
    const json = await this.post('/images/edits', body, o.signal);
    return this.firstImage(json, o.outputFormat ?? 'png');
  }

  /** Chat completions (text and vision). Returns the assistant's text. */
  async chat(o) {
    const body = {
      model: o.model ?? this.options.visionModel,
      messages: o.messages,
    };
    if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort;
    if (o.temperature !== undefined) body.temperature = o.temperature;
    const json = await this.post('/chat/completions', body, o.signal);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => p?.text ?? '').join('');
    throw new MuseApiError('Unexpected chat response shape', 200, undefined, undefined, json);
  }

  imageBody(o) {
    // Only documented fields: unknown top-level fields return 400.
    const body = {
      model: this.options.imageModel,
      prompt: o.prompt,
      n: 1,
      response_format: 'b64_json',
      output_format: o.outputFormat ?? 'png',
    };
    if (o.size) body.size = o.size;
    if (o.reasoningStrength) body.reasoning_strength = o.reasoningStrength;
    if (o.toolEnablement) body.tool_enablement = o.toolEnablement;
    if (this.options.user) body.user = this.options.user;
    return body;
  }

  async firstImage(json, format) {
    const item = json?.data?.[0];
    const fmt = json?.output_format ?? format;
    if (item?.b64_json) return base64ToBlob(item.b64_json, `image/${fmt}`);
    if (item?.url) {
      const r = await this.fetchImpl(item.url);
      if (!r.ok) throw new MuseApiError(`Could not download generated image (${r.status})`, r.status);
      return r.blob();
    }
    throw new MuseApiError('Muse returned no image', 200, undefined, undefined, json);
  }

  async post(path, body, signal) {
    try {
      return await this.postTo(this.options.baseUrl, path, body, signal);
    } catch (err) {
      const fb = this.options.fallbackBaseUrl;
      if (fb && fb !== this.options.baseUrl && isNetworkError(err) && !signal?.aborted) {
        return this.postTo(fb, path, body, signal);
      }
      throw err;
    }
  }

  async postTo(base, path, body, signal) {
    const headers = { 'Content-Type': 'application/json' };
    // Only send the key to the real API; a proxy adds its own.
    if (this.options.apiKey && /^https?:\/\//.test(base)) headers.Authorization = `Bearer ${this.options.apiKey}`;
    if (!headers.Authorization && /^https:\/\/api\.meta\.ai/.test(base)) {
      throw new MuseApiError('No Muse API key set. Add MUSE_API_KEY to .env or use the proxy.', 401, 'auth_error');
    }

    let attempt = 0;
    const t0 = performance.now();
    const report = (status, error) =>
      this.onExchange?.({
        url: `${base}${path}`,
        method: 'POST',
        request: redactImages(body),
        status,
        ms: performance.now() - t0,
        error,
      });
    for (;;) {
      const timeout = AbortSignal.timeout(this.options.timeoutMs);
      const combined = signal ? anySignal([signal, timeout]) : timeout;
      const res = await this.fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON body */
      }
      if (res.ok) {
        report(res.status);
        return json;
      }

      const retryable = res.status === 503 || res.status === 500 || res.status === 429;
      if (retryable && attempt < this.options.maxRetries) {
        attempt++;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** (attempt - 1),
          signal,
        );
        continue;
      }
      const e = json?.error ?? {};
      report(res.status, e.message ?? text.slice(0, 300));
      throw new MuseApiError(
        e.message ?? `Muse request failed: ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
        res.status,
        e.type,
        e.code,
        json ?? text,
      );
    }
  }
}

/** Deep copy of a request body with data-URL images replaced by a short placeholder. */
export function redactImages(value) {
  if (typeof value === 'string') {
    const m = /^data:([^;,]+)[;,]/.exec(value);
    return m ? `[${m[1]} image, ${Math.round((value.length * 0.75) / 1024)} KB]` : value;
  }
  if (Array.isArray(value)) return value.map(redactImages);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactImages(v);
    return out;
  }
  return value;
}

export function base64ToBlob(b64, mime) {
  const clean = b64.replace(/^data:[^;]+;base64,/, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function isNetworkError(err) {
  return err instanceof TypeError; // fetch rejects with TypeError on network/CORS failures
}

function anySignal(signals) {
  const anyFn = AbortSignal.any;
  if (anyFn) return anyFn(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) ctrl.abort(s.reason);
    else s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
