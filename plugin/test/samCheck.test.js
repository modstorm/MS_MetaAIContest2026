import { describe, expect, it } from 'vitest';
import { parseImageStream } from '@meta-sam/parser';
import { toResponsesEvents } from '../src/muse/MuseClient.js';
import { areaCoverage, intrusionNote, samRulesFor, whereText } from '../src/analysis/samCheck.js';

// Sample SAM 3.1 output from the @meta-sam/parser README: a 320x334 image, two objects.
const OUTPUT =
  '<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334|>' +
  "<|mask;x=0;y=0;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>" +
  ',1<|box;x1=155;y1=228;x2=202;y2=254;w=320;h=334|>' +
  '<|mask;x=0;y=0;data=27,48,~!!!!J!0c[q=Pj_zs=*4C4(/./x#:/`S_GnD`=o3?X{emCgO$y@|>\n';

const parse = (raw) => {
  const events = [...toResponsesEvents(raw)];
  return parseImageStream(
    (async function* () {
      yield* events;
    })(),
  ).finalResult;
};

describe('SAM 3.1 responses', () => {
  it('reads a server-sent-event stream split mid-mask', async () => {
    const cut = 90;
    const sse = [
      {
        type: 'response.output_text.delta',
        item_id: 'm',
        output_index: 0,
        content_index: 0,
        delta: OUTPUT.slice(0, cut),
      },
      { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: OUTPUT.slice(cut) },
      { type: 'response.completed' },
    ]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`)
      .join('\n');
    const res = await parse({ text: sse });
    expect(res.records.filter((r) => r.kind === 'mask')).toHaveLength(2);
  });

  it('reads a plain JSON response', async () => {
    const res = await parse({
      text: JSON.stringify({ status: 'completed', output: [{ content: [{ text: OUTPUT }] }] }),
    });
    expect(res.records.filter((r) => r.kind === 'mask')).toHaveLength(2);
  });

  it('treats no match as an empty result', async () => {
    const res = await parse({ text: JSON.stringify({ status: 'completed', output_text: '' }) });
    expect(res.records).toHaveLength(0);
  });

  it('measures how much of the area the masks cover', async () => {
    const res = await parse({ text: JSON.stringify({ output_text: OUTPUT }) });
    const w = 320,
      h = 334;
    const all = new Uint8Array(w * h).fill(1);
    const c = areaCoverage(res, all, w, h);
    expect(c.share).toBeGreaterThan(0);
    expect(c.share).toBeLessThan(0.05);
    expect(c.where).toBe('lower right');
    // Area that misses both boxes: nothing found.
    const top = new Uint8Array(w * h);
    top.fill(1, 0, w * 100);
    expect(areaCoverage(res, top, w, h).share).toBe(0);
  });
});

describe('SAM rules', () => {
  it('comes from the asset class zone and skips what the theme asks for', () => {
    expect(samRulesFor('avatar', 'legs', 'pirate').map((r) => r.concept)).toEqual(['shoe', 'face', 'person']);
    expect(samRulesFor('avatar', 'torso', 'shirt with a skull face print').map((r) => r.concept)).toEqual(['person']);
    expect(samRulesFor('vehicle', 'legs', '')).toEqual([]);
    expect(samRulesFor('avatar', undefined, '')).toEqual([]);
  });

  it('writes a repaint note naming what was found', () => {
    const note = intrusionNote([{ concept: 'shoe', where: 'lower centre' }], 'legs');
    expect(note).toMatch(/a shoe at the lower centre/);
    expect(note).toMatch(/no shoes/);
    expect(whereText(0.1, 0.9)).toBe('lower left');
  });
});
