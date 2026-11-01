import { describe, expect, it } from 'vitest';
import { looseJson, parseSuggestion } from '../src/muse/prompts.js';

describe('looseJson', () => {
  it('reads fenced JSON with prose around it', () => {
    expect(looseJson('Sure!\n```json\n{"a": 1}\n```\nHope that helps')).toEqual({ a: 1 });
  });
  it('fixes trailing commas, smart quotes and bare keys', () => {
    expect(looseJson('{“a”: [1, 2,], b: "x",}')).toEqual({ a: [1, 2], b: 'x' });
  });
  it('closes a reply that was cut off', () => {
    const o = looseJson('{"subject": "a clown", "prompt": "bright clown suit", "parts": [{"name": "Hair", "descr');
    expect(o.subject).toBe('a clown');
    expect(o.prompt).toBe('bright clown suit');
  });
  it('ignores braces inside strings', () => {
    expect(looseJson('{"prompt": "use {curly} braces", "x": 2} trailing } text')).toEqual({
      prompt: 'use {curly} braces',
      x: 2,
    });
  });
  it('returns null without an object', () => {
    expect(looseJson('no json here')).toBeNull();
  });
  it('parseSuggestion survives a truncated reply', () => {
    const s = parseSuggestion(
      '```json\n{"subject":"avatar","assetClass":"avatar","prompt":"steampunk outfit","parts":[',
    );
    expect(s.prompt).toBe('steampunk outfit');
    expect(s.assetClass).toBe('avatar');
  });
});

import { parseAreaThemes, reskinPartPrompt } from '../src/muse/prompts.js';

describe('parseAreaThemes', () => {
  it('maps area names case-insensitively and drops unknown ones', () => {
    const m = parseAreaThemes('```json\n{"areas": {"skin (Legs)": "brown tweed trousers", "other": "x"}}\n```', [
      'Skin (legs)',
      'Skin (face)',
    ]);
    expect(m.get('Skin (legs)')).toBe('brown tweed trousers');
    expect(m.has('Skin (face)')).toBe(false);
  });
  it('part prompt uses the area theme and drops the whole-model subject', () => {
    const p = reskinPartPrompt('steampunk boy with goggles', {
      partName: 'legs',
      subject: 'chibi boy',
      areaTheme: 'brown tweed',
    });
    expect(p).toContain('"brown tweed"');
    expect(p).not.toContain('chibi boy');
    expect(p).not.toContain('steampunk boy');
  });
});
