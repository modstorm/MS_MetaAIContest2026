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
    const concepts = (...args) => samRulesFor(...args).map((r) => r.concept);
    expect(concepts('avatar', 'legs', 'pirate')).toEqual(['shoe', 'face', 'person', 'text', 'logo']);
    expect(concepts('avatar', 'torso', 'shirt with a skull face print')).toEqual(['person', 'text', 'logo']);
    // Every model and area gets the stray text / logo check.
    expect(concepts('vehicle', 'legs', '')).toEqual(['wheel', 'text', 'logo']);
    // Vehicles: no newly painted wheel on any area except the wheels themselves.
    expect(concepts('vehicle', undefined, '', 'Body (center)')).toEqual(['wheel', 'text', 'logo']);
    expect(concepts('vehicle', undefined, '', 'Wheel_FL')).toEqual(['text', 'logo']);
    expect(concepts('vehicle', 'wheels', '')).toEqual(['text', 'logo']);
    expect(concepts('avatar', undefined, '')).toEqual(['text', 'logo']);
    expect(concepts('prop', undefined, 'rusty steampunk copper')).toEqual(['text', 'logo']);
  });

  it('skips the text / logo check when the theme asks for writing or decals', () => {
    const concepts = (theme) => samRulesFor('vehicle', undefined, theme).map((r) => r.concept);
    expect(concepts('race car with sponsor decals')).toEqual(['wheel']);
    expect(concepts('police car with POLICE lettering')).toEqual(['wheel']);
    expect(concepts('graffiti covered subway train')).toEqual(['wheel']);
    expect(concepts('a design with stripes')).toEqual(['wheel', 'text', 'logo']); // "design" is not "sign"
    expect(samRulesFor('avatar', 'legs', 'jersey with a team logo').map((r) => r.concept)).toEqual([
      'shoe',
      'face',
      'person',
    ]);
  });

  it('asks for a repaint without stray lettering or logos', () => {
    const note = intrusionNote([{ concept: 'text', where: 'upper left' }, { concept: 'logo' }], 'door');
    expect(note).toMatch(/added lettering at the upper left of image 1, a logo that nobody asked for/);
    expect(note).toMatch(/no text, letters, numbers, logos or watermarks/);
    expect(note).not.toMatch(/belong to other areas/);
    const both = intrusionNote([{ concept: 'shoe' }, { concept: 'text' }], 'legs');
    expect(both).toMatch(/belong to other areas/);
    expect(both).toMatch(/also added lettering/);
  });

  it('writes a repaint note naming what was found', () => {
    const note = intrusionNote([{ concept: 'shoe', where: 'lower centre' }], 'legs');
    expect(note).toMatch(/a shoe at the lower centre/);
    expect(note).toMatch(/no shoes/);
    expect(whereText(0.1, 0.9)).toBe('lower left');
  });
});
