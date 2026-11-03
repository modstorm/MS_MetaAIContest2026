/**
 * Muse usage tally and cost estimate.
 *
 * Prices from https://dev.meta.ai/docs/pricing-rate-limits (read 2026-11-02), in US dollars:
 *  - muse-image-1.0   $0.01 per returned image. Filtered or failed requests are not billed.
 *  - muse-spark-1.3   $1.25 / 1M input, $4.25 / 1M output, $0.15 / 1M cached input tokens.
 *  - muse-wonder-1.0  $4 / 1M input, $20 / 1M output (Preview; no cached price listed, so
 *                     cached tokens are counted at the input price).
 *  - sam-3.1          $2.50 per 1,000 segmented images (billed per image, not per token).
 *  - muse-voice-transcribe-1.0  $3 per 1,000 minutes of audio, billed per whole second
 *                     (https://dev.meta.ai/models/muse-voice-transcribe, read 2026-11-03).
 * The estimate is only as good as this table: check the page if Meta changes its prices.
 */

export const MUSE_WONDER_MODEL = 'muse-wonder-1.0';

/** Price per unit, in dollars. Token prices are per 1M tokens. */
export const MUSE_PRICES = {
  'muse-image-1.0': { image: 0.01 },
  'muse-spark-1.3': { input: 1.25, output: 4.25, cached: 0.15 },
  'muse-wonder-1.0': { input: 4, output: 20 },
  'sam-3.1': { segment: 0.0025 },
  'muse-voice-transcribe-1.0': { audioSecond: 3 / 1000 / 60 },
};

/** Price entry for a model id (also matches later versions, e.g. muse-spark-1.4 → spark prices). */
export function priceFor(model) {
  if (MUSE_PRICES[model]) return MUSE_PRICES[model];
  const family = String(model ?? '').replace(/-\d+(\.\d+)*$/, '');
  const key = Object.keys(MUSE_PRICES).find((k) => k.startsWith(`${family}-`));
  return key ? MUSE_PRICES[key] : null;
}

/** An empty tally. */
export function emptyUsage() {
  return {
    calls: 0,
    images: 0,
    segments: 0,
    audioSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    byModel: {},
  };
}

/**
 * Adds one billed request to a tally (mutates and returns it).
 * @param {ReturnType<typeof emptyUsage>} usage
 * @param {{ model: string, images?: number, segments?: number, audioSeconds?: number, inputTokens?: number, outputTokens?: number, cachedTokens?: number }} entry
 */
export function addUsage(usage, entry) {
  const m = (usage.byModel[entry.model] ??= {
    calls: 0,
    images: 0,
    segments: 0,
    audioSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  });
  for (const t of [usage, m]) {
    t.calls += 1;
    t.images += entry.images ?? 0;
    t.segments = (t.segments ?? 0) + (entry.segments ?? 0);
    t.audioSeconds = (t.audioSeconds ?? 0) + (entry.audioSeconds ?? 0);
    t.inputTokens += entry.inputTokens ?? 0;
    t.outputTokens += entry.outputTokens ?? 0;
    t.cachedTokens += entry.cachedTokens ?? 0;
  }
  return usage;
}

/** Estimated cost in dollars of a tally. Models with no known price count as 0 (see `unpriced`). */
export function usageCost(usage) {
  let total = 0;
  for (const [model, u] of Object.entries(usage.byModel)) {
    const p = priceFor(model);
    if (!p) continue;
    total += (p.image ?? 0) * u.images;
    total += (p.segment ?? 0) * (u.segments ?? 0);
    total += (p.audioSecond ?? 0) * (u.audioSeconds ?? 0);
    // Cached input tokens are part of the input count; bill them at the cached price where one exists.
    const cached = Math.min(u.cachedTokens, u.inputTokens);
    total += ((u.inputTokens - cached) * (p.input ?? 0)) / 1e6;
    total += (cached * (p.cached ?? p.input ?? 0)) / 1e6;
    total += (u.outputTokens * (p.output ?? 0)) / 1e6;
  }
  return total;
}

/** Model ids in a tally with no price in MUSE_PRICES. */
export function unpriced(usage) {
  return Object.keys(usage.byModel).filter((m) => !priceFor(m));
}

/** "14 images + 38k tokens ≈ $0.17" */
export function formatUsage(usage) {
  const tokens = usage.inputTokens + usage.outputTokens;
  const parts = [];
  if (usage.images) parts.push(`${usage.images} image${usage.images === 1 ? '' : 's'}`);
  if (tokens) parts.push(`${formatTokens(tokens)} tokens`);
  if (usage.segments) parts.push(`${usage.segments} SAM check${usage.segments === 1 ? '' : 's'}`);
  if (usage.audioSeconds) parts.push(`${usage.audioSeconds} s of speech`);
  if (!parts.length) return usage.calls ? `${usage.calls} calls ≈ $0.00` : 'no Muse calls';
  return `${parts.join(' + ')} ≈ ${formatDollars(usageCost(usage))}`;
}

export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${n < 10_000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

export function formatDollars(x) {
  if (x > 0 && x < 0.01) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(2)}`;
}
