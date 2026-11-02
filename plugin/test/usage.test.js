import { describe, expect, it } from 'vitest';
import { MuseApiError, MuseClient, retryDelay } from '../src/muse/MuseClient.js';
import { addUsage, emptyUsage, formatUsage, priceFor, usageCost } from '../src/muse/pricing.js';
import { MuseProvider } from '../src/providers/MuseProvider.js';

/** fetch stub: returns the queued responses in order and records the request bodies. */
function stubFetch(responses) {
  const bodies = [];
  const fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const r = responses.shift();
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  return { fetch, bodies };
}

const chatReply = (text, usage) => ({ body: { choices: [{ message: { content: text } }], usage } });

describe('cost estimate', () => {
  it('prices images and tokens per model', () => {
    const u = emptyUsage();
    for (let i = 0; i < 14; i++) addUsage(u, { model: 'muse-image-1.0', images: 1 });
    addUsage(u, { model: 'muse-spark-1.3', inputTokens: 30_000, outputTokens: 8_000 });
    // 14 × $0.01 + 30k × $1.25/M + 8k × $4.25/M = 0.14 + 0.0375 + 0.034
    expect(usageCost(u)).toBeCloseTo(0.2115, 6);
    expect(formatUsage(u)).toBe('14 images + 38k tokens ≈ $0.21');
    expect(u.calls).toBe(15);
  });

  it('bills cached input at the cached price, and Wonder at its own price', () => {
    const u = emptyUsage();
    addUsage(u, { model: 'muse-spark-1.3', inputTokens: 1e6, cachedTokens: 1e6, outputTokens: 0 });
    expect(usageCost(u)).toBeCloseTo(0.15, 6);
    const w = emptyUsage();
    addUsage(w, { model: 'muse-wonder-1.0', inputTokens: 1e6, outputTokens: 1e6 });
    expect(usageCost(w)).toBeCloseTo(24, 6);
  });

  it('matches later versions of a model family', () => {
    expect(priceFor('muse-spark-1.4')).toEqual(priceFor('muse-spark-1.3'));
    expect(priceFor('some-other-model')).toBeNull();
  });
});

describe('MuseClient usage reporting', () => {
  it('reports chat tokens and returned images', async () => {
    const { fetch } = stubFetch([
      chatReply('hi', { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 200 } }),
      { body: { data: [{ b64_json: btoa('png') }] } },
    ]);
    const client = new MuseClient({ apiKey: 'k', fetch });
    const seen = [];
    client.onUsage = (u) => seen.push(u);
    await client.chat({ messages: [] });
    await client.generateImage({ prompt: 'x' });
    expect(seen).toEqual([
      { model: 'muse-spark-1.3', kind: 'chat', images: 0, inputTokens: 1200, outputTokens: 300, cachedTokens: 200 },
      { model: 'muse-image-1.0', kind: 'image', images: 1 },
    ]);
  });

  it('does not count filtered images', async () => {
    const { fetch } = stubFetch([
      { status: 400, body: { error: { message: 'filtered due to safety system', code: 'content_policy_violation' } } },
    ]);
    const client = new MuseClient({ apiKey: 'k', fetch });
    const seen = [];
    client.onUsage = (u) => seen.push(u);
    await expect(client.generateImage({ prompt: 'x' })).rejects.toBeInstanceOf(MuseApiError);
    expect(seen).toEqual([]);
  });
});

describe('retry backoff', () => {
  it('adds up to 50% jitter to the backoff and to Retry-After', () => {
    expect(retryDelay(1, NaN, () => 0)).toBe(1500);
    expect(retryDelay(2, NaN, () => 1)).toBe(4500);
    expect(retryDelay(1, 2, () => 0.5)).toBe(2500);
  });
});

describe('advice model (Muse Wonder)', () => {
  const review = JSON.stringify({ issues: [] });

  it('uses Spark by default and Wonder when chosen', async () => {
    const { fetch, bodies } = stubFetch([chatReply(review), chatReply(review)]);
    const p = new MuseProvider({ apiKey: 'k', fetch });
    const canvas = { width: 8, height: 8 };
    p.toUploadSized = () => 'data:image/png;base64,AA==';
    await p.reviewResult({ theme: 't', sheet: canvas, areas: [] });
    p.setAdviceModel('muse-wonder-1.0');
    await p.reviewResult({ theme: 't', sheet: canvas, areas: [] });
    expect(bodies.map((b) => b.model)).toEqual(['muse-spark-1.3', 'muse-wonder-1.0']);
  });

  it('falls back to Spark when Wonder rejects the request', async () => {
    const { fetch, bodies } = stubFetch([
      { status: 400, body: { error: { message: 'model does not support images' } } },
      chatReply(review),
      chatReply(review),
    ]);
    const p = new MuseProvider({ apiKey: 'k', fetch, adviceModel: 'muse-wonder-1.0' });
    p.toUploadSized = () => 'data:image/png;base64,AA==';
    const notices = [];
    p.onNotice = (m) => notices.push(m);
    await p.reviewResult({ theme: 't', sheet: {}, areas: [] });
    await p.reviewResult({ theme: 't', sheet: {}, areas: [] });
    expect(bodies.map((b) => b.model)).toEqual(['muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.3']);
    expect(notices).toHaveLength(1);
  });
});
