import { describe, expect, it } from 'vitest';
import { sanitizePrompt, softenTheme } from '../src/ReskinPlugin.js';
import { isContentPolicyError } from '../src/muse/MuseClient.js';
import { reskinAtlasPrompt } from '../src/muse/prompts.js';

describe('safety wording', () => {
  it('rewrites gore phrasing from a real Muse suggestion', () => {
    const out = sanitizePrompt(
      'smeared black eye sockets, wide blood-red grinning mouth, yellow stars and dripping blood motifs, blood-stained jacket',
    );
    expect(out).not.toMatch(/blood|sockets/i);
    expect(out).toMatch(/crimson/);
    expect(out).toMatch(/dripping red paint/);
  });

  it('softens a theme for the retry', () => {
    expect(softenTheme('scary clown')).toBe('spooky clown, playful Halloween style');
    expect(softenTheme('pastel candy')).toBe('pastel candy, playful cartoon style');
  });

  it('recognizes Muse content filter errors', () => {
    expect(
      isContentPolicyError({
        message: 'The response was filtered due to the prompt triggering our content management policy.',
      }),
    ).toBe(true);
    expect(isContentPolicyError({ code: 'content_policy_violation', message: 'x' })).toBe(true);
    expect(isContentPolicyError(new Error('Invalid API key'))).toBe(false);
  });

  it('paint prompt has no watermark wording', () => {
    expect(reskinAtlasPrompt('ice', null)).not.toMatch(/watermark/i);
  });
});
