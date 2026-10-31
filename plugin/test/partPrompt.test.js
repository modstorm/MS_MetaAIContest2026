import { describe, expect, it } from 'vitest';
import { isFacePart, plainReskinPartPrompt, reskinPartPrompt } from '../src/muse/prompts.js';

describe('per-part prompts', () => {
  it('adds the face rules only for head/face parts', () => {
    expect(isFacePart('Head')).toBe(true);
    expect(isFacePart('Pants')).toBe(false);
    const head = reskinPartPrompt('steampunk', { partName: 'Head', others: ['Body'] });
    expect(head).toMatch(/only once, directly over the existing eyes/);
    const pants = reskinPartPrompt('steampunk', { partName: 'Pants', paint: 'brown leather' });
    expect(pants).not.toMatch(/existing eyes/);
    expect(pants).toMatch(/For the Pants: brown leather/);
    expect(pants).toMatch(/edge to edge/);
  });
  it('plain retry names the part but no generated text', () => {
    const p = plainReskinPartPrompt('steampunk', 'Shoes');
    expect(p).toMatch(/Shoes/);
    expect(p).not.toMatch(/mask/);
  });
});
