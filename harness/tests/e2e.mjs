// End-to-end test of the harness + plugin in a real browser (Playwright / Chromium).
// - Starts the Vite dev server for the harness.
// - Offline backend: sample model -> prompt popup -> reskin -> export GLB -> validate.
// - Muse backend: same flow with the Meta Model API mocked, checking request shapes.
// - Drag-and-drop: drops the exported GLB back into the window.
// Run: npm run test:e2e   (needs `playwright` available; screenshots go to harness/test-results/)
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { encodeSegmentationMask } from '../../node_modules/@meta-sam/parser/dist/mask-codec.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const harnessDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../test-results/', import.meta.url));
mkdirSync(outDir, { recursive: true });

process.env.NO_OPEN = '1';
const server = await createServer({
  root: harnessDir,
  configFile: `${harnessDir}/vite.config.js`,
  server: { port: 5199, strictPort: true, open: false },
});
await server.listen();
const url = 'http://localhost:5199/';
const browser = await chromium.launch({
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    // A fake microphone (a beep) for the voice theme test.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});
let failures = 0;

async function step(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY="variations" runs one test
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err?.stack ?? err}`);
  }
}

async function newPage(settings) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
  if (settings)
    await ctx.addInitScript((s) => localStorage.setItem('muse-reskin-settings', JSON.stringify(s)), settings);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('    [pageerror]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('    [console]', m.text()));
  await page.goto(url);
  await page.waitForFunction(() => !!window.reskin);
  return page;
}

/** SAM 3.1 mock reply: no match. */
function samNone() {
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ status: 'completed', output_text: '' }),
  };
}

/** SAM 3.1 mock reply (as an event stream): one object covering the whole image sent. */
function samWhole(dataUrl, confidence = 0.9) {
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  const w = png.readUInt32BE(16),
    h = png.readUInt32BE(20);
  const m = encodeSegmentationMask(new Uint8Array(64).fill(1), 8, 8);
  const text = `<0f>0<|box;x1=0;y1=0;x2=${w - 1};y2=${h - 1};w=${w};h=${h};c=${confidence}|><|mask;x=0;y=0;data=8,8,${m.payload};c=${confidence}|>\n`;
  const lane = { item_id: 'm1', output_index: 0, content_index: 0 };
  const events = [
    { type: 'response.output_text.delta', ...lane, delta: text },
    { type: 'response.output_text.done', ...lane, text },
    { type: 'response.completed' },
  ];
  return {
    status: 200,
    contentType: 'text/event-stream',
    headers: { 'access-control-allow-origin': '*' },
    body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  };
}

/** SAM 3.1 mock reply with one object per rect ([x0, y0, x1, y1] in image pixels). */
function samRects(rects, w, h, confidence = 0.9) {
  const m = encodeSegmentationMask(new Uint8Array(64).fill(1), 8, 8);
  const text =
    '<0f>' +
    rects
      .map(
        ([x1, y1, x2, y2], i) =>
          `${i ? ',' : ''}${i}<|box;x1=${x1};y1=${y1};x2=${x2 - 1};y2=${y2 - 1};w=${w};h=${h};c=${confidence}|><|mask;x=0;y=0;data=8,8,${m.payload};c=${confidence}|>`,
      )
      .join('') +
    '\n';
  const lane = { item_id: 'm1', output_index: 0, content_index: 0 };
  const events = [
    { type: 'response.output_text.delta', ...lane, delta: text },
    { type: 'response.output_text.done', ...lane, text },
    { type: 'response.completed' },
  ];
  return {
    status: 200,
    contentType: 'text/event-stream',
    headers: { 'access-control-allow-origin': '*' },
    body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  };
}

/** Plain Muse mock: '{}' for chat, a 64x64 PNG for image calls; optional hook per request. */
function museOk(route) {
  const isChat = route.request().url().endsWith('/chat/completions');
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(
      isChat ? { choices: [{ message: { content: '{}' } }] } : { data: [{ b64_json: makePng().toString('base64') }] },
    ),
  });
}

// Ids that live in the top-bar menu or on the side panel's Model tab: open those first.
const MENU_IDS = ['btn-open', 'btn-sample', 'btn-export', 'btn-export-textures', 'btn-settings'];
const MODEL_TAB_IDS = ['btn-idmap', 'btn-samzones', 'btn-review'];

/** Clicks a control, opening the menu or the Model tab it sits in first. */
async function ui(page, id) {
  if (MENU_IDS.includes(id)) await page.click('#btn-menu');
  if (MODEL_TAB_IDS.includes(id)) await page.click('#tab-model');
  await page.click(`#${id}`);
}

/** Sets the popup's paint mode select (it sits in the collapsed Options section). */
async function setPaintMode(page, mode) {
  await page.$eval('#opt-paint-mode', (el, m) => (el.value = m), mode);
}

/** Turns the automatic review & fix pass on or off (it adds Muse calls). */
async function setReview(page, on) {
  await page.$eval('#opt-review', (el, v) => (el.checked = v), on);
}

async function reskinViaPopup(page, prompt, { suggest = false, paintMode, review = false, variations = 1 } = {}) {
  await page.waitForSelector('#prompt-dialog[open]');
  await setReview(page, review);
  await page.selectOption('#opt-variations', String(variations));
  if (paintMode) await setPaintMode(page, paintMode);
  await page.$eval('#theme-box', (d) => (d.open = true));
  if (!suggest && (await page.isVisible('#opt-suggest'))) await page.uncheck('#opt-suggest');
  await page.fill('#prompt-text', prompt);
  await page.click('#prompt-go');
  await page.waitForSelector('#prompt-dialog:not([open])', { state: 'attached', timeout: 120_000 });
  await page.waitForSelector('#run-dialog:not([open])', { state: 'attached', timeout: 120_000 });
  // The paint crew popped up over the view while painting and is gone again.
  assert.ok(await page.$eval('#wait-crew', (e) => e.hidden), 'paint crew hidden after the run');
}

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(dv.getUint32(0, true), 0x46546c67, 'GLB magic');
  assert.equal(dv.getUint32(4, true), 2, 'GLB version');
  const jsonLen = dv.getUint32(12, true);
  assert.equal(dv.getUint32(16, true), 0x4e4f534a, 'JSON chunk');
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
}

async function exportAndCheck(page, file) {
  const [download] = await Promise.all([page.waitForEvent('download'), ui(page, 'btn-export')]);
  const path = `${outDir}${file}`;
  await download.saveAs(path);
  const buf = new Uint8Array(await (await import('node:fs/promises')).readFile(path));
  const json = parseGlb(buf);
  const robot = json.materials.find((m) => m.name === 'robot_body');
  assert.ok(robot?.pbrMetallicRoughness?.baseColorTexture, 'base color texture exported');
  // The sample has no normal / roughness maps, so only the base color is regenerated.
  assert.ok(!robot.normalTexture, 'no normal map added');
  assert.ok(!robot.pbrMetallicRoughness.metallicRoughnessTexture, 'no roughness map added');
  assert.ok(json.images.length >= 1, `expected >= 1 image, got ${json.images.length}`);
  return { buf, json, name: download.suggestedFilename() };
}

// A small valid PNG (64x64 gradient) used as the mocked Muse image.
function makePng(w = 64, h = 64, color = null) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const c = color ? color(x, y, w, h) : [200, (x * 4) & 255, (y * 4) & 255];
      raw[o] = c[0];
      raw[o + 1] = c[1];
      raw[o + 2] = c[2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let exported;
try {
  console.log('Offline backend');
  await step('sample model loads, analysis shows, prompt pops up, reskin + export', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    await ui(page, 'btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    const summary = await page.textContent('#layout-summary');
    assert.match(summary, /9 meshes/);
    assert.match(summary, /2 texture slot/);
    await page.screenshot({ path: `${outDir}01-loaded.png` });
    await reskinViaPopup(page, 'molten lava rock with glowing magma veins');
    assert.ok(await page.isVisible('#compare-handle'), 'before/after slider on after painting');
    const kinds = await page.$$eval('#generated figure', (f) => f.map((x) => x.dataset.kind));
    assert.deepEqual(kinds, ['baseColor'], `maps: ${kinds}`); // no normal/roughness in the sample to regenerate
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}02-reskinned-offline.png` });
    exported = await exportAndCheck(page, 'offline.glb');
    // Export textures: PNGs straight from the reskinned materials (a .zip when there are several).
    const [texDl] = await Promise.all([page.waitForEvent('download'), ui(page, 'btn-export-textures')]);
    const texName = texDl.suggestedFilename();
    const texPath = `${outDir}${texName}`;
    await texDl.saveAs(texPath);
    const head = readFileSync(texPath).subarray(0, 4);
    if (texName.endsWith('.zip')) assert.equal(head.readUInt32LE(0), 0x04034b50, 'zip header');
    else assert.ok(texName.endsWith('_baseColor.png') && head.toString('latin1', 1, 4) === 'PNG', texName);
    assert.match(texName, /sample-robot-molten-lava/);
    assert.match(exported.name, /sample-robot-molten-lava/);
    // The before/after slider turned on by itself; export turned it off; it toggles back on.
    await page.click('#btn-compare');
    assert.ok(await page.isVisible('#compare-handle'));
    await page.screenshot({ path: `${outDir}03-original.png` });
    await page.context().close();
  });

  await step('3 variations at once: pick one, history + undo, before/after slider', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    await ui(page, 'btn-sample');
    await reskinViaPopup(page, 'molten lava rock', { variations: 3 }).catch(async (e) => {
      await page.screenshot({ path: `${outDir}08-variations-fail.png` });
      throw e;
    });
    // No picker: every variation goes to History, newest first, with a thumbnail of the original last.
    const h = await page.evaluate(() => window.reskin.plugin.historySummary());
    assert.equal(h.entries.length, 3);
    assert.equal(h.index, 0);
    // Variations differ (different variation notes reach the provider; offline palettes hash the theme only,
    // so compare the stored states instead).
    const mapOf = () => page.$eval('#generated [data-kind="baseColor"] canvas', (c) => c.toDataURL().length);
    const first = await mapOf();
    await page.click('#history button.entry[data-index="1"]');
    assert.notEqual(await mapOf(), first, 'generated maps follow the picked variation');
    assert.equal(await page.evaluate(() => window.reskin.plugin.historyIndex), 1);
    await page.screenshot({ path: `${outDir}08-variations.png` });
    assert.equal(await page.locator('#history button.entry').count(), 4); // original + 3
    assert.equal(await page.locator('#history button.entry[data-index="-1"] canvas').count(), 1, 'original thumbnail');
    assert.equal(await page.getAttribute('#history button.entry:first-child', 'data-index'), '2', 'newest first');
    await page.click('#btn-undo');
    assert.equal(await page.evaluate(() => window.reskin.plugin.historyIndex), 0);
    await page.click('#history button.entry[data-index="-1"]'); // original
    assert.equal(await page.evaluate(() => window.reskin.plugin.historyIndex), -1);
    assert.match(await page.textContent('#generated'), /Original textures/);
    await page.click('#history button.entry[data-index="1"]');
    // The slider came on by itself after painting; switch it off and on again.
    if (await page.isVisible('#compare-handle')) await page.click('#btn-compare');
    await page.click('#btn-compare');
    assert.ok(await page.isVisible('#compare-handle'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}09-compare.png` });
    await page.click('#btn-compare');
    assert.ok(!(await page.isVisible('#compare-handle')));
    // Turntable spins after load and stops when the user drags.
    assert.ok(await page.evaluate(() => window.reskin.viewer.controls.autoRotate));
    // History keeps everything: a new paint after going back still keeps all three variations.
    await page.click('#btn-reskin');
    await reskinViaPopup(page, 'frozen ice crystal');
    assert.equal(await page.locator('#history button.entry').count(), 5); // original + 3 + 1
    assert.equal(await page.getAttribute('#history button.entry.current', 'data-index'), '3');
    await page.context().close();
  });

  console.log('Muse backend (mocked API)');
  await step('direct mode: calls muse-spark-1.3 + muse-image-1.0 with the documented request shapes', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'test-key-not-real', useProxy: false });
    const calls = [];
    const png = makePng().toString('base64');
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      const body = req.postDataJSON();
      calls.push({ url: req.url(), auth: req.headers()['authorization'], body });
      const json = req.url().endsWith('/chat/completions')
        ? {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '```json\n{"subject":"toy robot","regions":[{"name":"face","bbox":[0,0,500,500]}]}\n```',
                },
              },
            ],
            usage: { prompt_tokens: 30000, completion_tokens: 8000, total_tokens: 38000 },
          }
        : { created: 1, data: [{ b64_json: png }], output_format: 'png', background: 'opaque' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(json),
      });
    });
    await ui(page, 'btn-sample');
    await reskinViaPopup(page, 'frozen ice crystal, frost and snow', { paintMode: 'atlas' });
    const chat = calls.find((c) => c.url.endsWith('/chat/completions'));
    const edit = calls.find((c) => c.url.endsWith('/images/edits'));
    assert.ok(chat && edit, `calls: ${calls.map((c) => c.url).join(', ')}`);
    // The small untextured antenna ball is tinted locally: no extra generation call.
    assert.equal(calls.filter((c) => c.url.endsWith('/images/generations')).length, 0);
    assert.equal(chat.body.model, 'muse-spark-1.3');
    assert.equal(chat.body.reasoning_effort, 'minimal'); // fast mode
    assert.equal(chat.body.messages[0].content.filter((p) => p.type === 'image_url').length, 1);
    assert.equal(edit.body.model, 'muse-image-1.0');
    assert.equal(edit.body.images.length, 2);
    assert.match(edit.body.images[0].image_url, /^data:image\/jpeg;base64,/);
    assert.match(edit.body.images[1].image_url, /^data:image\/png;base64,/);
    assert.match(edit.body.prompt, /frozen ice crystal/);
    assert.match(edit.body.prompt, /toy robot/); // vision plan fed into the edit prompt
    assert.equal(edit.body.output_format, 'png');
    assert.equal(edit.body.reasoning_strength, 'low');
    assert.deepEqual(edit.body.tool_enablement, {
      enable_image_search: false,
      enable_web_search: false,
      enable_shell: false,
    });
    for (const c of calls) assert.equal(c.auth, 'Bearer test-key-not-real');
    const log = await page.textContent('#log');
    assert.match(log, /⏱ paint atlas \(robot_atlas\)/);
    assert.match(log, /⏱ read layout \(robot_atlas\)/);
    // Cost badge: 1 image ($0.01) + 30k in / 8k out Spark tokens ($0.0375 + $0.034).
    assert.equal(await page.textContent('#cost-reskin'), '1 image + 38k tokens ≈ $0.08');
    assert.match(log, /This reskin so far: 1 image \+ 38k tokens/);

    // Second prompt on the same model: layout reading is cached, so only the paint call is made.
    const before = calls.length;
    await page.click('#btn-reskin');
    await reskinViaPopup(page, 'mossy ancient stone ruin', { paintMode: 'atlas' });
    const second = calls.slice(before).map((c) => c.url.split('/v1/')[1]);
    assert.deepEqual(second, ['images/edits']);
    // A new prompt starts its own tally; the session total keeps both.
    assert.equal(await page.textContent('#cost-reskin'), '1 image ≈ $0.01');
    assert.equal(await page.textContent('#cost-session'), 'Session $0.09');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}04-reskinned-muse-mock.png` });
    await exportAndCheck(page, 'muse-mock.glb');
    await page.context().close();
  });

  await step('suggestion mode: six views -> Muse recommendation shown -> edited prompt is painted', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const calls = [];
    const png = makePng().toString('base64');
    const suggestion = {
      subject: 'cartoon toy robot on a round base',
      parts: [
        { name: 'head', description: 'boxy grey head with cyan eyes' },
        { name: 'limbs', description: 'striped capsules' },
      ],
      prompt: 'Frosted glacier robot: icy blue head with glowing white eyes, cracked ice torso plates.',
      atlases: [
        {
          index: 1,
          regions: [{ name: 'face', bbox: [0, 0, 500, 500], paint: 'frosted ice face plate with glowing eyes' }],
        },
      ],
      tips: 'Keep the eyes bright so they read from far away.',
    };
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      const body = req.postDataJSON();
      calls.push({ url: req.url(), body });
      const json = req.url().endsWith('/chat/completions')
        ? { choices: [{ message: { content: JSON.stringify(suggestion) } }] }
        : { data: [{ b64_json: png }] };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(json),
      });
    });
    await ui(page, 'btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    assert.equal(await page.textContent('#prompt-go'), 'Get Muse suggestion');
    await setPaintMode(page, 'atlas');
    await setReview(page, false);
    await page.selectOption('#opt-variations', '1');
    await page.fill('#prompt-text', 'ice');
    await page.click('#prompt-go');
    await page.waitForSelector('#suggestion:not([hidden])');
    assert.ok(await page.isVisible('#prompt-dialog[open]'), 'the same popup expands with the suggestion');
    // Nothing painted yet: only the art-director call was made, with the 6-view sheet + 1 atlas.
    assert.deepEqual(
      calls.map((c) => c.url.split('/v1/')[1]),
      ['chat/completions'],
    );
    const content = calls[0].body.messages[0].content;
    assert.equal(content.filter((p) => p.type === 'image_url').length, 3); // views, ID-map views, atlas
    assert.match(content[0].text, /same views with every texture area in its own flat color/);
    assert.match(content[0].text, /six orthographic renders/);
    assert.match(content[0].text, /"ice"/);
    assert.equal(await page.textContent('#sugg-subject'), suggestion.subject);
    assert.equal(await page.inputValue('#sugg-prompt'), suggestion.prompt);
    assert.equal(await page.textContent('#prompt-go'), 'Paint');
    const sheet = await page.$eval('#sugg-sheet canvas', (c) => [c.width, c.height]);
    assert.ok(sheet[0] > sheet[1], 'contact sheet is 3x2');
    await page.screenshot({ path: `${outDir}05-muse-suggestion.png` });

    await page.fill('#sugg-prompt', suggestion.prompt + ' Add tiny snowflakes.');
    await page.click('#prompt-go');
    assert.ok(!(await page.isVisible('#prompt-dialog')), 'popup closes as soon as painting starts');
    await page.waitForSelector('#run-dialog:not([open])', { state: 'attached', timeout: 120_000 });
    const urls = calls.map((c) => c.url.split('/v1/')[1]);
    assert.deepEqual(urls, ['chat/completions', 'images/edits']); // region plan reused, no extra layout reading
    const edit = calls[1].body;
    assert.match(edit.prompt, /Add tiny snowflakes/);
    assert.match(edit.prompt, /frosted ice face plate/);
    assert.match(edit.prompt, /cartoon toy robot/);
    // Reskin again reopens the same suggestion with the last prompt: no new Muse call.
    const n1 = calls.length;
    await page.click('#btn-reskin');
    await page.waitForSelector('#prompt-dialog[open]');
    assert.match(await page.inputValue('#sugg-prompt'), /Add tiny snowflakes/);
    assert.equal(await page.textContent('#sugg-subject'), suggestion.subject);
    assert.equal(await page.textContent('#prompt-go'), 'Paint');
    assert.equal(calls.length, n1, 'no Muse call to reopen the suggestion');
    // The theme part is folded away while Muse's prompt is current; opening it lets you change the theme.
    assert.ok(!(await page.isVisible('#prompt-text')), 'theme folded after the suggestion');
    assert.match(await page.textContent('#theme-summary'), /"ice"/);
    await page.click('#theme-box > summary');
    // A new theme in the same popup: Muse only rewrites the prompt (one text call, no renders).
    await page.fill('#prompt-text', 'lava');
    assert.equal(await page.textContent('#prompt-go'), "Update Muse's prompt");
    await page.click('#prompt-go');
    await page.waitForFunction(() => document.querySelector('#prompt-go').textContent === 'Paint');
    assert.equal(calls.length, n1 + 1, 'one Muse call for the new theme');
    assert.equal(calls[n1].body.messages[0].content.filter((p) => p.type === 'image_url').length, 0, 'no images');
    assert.match(calls[n1].body.messages[0].content[0].text, /already studied/);
    assert.ok(await page.isVisible('#prompt-dialog[open]'));
    await page.click('#prompt-cancel');
    // A new theme on the same model reuses what Muse saw: one text-only call, no renders.
    const n0 = calls.length;
    const again = await page.evaluate(async () => {
      const s = await window.reskin.plugin.postSuggest('mossy stone');
      return { subject: s.subject, regions: Object.values(s.plans).map((p) => p.regions.length) };
    });
    assert.equal(calls.length, n0 + 1);
    const reuseBody = calls[n0].body.messages[0].content;
    assert.equal(reuseBody.filter((p) => p.type === 'image_url').length, 0, 'no images on reuse');
    assert.match(reuseBody[0].text, /already studied/);
    assert.match(reuseBody[0].text, /"mossy stone"/);
    assert.equal(again.subject, suggestion.subject);
    await page.context().close();
  });

  await step('voice theme: mic records, Muse Voice Transcribe fills the theme, Muse reviews it', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    await page.context().grantPermissions(['microphone']);
    const calls = [];
    const suggestion = {
      subject: 'toy robot',
      parts: [],
      prompt: 'Rusty pirate robot with brass rivets.',
      atlases: [],
    };
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      const path = req.url().split('/v1/')[1];
      if (path === 'asr/transcribe') {
        const raw = req.postDataBuffer().toString('latin1');
        calls.push({ path, contentType: req.headers()['content-type'], auth: req.headers().authorization, raw });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            sessionId: 's1',
            transcript: 'make it a rusty pirate robot',
            audioDurationMs: 1800,
            turns: [],
          }),
        });
      }
      calls.push({ path });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(suggestion) } }] }),
      });
    });
    await ui(page, 'btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    assert.ok(await page.isVisible('#mic-btn'), 'mic shows next to the theme');
    await page.click('#mic-btn');
    await page.waitForSelector('#mic-btn.recording');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}05b-voice-recording.png` });
    await page.click('#mic-btn');
    await page.waitForSelector('#suggestion:not([hidden])', { timeout: 30_000 });
    assert.equal(await page.inputValue('#prompt-text'), 'make it a rusty pirate robot');
    assert.deepEqual(
      calls.map((c) => c.path),
      ['asr/transcribe', 'chat/completions'],
      'transcribe, then the usual Muse review (no painting)',
    );
    const t = calls[0];
    assert.match(t.contentType, /^multipart\/form-data; boundary=/);
    assert.equal(t.auth, 'Bearer k');
    assert.match(t.raw, /"model":"muse-voice-transcribe-1.0"/);
    assert.match(t.raw, /"audioEncoding":"WAV"/);
    // The audio part is a 16 kHz mono 16-bit WAV.
    const wav = Buffer.from(t.raw.slice(t.raw.indexOf('RIFF')), 'latin1');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.match(await page.textContent('#prompt-go'), /Paint/);
    await page.screenshot({ path: `${outDir}05c-voice-reviewed.png` });
    const usage = await page.evaluate(() => window.reskin.plugin.getUsage().session.audioSeconds);
    assert.equal(usage, 1);
    await page.context().close();
  });

  await step('shows the Muse error message when the API rejects a request', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'bad', useProxy: false });
    await page.route('https://api.meta.ai/v1/**', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key' } }),
      }),
    );
    await ui(page, 'btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    await page.fill('#prompt-text', 'gold armor');
    await page.click('#prompt-go');
    // Muse's review fails inside the popup: the message shows there and the popup stays open.
    await page.waitForFunction(
      () => /Invalid API key/.test(document.querySelector('#sugg-status')?.textContent ?? ''),
      null,
      { timeout: 30_000 },
    );
    assert.ok(await page.isVisible('#prompt-dialog[open]'));
    assert.equal(await page.textContent('#prompt-go'), 'Get Muse suggestion');
    await page.context().close();
  });

  await step('retries without the speed options if Muse rejects them', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const png = makePng().toString('base64');
    const bodies = [];
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      const body = req.postDataJSON();
      if (req.url().endsWith('/chat/completions')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
        });
      }
      bodies.push(body);
      const reject = 'tool_enablement' in body;
      await route.fulfill({
        status: reject ? 400 : 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(
          reject
            ? {
                error: {
                  type: 'invalid_request_error',
                  param: 'tool_enablement',
                  message: 'Unknown parameter: tool_enablement',
                },
              }
            : { data: [{ b64_json: png }] },
        ),
      });
    });
    await ui(page, 'btn-sample');
    await reskinViaPopup(page, 'gold armor', { suggest: false, paintMode: 'atlas' });
    assert.equal(bodies.length, 2);
    assert.ok('tool_enablement' in bodies[0] && !('tool_enablement' in bodies[1]));
    await page.context().close();
  });

  await step('safety filter: plain retry with a softened theme, then a clear error with Retry', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const png = makePng().toString('base64');
    const edits = [];
    let alwaysReject = false;
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      const body = req.postDataJSON();
      const ok = (json) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(json),
        });
      if (req.url().endsWith('/chat/completions'))
        return ok({ choices: [{ message: { content: '{"subject":"robot","regions":[]}' } }] });
      edits.push(body);
      if (alwaysReject || edits.length === 1) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'content_policy_violation',
              message: 'The response was filtered due to the prompt triggering our content management policy.',
            },
          }),
        });
      }
      return ok({ data: [{ b64_json: png }] });
    });
    await ui(page, 'btn-sample');
    await reskinViaPopup(page, 'scary clown', { paintMode: 'atlas' });
    assert.equal(edits.length, 2);
    assert.match(
      edits[1].prompt,
      /^Recolor this game texture image in a "spooky clown, playful Halloween style" style/,
    );
    assert.equal(edits[1].images.length, 1);
    assert.match(await page.textContent('#log'), /safety filter rejected/);

    // Now the filter rejects everything: the popup shows the error with Retry.
    alwaysReject = true;
    await page.click('#btn-reskin');
    await page.waitForSelector('#prompt-dialog[open]');
    await page.uncheck('#opt-suggest');
    await page.fill('#prompt-text', 'scary clown');
    await page.click('#prompt-go');
    await page.waitForSelector('#prompt-error:not([hidden])', { timeout: 30_000 });
    assert.match(await page.textContent('#err-title'), /safety filter/);
    assert.match(await page.textContent('#err-text'), /step: paint atlas/);
    await page.screenshot({ path: `${outDir}06-filter-error.png` });
    const before = edits.length;
    await page.click('#err-retry');
    await page.waitForFunction((n) => window.__x !== n, before); // let the click start
    await page.waitForSelector('#prompt-error:not([hidden])', { timeout: 30_000 });
    assert.ok(edits.length > before, 'retry sent new requests');
    await page.context().close();
  });

  await step(
    'car: same-named materials, stacked wheels painted once, a failed texture is shown and retried',
    async () => {
      const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
      let failWheels = true;
      const edits = [];
      await page.route('https://api.meta.ai/v1/**', (route) => {
        const isChat = route.request().url().endsWith('/chat/completions');
        const body = route.request().postDataJSON();
        if (!isChat) edits.push(body.prompt);
        if (!isChat && failWheels && /^- tire, bbox/m.test(body.prompt))
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            headers: { 'access-control-allow-origin': '*' },
            body: JSON.stringify({ error: { message: 'mock wheel failure' } }),
          });
        const png = makePng(64, 64, () => [220, 40, 40]).toString('base64');
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(isChat ? { choices: [{ message: { content: '{}' } }] } : { data: [{ b64_json: png }] }),
        });
      });
      const bytes = await page.evaluate(async () => {
        const mod = await import('/src/sampleModel.js');
        return Array.from(new Uint8Array(await mod.buildCarTestGlb()));
      });
      await page.setInputFiles('#file-input', {
        name: 'car.glb',
        mimeType: 'model/gltf-binary',
        buffer: Buffer.from(bytes),
      });
      await page.waitForSelector('#prompt-dialog[open]');
      const layout = await page.evaluate(() => {
        const p = window.reskin.plugin;
        return p.layout.slots.map((s) => ({ id: s.id, name: s.name, areas: p.idRegions(s).map((r) => r.name) }));
      });
      // Both materials are "lambert1": the slots are told apart by their first mesh.
      assert.deepEqual(
        layout.map((s) => s.name),
        ['lambert1 · carBody', 'lambert1 · tireBackR'],
      );
      // Four wheels stacked on the same UVs are one area, painted once.
      assert.deepEqual(layout[1].areas, ['tire']);
      await reskinViaPopup(page, 'pepperoni pizza', { variations: 1 });
      // One paint per texture (the failing wheel call is retried by the client on a 500).
      assert.equal(edits.filter((e) => !/^- tire, bbox/m.test(e)).length, 1);
      assert.equal(new Set(edits.filter((e) => /^- tire, bbox/m.test(e))).size, 1);
      const failedCard = await page.$('#generated .slot.failed');
      assert.ok(failedCard, 'failed wheel texture has a card');
      assert.match(await failedCard.textContent(), /lambert1 · tireBackR.*not painted.*mock wheel failure/s);
      assert.match(await page.textContent('#log'), /Not painted: "lambert1 · tireBackR"/);
      const wheelMap = () =>
        page.evaluate(() => {
          const s = window.reskin.plugin.layout.slots[1];
          return s.materials[0].map === s.texture;
        });
      assert.ok(await wheelMap(), 'wheels keep their original texture');
      // Retry only the wheels: they get painted, the body keeps its paint.
      const bodyBefore = await page.evaluate(() => window.reskin.plugin.layout.slots[0].materials[0].map.uuid);
      failWheels = false;
      await failedCard.$eval('button', (b) => b.click());
      await page.waitForFunction(
        () => !window.reskin.plugin.busy && !document.querySelector('#generated .slot.failed'),
        null,
        {
          timeout: 60_000,
        },
      );
      assert.equal(await wheelMap(), false, 'wheels repainted');
      assert.equal(
        await page.evaluate(() => window.reskin.plugin.layout.slots[0].materials[0].map.uuid),
        bodyBefore,
        'body paint kept on retry',
      );
      const kinds = await page.$$eval('#generated .slot', (g) => g.map((x) => x.dataset.slot));
      assert.deepEqual(kinds.sort(), ['slot0', 'slot1']);
      await page.context().close();
    },
  );

  console.log('UV orientation');
  await step('an upside-down head island is painted upright and turned back (whole-atlas mode)', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Muse mock returns: top half red, bottom half blue.
    const png = makePng(64, 64, (x, y, w, h) => (y < h / 2 ? [255, 0, 0] : [0, 0, 255])).toString('base64');
    const edits = [];
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      const body = req.postDataJSON();
      const ok = (json) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(json),
        });
      if (req.url().endsWith('/chat/completions'))
        return ok({ choices: [{ message: { content: '{"subject":"doll","regions":[]}' } }] });
      edits.push(body);
      return ok({ data: [{ b64_json: png }] });
    });
    // Build a model in the page: "Head" plane stored upside down in the atlas (top half),
    // "Body" plane stored upright (bottom half), sharing one texture.
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildOrientationTestGlb()));
    });
    await page.evaluate(async (bytes) => {
      await window.reskin.plugin.postModel(new Uint8Array(bytes).buffer, { name: 'orient-test' });
    }, glb);
    const prev = await page.evaluate(() => {
      const p = window.reskin.plugin;
      const s = p.layout.slots.find((x) => x.texture);
      const v = p.slotPreview(s.id, 128);
      return { orientation: v.orientation, parts: v.parts };
    });
    assert.deepEqual(prev.orientation, { rot: 180, flipX: true, reason: 'Head' }, JSON.stringify(prev)); // vertical mirror
    const result = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const r = await p.postPrompt('happy clown', {
        useVisionPlanning: false,
        paintMode: 'atlas',
        normalMaps: false,
        roughnessMaps: false,
      });
      const c = r.slots[0].canvas;
      const g = c.getContext('2d');
      return {
        top: Array.from(g.getImageData(c.width / 2, 2, 1, 1).data),
        bottom: Array.from(g.getImageData(c.width / 2, c.height - 3, 1, 1).data),
      };
    });
    // Muse's red-top image was turned 180° back: blue is now at the top of the atlas.
    assert.ok(result.top[2] > 200 && result.top[0] < 60, `top ${result.top}`);
    assert.ok(result.bottom[0] > 200 && result.bottom[2] < 60, `bottom ${result.bottom}`);
    assert.equal(edits.length, 1);
    assert.match(edits[0].prompt, /Head = \w+ area/);
    assert.match(edits[0].prompt, /Body = \w+ area/);
    assert.match(await page.textContent('#log'), /"Head" is stored rotated 180° and mirrored/);
    await page.context().close();
  });

  await step('an upside-down head island is painted upright on its own in part-by-part mode', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Muse mock returns: top half red, bottom half blue.
    const png = makePng(64, 64, (x, y, w, h) => (y < h / 2 ? [255, 0, 0] : [0, 0, 255])).toString('base64');
    const edits = [];
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      if (req.url().endsWith('/responses')) return route.fulfill(samNone()); // SAM 3.1: nothing stray
      const body = req.postDataJSON();
      const ok = (json) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(json),
        });
      if (req.url().endsWith('/chat/completions'))
        return ok({ choices: [{ message: { content: '{"subject":"doll","regions":[]}' } }] });
      edits.push(body);
      return ok({ data: [{ b64_json: png }] });
    });
    // Build a model in the page: "Head" plane stored upside down in the atlas (top half),
    // "Body" plane stored upright (bottom half), sharing one texture.
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildOrientationTestGlb()));
    });
    await page.evaluate(async (bytes) => {
      await window.reskin.plugin.postModel(new Uint8Array(bytes).buffer, { name: 'orient-test' });
    }, glb);
    const prev = await page.evaluate(() => {
      const p = window.reskin.plugin;
      const s = p.layout.slots.find((x) => x.texture);
      const v = p.slotPreview(s.id, 128);
      return { orientation: v.orientation, parts: v.parts };
    });
    assert.deepEqual(prev.orientation, { rot: 180, flipX: true, reason: 'Head' }, JSON.stringify(prev)); // vertical mirror
    const result = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const r = await p.postPrompt('happy clown', {
        useVisionPlanning: false,
        normalMaps: false,
        roughnessMaps: false,
      });
      const c = r.slots[0].canvas;
      const g = c.getContext('2d');
      return {
        top: Array.from(g.getImageData(c.width / 2, 2, 1, 1).data),
        bottom: Array.from(g.getImageData(c.width / 2, c.height - 3, 1, 1).data),
      };
    });
    // Each part got Muse's red-top image painted upright. The head was turned back
    // (blue at the top of the atlas); the upright body keeps blue at its bottom.
    assert.ok(result.top[2] > 200 && result.top[0] < 60, `top ${result.top}`);
    assert.ok(result.bottom[2] > 200 && result.bottom[0] < 60, `bottom ${result.bottom}`);
    assert.equal(edits.length, 2);
    const head = edits.find((e) => /"Head" area/.test(e.prompt));
    const body = edits.find((e) => /"Body" area/.test(e.prompt));
    assert.ok(head && body, edits.map((e) => e.prompt.slice(0, 60)).join(' | '));
    assert.match(head.prompt, /directly over the existing eyes/);
    assert.doesNotMatch(body.prompt, /existing eyes/);
    assert.equal(head.images.length, 2);
    assert.match(head.size, /^1792x1024$/); // half-height crop padded to the closest wide size
    assert.match(await page.textContent('#log'), /Head is stored rotated or mirrored/);
    await page.context().close();
  });

  await step('ID map: flat color per area on the model, restored afterwards, never exported', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    await ui(page, 'btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    await page.click('#prompt-cancel');
    const r = await page.evaluate(() => {
      const p = window.reskin.plugin;
      const mats = () => {
        const out = [];
        p.model.scene.traverse((o) => o.isMesh && out.push(o.material.type));
        return out;
      };
      const before = mats();
      p.showIdMap(true);
      const during = mats();
      p.showIdMap(false);
      return { before, during, after: mats() };
    });
    assert.ok(
      r.during.every((t) => t === 'MeshBasicMaterial'),
      r.during.join(),
    );
    assert.deepEqual(r.after, r.before);
    await ui(page, 'btn-idmap');
    assert.ok(await page.evaluate(() => window.reskin.plugin.idMapVisible));
    await page.screenshot({ path: `${outDir}07-id-map.png` });
    // Right-click a layout image: menu offers a named save.
    await page.click('#slots canvas[data-save-name]', { button: 'right' });
    assert.match(await page.textContent('#img-save'), /Save ".+\+atlas\.png"/);
    await page.context().close();
  });

  await step('avatar body zones: face, hair and hands get their own areas', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb()));
    });
    const names = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-test' });
      const slot = p.layout.slots.find((s) => s.texture);
      return { cls: p.resolveAssetClass({}), areas: p.idRegions(slot).map((r) => r.name) };
    }, glb);
    assert.equal(names.cls, 'avatar');
    for (const n of ['Body (face)', 'Body (hair)', 'Body', 'Arms (hands)', 'Arms', 'Legs'])
      assert.ok(names.areas.includes(n), `missing ${n}: ${names.areas.join(', ')}`);
    // Mirrored shoes stacked in one UV rect are filled (opposite windings must not cancel).
    const shoe = await page.evaluate(() => {
      const p = window.reskin.plugin;
      const t = [...p.idMapTextures(256).values()][0];
      return Array.from(
        t.canvas.getContext('2d').getImageData(Math.round(0.175 * 256), Math.round(0.875 * 256), 1, 1).data,
      );
    });
    assert.ok(shoe[0] + shoe[1] + shoe[2] > 60, `shoe area filled, got ${shoe}`);

    // One mesh holding the whole body (like Kris's avatar): 7 zones, each its own color.
    const glb2 = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true })));
    });
    const one = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-one-mesh' });
      const slot = p.layout.slots.find((s) => s.texture);
      return p.idRegions(slot).map((r) => [r.name, r.color]);
    }, glb2);
    const oneNames = one.map((r) => r[0]);
    for (const n of [
      'Body (face)',
      'Body (hair)',
      'Body (hands)',
      'Body (torso)',
      'Body (arms)',
      'Body (legs)',
      'Shoes',
    ])
      assert.ok(oneNames.includes(n), `missing ${n}: ${oneNames.join(', ')}`);
    assert.equal(one.length, 7);
    assert.equal(new Set(one.map((r) => r[1])).size, 7, 'each zone has its own color');
    const colorOf = Object.fromEntries(one);
    assert.deepEqual(
      [
        colorOf['Body (face)'],
        colorOf['Body (hair)'],
        colorOf['Body (legs)'],
        colorOf['Body (torso)'],
        colorOf['Body (hands)'],
        colorOf['Shoes'],
        colorOf['Body (arms)'],
      ],
      ['red', 'blue', 'green', 'yellow', 'purple', 'aqua', 'pink'],
    );
    // Legs pressed together: the trousers are still their own (green) zone, not torso.
    const glb3 = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, touchingLegs: true })));
    });
    const touching = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-touching' });
      const slot = p.layout.slots.find((s) => s.texture);
      return Object.fromEntries(p.idRegions(slot).map((r) => [r.name, r.share]));
    }, glb3);
    assert.ok(touching['Body (legs)'] > 0.25, `legs zone: ${JSON.stringify(touching)}`);
    // Low-poly torso (3 vertex columns across): the gaps between its vertices are not the
    // torso/arm gap, so the torso keeps its sides and the legs never become arms or hands.
    const glb4 = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, torsoColumns: 3 })));
    });
    const lowPoly = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-lowpoly' });
      const slot = p.layout.slots.find((s) => s.texture);
      return Object.fromEntries(p.idRegions(slot).map((r) => [r.name, r.share]));
    }, glb4);
    assert.deepEqual(Object.keys(lowPoly).sort(), oneNames.slice().sort(), JSON.stringify(lowPoly));
    assert.ok(lowPoly['Body (legs)'] > lowPoly['Body (arms)'], `legs vs arms: ${JSON.stringify(lowPoly)}`);
    assert.ok(lowPoly['Body (torso)'] > 0.15, `torso keeps its sides: ${JSON.stringify(lowPoly)}`);
    // Hands that are their own UV islands are hands as a whole (palm and back too, not just the fingertips).
    const glb5 = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, separateHands: true })));
    });
    const hands = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-hands' });
      const slot = p.layout.slots.find((s) => s.texture);
      const r = p.idRegions(slot);
      const share = Object.fromEntries(r.map((x) => [x.name, x.share]));
      return { share, ratio: share['Body (hands)'] / (share['Body (hands)'] + share['Body (arms)']) };
    }, glb5);
    // Hand boxes are 0.35 of the 0.65 arm length (~53% of the arm area).
    assert.ok(hands.ratio > 0.5, `whole hands: ${JSON.stringify(hands)}`);
    // Area map: names sit in a border, each with lines to points inside its own patches.
    const imageUtils = '/@fs' + fileURLToPath(new URL('../../plugin/src/texture/imageUtils.js', import.meta.url));
    const callouts = await page.evaluate(
      async ([bytes, modPath]) => {
        const p = window.reskin.plugin;
        await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-one-mesh' });
        const slot = p.layout.slots.find((s) => s.texture);
        const prev = p.slotPreview(slot.id, 512);
        const { partLayer, zoneAnchors } = await import(modPath);
        const misses = [];
        for (const r of p.idRegions(slot)) {
          const layer = partLayer(slot, r, 512, 512);
          const d = layer.getContext('2d').getImageData(0, 0, 512, 512).data;
          for (const a of zoneAnchors(layer)) {
            if (d[(Math.floor(a.y) * 512 + Math.floor(a.x)) * 4 + 3] < 128) misses.push(r.name);
          }
        }
        return { w: prev.partMap.width, atlasW: prev.atlas.width, misses, png: prev.partMap.toDataURL() };
      },
      [glb2, imageUtils],
    );
    assert.ok(callouts.w > callouts.atlasW * 1.3, `border added: ${callouts.w} vs ${callouts.atlasW}`);
    assert.deepEqual(callouts.misses, [], 'every anchor is inside its own area');
    if (process.env.SAVE_SHOTS) writeFileSync('/tmp/partmap.png', Buffer.from(callouts.png.split(',')[1], 'base64'));
    await page.context().close();
  });

  await step('avatar: skin leftovers in clothing are filled; locked zones keep their paint', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Mock paint: dark blue (then red) with thin skin-colored (#c99) vertical stripes.
    let fill = [20, 30, 120];
    const edits = [];
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const isChat = route.request().url().endsWith('/chat/completions');
      if (route.request().url().endsWith('/responses')) return route.fulfill(samNone());
      if (!isChat) edits.push(route.request().postDataJSON());
      const png = makePng(64, 64, (x) => (x % 16 < 2 ? [204, 153, 153] : fill)).toString('base64');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(isChat ? { choices: [{ message: { content: '{}' } }] } : { data: [{ b64_json: png }] }),
      });
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true })));
    });
    // Counts skin-colored and fill-colored pixels inside a UV rect of the last painted atlas.
    const probe = (rect) =>
      page.evaluate((r) => {
        const p = window.reskin.plugin;
        const slot = p.layout.slots.find((s) => s.texture && s.name !== 'Shoes' && !/shoe/i.test(s.name));
        const out = p.lastPartJobs.get(slot.id).out;
        const [x0, y0, x1, y1] = r.map((v, i) => Math.round(v * (i % 2 ? out.height : out.width)));
        const d = out.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let skin = 0,
          blue = 0,
          red = 0;
        for (let i = 0; i < d.length; i += 4) {
          const near = (c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]) < 40;
          if (near([204, 153, 153])) skin++;
          if (d[i + 2] > 90 && d[i] < 70) blue++;
          if (d[i] > 150 && d[i + 1] < 80 && d[i + 2] < 80) red++;
        }
        return { skin, blue, red, n: d.length / 4 };
      }, rect);
    await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-skin' });
      await p.postPrompt('cyberpunk', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
      });
    }, glb);
    const legsRect = [0.52, 0.42, 0.68, 0.68];
    const torsoRect = [0.04, 0.04, 0.28, 0.28];
    const legs1 = await probe(legsRect);
    assert.equal(legs1.skin, 0, `legs still show skin: ${JSON.stringify(legs1)}`);
    assert.ok(legs1.blue > legs1.n * 0.9, `legs painted: ${JSON.stringify(legs1)}`);
    // Zones list in the side panel's Model tab; lock the legs there and repaint in red.
    await page.click('#tab-model');
    await page.waitForSelector('#zones .zone[data-name="Body (legs)"]');
    assert.equal(await page.locator('#zones .zone').count(), 7);
    await page.click('#zones .zone[data-name="Body (legs)"] .zone-lock');
    assert.deepEqual(await page.evaluate(() => [...window.reskin.plugin.locked]), ['Body (legs)']);
    assert.match(await page.textContent('#zones-note'), /1 locked/);
    fill = [200, 20, 20];
    const before = edits.length;
    await page.evaluate(() =>
      window.reskin.plugin.postPrompt('lava', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
      }),
    );
    assert.equal(edits.length - before, 6, 'the locked zone is not sent to Muse');
    assert.ok(!edits.slice(before).some((e) => /"Body \(legs\)" area/.test(e.prompt)));
    const legs2 = await probe(legsRect);
    const torso2 = await probe(torsoRect);
    assert.ok(legs2.blue > legs2.n * 0.9 && legs2.red === 0, `locked legs kept: ${JSON.stringify(legs2)}`);
    assert.ok(torso2.red > torso2.n * 0.9, `torso repainted: ${JSON.stringify(torso2)}`);
    await page.context().close();
  });

  await step('hair made of strands is shaded strand by strand (root dark, tip light, no decals)', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Mock paint: orange with yellow "gear" blobs across everything.
    const png = makePng(64, 64, (x, y) => ((x >> 3) % 2 && (y >> 3) % 2 ? [250, 220, 40] : [190, 90, 40])).toString(
      'base64',
    );
    await page.route('https://api.meta.ai/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(
          route.request().url().endsWith('/chat/completions')
            ? { choices: [{ message: { content: '{}' } }] }
            : { data: [{ b64_json: png }] },
        ),
      }),
    );
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, hairStrands: 8 })));
    });
    const res = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      const warnings = [];
      p.on('warning', (e) => warnings.push(e.message));
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-hair' });
      await p.postPrompt('steampunk', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
      });
      const slot = p.layout.slots.find((s) => s.texture);
      const out = p.lastPartJobs.get(slot.id).out;
      const g = out.getContext('2d');
      const px = (u, v) => Array.from(g.getImageData(Math.floor(u * out.width), Math.floor(v * out.height), 1, 1).data);
      // First card: UV rect [0.75, 0.22, 0.80, 0.30]; root at the bottom of the rect.
      const cards = [0, 1, 2, 3].map((col) => ({
        root: px(0.775 + col * 0.06, 0.285),
        tip: px(0.775 + col * 0.06, 0.235),
      }));
      const crop = document.createElement('canvas');
      crop.width = crop.height = 256;
      crop
        .getContext('2d')
        .drawImage(out, 0.74 * out.width, 0.2 * out.height, 0.26 * out.width, 0.2 * out.height, 0, 0, 256, 256);
      return { cards, warnings, names: p.idRegions(slot).map((r) => r.name), png: crop.toDataURL() };
    }, glb);
    assert.ok(res.names.includes('Hair'), res.names.join(', '));
    if (process.env.SAVE_SHOTS) writeFileSync('/tmp/hair.png', Buffer.from(res.png.split(',')[1], 'base64'));
    assert.ok(
      res.warnings.some((w) => /shaded 8 hair strands/.test(w)),
      res.warnings.join(' | '),
    );
    // Cards that all share one UV island are still told apart (as separate 3D pieces).
    const glbShared = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(
        new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, hairStrands: 8, hairSharedUv: true })),
      );
    });
    const shared = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      const warnings = [];
      p.on('warning', (e) => warnings.push(e.message));
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-hair-shared' });
      await p.postPrompt('steampunk', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
      });
      return warnings;
    }, glbShared);
    assert.ok(
      shared.some((w) => /shaded 8 hair strands/.test(w)),
      shared.join(' | '),
    );
    const lum = (c) => c[0] + c[1] + c[2];
    for (const c of res.cards) {
      assert.ok(lum(c.root) < lum(c.tip) * 0.85, `root darker than tip: ${JSON.stringify(c)}`);
      for (const p of [c.root, c.tip]) assert.ok(!(p[0] > 220 && p[1] > 190), `no yellow decal: ${p}`);
    }
    await page.context().close();
  });

  await step('skin swatches keep their color unless the face skin changes', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    let faceColor = [204, 153, 153]; // the face keeps its skin…
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const isChat = route.request().url().endsWith('/chat/completions');
      const face = !isChat && /"Body \(face\)" area/.test(route.request().postDataJSON().prompt);
      const png = makePng(32, 32, () => (face ? faceColor : [240, 210, 30])).toString('base64'); // …the rest goes yellow
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(isChat ? { choices: [{ message: { content: '{}' } }] } : { data: [{ b64_json: png }] }),
      });
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, skinSwatch: true })));
    });
    const run = (theme) =>
      page.evaluate(async (theme) => {
        const p = window.reskin.plugin;
        const warnings = [];
        p.on('warning', (e) => warnings.push(e.message));
        await p.postPrompt(theme, { useVisionPlanning: false, variants: 1, normalMaps: false, roughnessMaps: false });
        const slot = p.layout.slots.find((s) => s.texture);
        const img = slot.materials[0].map.image;
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        return { swatch: Array.from(g.getImageData(0.345 * c.width, 0.115 * c.height, 1, 1).data), warnings };
      }, theme);
    await page.evaluate(async (bytes) => {
      await window.reskin.plugin.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-swatch' });
    }, glb);
    const a = await run('steampunk');
    const near = (p, c) => Math.abs(p[0] - c[0]) + Math.abs(p[1] - c[1]) + Math.abs(p[2] - c[2]) < 40;
    assert.ok(near(a.swatch, [204, 153, 153]), `swatch kept skin: ${a.swatch} | ${a.warnings.join(' | ')}`);
    faceColor = [60, 200, 90]; // a full head mask: the face skin turns green
    const b = await run('green alien mask');
    assert.ok(near(b.swatch, [60, 200, 90]), `swatch took the new skin color: ${b.swatch} | ${b.warnings.join(' | ')}`);
    await page.context().close();
  });

  await step('unwrapped legs: the strip order (inner/back/outer/front) is read from the model and sent', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Mock paint: purple fabric with a black wedge down the middle (the gap Muse draws between trouser legs).
    const wedge = makePng(64, 64, (x, y) => (Math.abs(x - 32) < (64 - y) / 6 ? [8, 8, 10] : [120, 40, 200])).toString(
      'base64',
    );
    const edits = [];
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const isChat = route.request().url().endsWith('/chat/completions');
      if (route.request().url().endsWith('/responses')) return route.fulfill(samNone());
      if (!isChat) edits.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(isChat ? { choices: [{ message: { content: '{}' } }] } : { data: [{ b64_json: wedge }] }),
      });
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, unwrappedLegs: true })));
    });
    await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-legs' });
      await p.postPrompt('clown', { useVisionPlanning: false, variants: 1, normalMaps: false, roughnessMaps: false });
    }, glb);
    const dark = await page.evaluate(() => {
      const p = window.reskin.plugin;
      const slot = p.layout.slots.find((s) => s.texture);
      const out = p.lastPartJobs.get(slot.id).out;
      const d = out
        .getContext('2d')
        .getImageData(0.52 * out.width, 0.42 * out.height, 0.16 * out.width, 0.26 * out.height).data;
      let n = 0;
      for (let k = 0; k < d.length; k += 4) if (Math.max(d[k], d[k + 1], d[k + 2]) < 28) n++;
      return n / (d.length / 4);
    });
    assert.ok(dark < 0.01, `dark wedge filled: ${dark}`);
    const legs = edits.find((e) => /"Body \(legs\)" area/.test(e.prompt));
    assert.ok(legs, 'legs painted');
    assert.match(
      legs.prompt,
      /8 vertical strips in 2 groups \(one per limb\), each wrapping all the way round: inner side, back, outer side, front \| inner side, front, outer side, back/,
      legs.prompt.split('\n').find((l) => /strips/.test(l)),
    );
    await page.context().close();
  });

  await step('an avatar that is one single mesh is still painted zone by zone', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const edits = [];
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const isChat = route.request().url().endsWith('/chat/completions');
      if (route.request().url().endsWith('/responses')) return route.fulfill(samNone());
      if (!isChat) edits.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(
          isChat
            ? { choices: [{ message: { content: '{}' } }] }
            : { data: [{ b64_json: makePng().toString('base64') }] },
        ),
      });
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ oneMesh: true })));
    });
    await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-one' });
      await p.postPrompt('clown', { useVisionPlanning: false, variants: 1, normalMaps: false, roughnessMaps: false });
    }, glb);
    const areas = edits.map((e) => (e.prompt.match(/"([^"]+)" area/) ?? [])[1]).filter(Boolean);
    assert.ok(areas.length >= 6, `painted zone by zone: ${areas.join(', ')} (${edits.length} calls)`);
    assert.ok(areas.includes('Body (legs)') && areas.includes('Body (shoes)'), areas.join(', '));
    await page.context().close();
  });

  await step(
    'SAM 3.1 check: stray text on any model is repainted; skipped when the theme asks for decals',
    async () => {
      const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
      const edits = [];
      let asks = [];
      let textAsks = 0;
      await page.route('https://api.meta.ai/v1/**', (route) => {
        const req = route.request();
        if (req.url().endsWith('/responses')) {
          const body = req.postDataJSON();
          const [text, image] = body.input[0].content;
          asks.push(text.text);
          // The largest area goes first: its original (clean), then its first paint (lettering).
          if (text.text === 'text' && ++textAsks === 2) return route.fulfill(samWhole(image.image_url));
          return route.fulfill(samNone());
        }
        if (!req.url().endsWith('/chat/completions')) edits.push(req.postDataJSON());
        return museOk(route);
      });
      const glb = await page.evaluate(async () => {
        const mod = await import('/src/sampleModel.js');
        return Array.from(new Uint8Array(await mod.buildOrientationTestGlb()));
      });
      const run = (theme) =>
        page.evaluate(
          async ({ bytes, theme }) => {
            const p = window.reskin.plugin;
            const w = [];
            const off = p.on('warning', (e) => w.push(e.message));
            await p.postModel(new Uint8Array(bytes).buffer, { name: 'stray-text' });
            await p.postPrompt(theme, {
              useVisionPlanning: false,
              variants: 1,
              normalMaps: false,
              roughnessMaps: false,
            });
            off?.();
            return w;
          },
          { bytes: glb, theme },
        );
      const warnings = await run('steampunk brass');
      assert.ok(asks.includes('text') && asks.includes('logo'), `asked: ${asks}`);
      assert.ok(!asks.includes('face'), 'no avatar rules on a non-avatar');
      assert.ok(
        warnings.some((m) => /SAM 3\.1 found text/.test(m)),
        warnings.filter((m) => /SAM/.test(m)).join(' | '),
      );
      const fix = edits.find((e) => /nobody asked for/.test(e.prompt ?? ''));
      assert.ok(fix, 'one area repainted without the lettering');
      assert.match(fix.prompt, /no text, letters, numbers, logos or watermarks/);
      assert.equal(edits.length, 3, 'two areas painted, one of them again');

      // A theme that asks for decals or lettering is not checked for them.
      asks = [];
      edits.length = 0;
      await run('race car livery with sponsor decals');
      assert.deepEqual(asks, [], `asked: ${asks}`);
      assert.equal(edits.length, 2);
      await page.context().close();
    },
  );

  await step('SAM 3.1 check: shoes painted on the legs are found and the legs repainted once', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    await page.evaluate((d) => (window.__pluginDir = d), fileURLToPath(new URL('../../plugin/', import.meta.url)));
    const edits = [];
    const sams = [];
    let shoeAsks = 0;
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const req = route.request();
      if (req.url().endsWith('/responses')) {
        const body = req.postDataJSON();
        const [text, image] = body.input[0].content;
        sams.push({ model: body.model, prompt: text.text, stream: body.stream });
        // Asked for the original first (nothing there), then the first paint (shoes), then the repaint (clean).
        if (text.text === 'shoe' && ++shoeAsks === 2) return route.fulfill(samWhole(image.image_url));
        return route.fulfill(samNone());
      }
      if (!req.url().endsWith('/chat/completions')) edits.push(req.postDataJSON());
      return museOk(route);
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ oneMesh: true })));
    });
    const warnings = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      const w = [];
      p.on('warning', (e) => w.push(e.message));
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-sam' });
      await p.postPrompt('pirate', { useVisionPlanning: false, variants: 1, normalMaps: false, roughnessMaps: false });
      return w;
    }, glb);
    assert.ok(
      sams.length > 0 && sams.every((s) => s.model === 'sam-3.1' && s.stream === true),
      JSON.stringify(sams[0]),
    );
    assert.equal(shoeAsks, 3, 'shoe asked of the original, the first paint and the repaint');
    const legs = edits.filter((e) => /"Body \(legs\)" area/.test(e.prompt ?? ''));
    assert.equal(legs.length, 2, `legs painted twice: ${legs.length}`);
    assert.match(legs[1].prompt, /drew a shoe/);
    assert.ok(
      warnings.some((m) => /SAM 3\.1 found shoe/.test(m)),
      warnings.filter((m) => /SAM/.test(m)).join(' | '),
    );
    assert.ok(
      warnings.some((m) => /repainting only the marked/.test(m)),
      warnings.join(' | '),
    );
    assert.ok(
      warnings.some((m) => /using the masked repaint/.test(m)),
      warnings.filter((m) => /SAM/.test(m)).join(' | '),
    );

    // Masked repaint keeps the first paint outside SAM's mask and feathers the edge.
    const blend = await page.evaluate(async () => {
      const { maskedBlend } = await import('/@fs' + window.__pluginDir + 'src/analysis/samCheck.js');
      const mk = (color) => {
        const c = document.createElement('canvas');
        c.width = 200;
        c.height = 200;
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, 200, 200);
        return c;
      };
      const mask = new Uint8Array(100 * 100);
      mask.fill(1, 50 * 100); // bottom half
      const out = maskedBlend(mk('#0000ff'), mk('#ff0000'), [{ mask, maskSize: { w: 100, h: 100 } }]);
      const px = (x, y) => Array.from(out.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
      return { top: px(100, 10), bottom: px(100, 190), edge: px(100, 100) };
    });
    assert.deepEqual(blend.top, [0, 0, 255], JSON.stringify(blend));
    assert.deepEqual(blend.bottom, [255, 0, 0], JSON.stringify(blend));
    assert.ok(blend.edge[0] > 0, `edge feathered/grown: ${JSON.stringify(blend)}`);

    // A SAM error turns the check off for the run; painting still finishes. Unticked: no SAM calls.
    await page.unroute('https://api.meta.ai/v1/**');
    let samCalls = 0;
    await page.route('https://api.meta.ai/v1/**', (route) => {
      if (!route.request().url().endsWith('/responses')) return museOk(route);
      samCalls++;
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }),
      });
    });
    const off = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const w = [];
      p.on('warning', (e) => w.push(e.message));
      const res = await p.postPrompt('ninja', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
      });
      return { w, slots: res.slots.length };
    });
    assert.ok(off.slots > 0);
    assert.equal(off.w.filter((m) => /SAM 3\.1 check turned off/.test(m)).length, 1, off.w.join(' | '));
    const before = samCalls;
    await page.evaluate(() =>
      window.reskin.plugin.postPrompt('robot', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
        samCheck: false,
      }),
    );
    assert.equal(samCalls, before, 'samCheck: false sends no SAM calls');
    await page.context().close();
  });

  await step('SAM zones: masks on the six views become paint zones; a profile wins; cost is counted', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const sams = [];
    const edits = [];
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const req = route.request();
      if (req.url().endsWith('/responses')) {
        const [text, image] = req.postDataJSON().input[0].content;
        const png = Buffer.from(image.image_url.split(',')[1], 'base64');
        const w = png.readUInt32BE(16),
          h = png.readUInt32BE(20);
        sams.push({ prompt: text.text, w, h });
        // The sheet is 3 x 2 views. "face": the top 14% of each side view; "shoe": the bottom 7%.
        const tile = w / 3;
        const sides = [0, 1, 2, 3].map((i) => [(i % 3) * tile, Math.floor(i / 3) * tile]);
        if (text.text === 'face')
          return route.fulfill(
            samRects(
              sides.map(([x, y]) => [x, y, x + tile, y + Math.round(tile * 0.14)]),
              w,
              h,
            ),
          );
        if (text.text === 'shoe')
          return route.fulfill(
            samRects(
              sides.map(([x, y]) => [x, y + Math.round(tile * 0.93), x + tile, y + tile]),
              w,
              h,
            ),
          );
        return route.fulfill(samNone());
      }
      if (!req.url().endsWith('/chat/completions')) edits.push(req.postDataJSON());
      return museOk(route);
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ oneMesh: true })));
    });
    const res = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      const w = [];
      p.on('warning', (e) => w.push(e.message));
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-zones' });
      const slot = p.layout.slots.find((s) => s.texture);
      const before = p.idRegions(slot).map((r) => r.name);
      // Only face and shoes are found: fewer zones than the usual 7 areas, so those are kept...
      const kept = await p.postFindZones({ assetClass: 'avatar' });
      const keptAreas = p.idRegions(slot).map((r) => r.name);
      // ...unless SAM is preferred (found again: no extra calls counted below come from this).
      const found = await p.postFindZones({ assetClass: 'avatar', force: true, preferSam: true });
      const after = p.idRegions(slot).map((r) => r.zone);
      const usage = p.getUsage();
      await p.postPrompt('pirate', {
        useVisionPlanning: false,
        variants: 1,
        normalMaps: false,
        roughnessMaps: false,
        samCheck: false,
      });
      // A profile wins over SAM zones (no SAM calls, usual areas).
      p.setProfile({ name: 'test', templates: [], panels: [] });
      const withProfile = p.idRegions(slot).map((r) => r.name);
      p.setProfile(null);
      const off = (p.setSamZones(false), p.idRegions(slot).map((r) => r.name));
      return { w, before, kept, keptAreas, found, after, segments: usage.session.segments, withProfile, off };
    }, glb);
    assert.equal(sams.length, 12, `one SAM image per phrase, twice: ${sams.map((s) => s.prompt).join(', ')}`);
    assert.deepEqual(res.keptAreas, res.before, 'fewer SAM zones than usual areas: usual areas kept');
    assert.ok(!res.kept?.length);
    assert.ok(res.w.some((m) => /fewer than the usual 7 areas/.test(m)));
    assert.ok(
      sams.every((s) => s.w === 3 * 384 && s.h === 2 * 384),
      `sheet size ${sams[0].w}x${sams[0].h}`,
    );
    assert.equal(res.segments, 12, 'cost badge counts 12 SAM images');
    for (const z of ['face', 'shoes', 'torso']) assert.ok(res.after.includes(z), `zone ${z}: ${res.after.join(', ')}`);
    assert.ok(res.found?.length, `zones returned: ${res.w.join(' | ')}`);
    assert.ok(
      res.w.some((m) => /SAM 3\.1 zones: .*face.*6 SAM images ≈ \$0\.0\d/.test(m)),
      res.w.filter((m) => /SAM/.test(m)).join(' | '),
    );
    // Painting used the SAM zones (one Muse image per zone), and found them only once.
    const areas = edits.map((e) => (e.prompt?.match(/"([^"]+)" area/) ?? [])[1]).filter(Boolean);
    assert.ok(areas.some((a) => /\(face\)/.test(a)) && areas.some((a) => /\(shoes\)/.test(a)), areas.join(', '));
    assert.equal(sams.length, 12, 'zones are not found again when painting');
    assert.deepEqual(res.withProfile, res.before, 'profile: usual areas');
    assert.deepEqual(res.off, res.before, 'switched off: usual areas');
    await page.context().close();
  });

  await step('review & fix: one 8-angle image goes to Muse, only the flagged area is repainted', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const png = makePng().toString('base64');
    const edits = [];
    const areaSplits = [];
    const chats = [];
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      if (req.url().endsWith('/responses')) return route.fulfill(samNone()); // SAM 3.1: nothing stray
      const body = req.postDataJSON();
      const ok = (json) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify(json),
        });
      if (req.url().endsWith('/chat/completions')) {
        if (/Each texture area below is painted separately/.test(body.messages[0].content[0].text)) {
          areaSplits.push(body);
          return ok({ choices: [{ message: { content: '{"areas": {"Body": "brass-riveted brown leather"}}' } }] });
        }
        chats.push(body);
        return ok({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: false,
                  summary: 'Body has a stripe',
                  issues: [{ area: 'Body', problem: 'skin stripe down the side', fix: 'cover the whole body area' }],
                  lessons: ['Keep chest details on front-facing areas only'],
                }),
              },
            },
          ],
        });
      }
      edits.push(body);
      return ok({ data: [{ b64_json: png }] });
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildOrientationTestGlb()));
    });
    const res = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'review-test' });
      const seen = [];
      p.on('thinking', (t) => seen.push(t.step));
      const painted = await p.postPrompt('steampunk', {
        useVisionPlanning: false,
        normalMaps: false,
        roughnessMaps: false,
      });
      const r = await p.postReview({ passes: 1 });
      const brief = (list) => list.map((t) => ({ step: t.step, prompt: t.prompt, areas: t.areas, issues: t.issues }));
      return {
        repainted: r.passes[0].repainted,
        sheet: [r.passes[0].sheet.width, r.passes[0].sheet.height],
        thinking: brief(painted.thinking),
        reviewThinking: brief(r.thinking),
        seen,
      };
    }, glb);
    assert.equal(chats.length, 1);
    assert.equal(areaSplits.length, 1, 'theme split per area once');
    assert.ok(
      edits.some((e) => /brass-riveted brown leather/.test(e.prompt)),
      'area theme reaches the paint prompt',
    );
    const images = chats[0].messages[0].content.filter((x) => x.type === 'image_url');
    assert.equal(images.length, 1, 'one combined review image');
    assert.match(chats[0].messages[0].content[0].text, /front 45°/);
    assert.match(chats[0].messages[0].content[0].text, /- Body = \w+/);
    assert.deepEqual(res.repainted, ['Body']);
    assert.equal(res.sheet[0], 1024); // 4 columns x 256
    // "What Muse is thinking": the class, the paint plan and the exact prompts, then the review.
    const steps = res.thinking.map((t) => t.step);
    for (const s of ['assetClass', 'plan', 'ask', 'paint']) assert.ok(steps.includes(s), `thinking has ${s}: ${steps}`);
    assert.ok(
      res.thinking.find((t) => t.step === 'plan').areas.some((a) => a.name === 'Body' && a.action === 'paint'),
      'plan lists the areas',
    );
    assert.ok(
      res.thinking.some((t) => t.step === 'paint' && t.prompt === edits[0].prompt),
      'paint entry carries the exact prompt sent',
    );
    const rv = res.reviewThinking.find((t) => t.step === 'review');
    assert.equal(rv?.issues?.[0]?.area, 'Body');
    assert.ok(res.seen.includes('review'), 'thinking events are emitted');
    assert.equal(edits.length, 3); // Head + Body, then Body again
    assert.match(edits[2].prompt, /"Body" area/);
    assert.match(edits[2].prompt, /Correction from a review of the last attempt: cover the whole body area/);
    assert.match(await page.textContent('#review'), /skin stripe/);
    // The lesson is stored (per asset type), persisted, and sent with the next paint calls.
    assert.match(edits[2].prompt, /Keep chest details on front-facing areas only/);
    assert.match(await page.evaluate(() => localStorage.getItem('muse-reskin-lessons')), /front-facing/);
    assert.match(await page.inputValue('#lessons'), /: Keep chest details/);
    await page.context().close();
  });

  await step('torso front line is found off-center; narrow middle piece between legs gets plain fabric', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const root = '/@fs' + fileURLToPath(new URL('../../plugin/src/', import.meta.url));
    const res = await page.evaluate(async (root) => {
      const f = await import(root + 'analysis/facing.js');
      const pp = await import(root + 'texture/partPaint.js');
      const mk = (w, h, draw) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        draw(c.getContext('2d'));
        return c;
      };
      // Facing map: back (blue) 0-40%, front (green) 40-90%, side (yellow) 90-100%.
      const guide = mk(200, 100, (g) => {
        g.fillStyle = '#2962ff';
        g.fillRect(0, 0, 80, 100);
        g.fillStyle = '#00c853';
        g.fillRect(80, 0, 100, 100);
        g.fillStyle = '#ffd600';
        g.fillRect(180, 0, 20, 100);
      });
      const text = f.frontSpanText(guide);
      // Front split over both edges (wrap seam down the front): green 0-30 and 170-200.
      const wrapped = mk(200, 100, (g) => {
        g.fillStyle = '#2962ff';
        g.fillRect(0, 0, 200, 100);
        g.fillStyle = '#00c853';
        g.fillRect(0, 0, 30, 100);
        g.fillRect(170, 0, 30, 100);
      });
      const ws = f.frontSpan(wrapped);
      const rolled = pp.rollCanvas(wrapped, Math.round(100 - (ws.start + ws.end + 1) / 2));
      const center = Array.from(rolled.getContext('2d').getImageData(100, 50, 1, 1).data);
      // Two legs (0-90, 110-200) and a 10px piece between them painted gold.
      const mask = mk(200, 100, (g) => {
        g.fillStyle = '#000';
        g.fillRect(0, 0, 200, 100);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 90, 100);
        g.fillRect(95, 0, 10, 100);
        g.fillRect(110, 0, 90, 100);
      });
      const painted = mk(200, 100, (g) => {
        g.fillStyle = '#5a3a20';
        g.fillRect(0, 0, 200, 100);
        g.fillStyle = '#d4a017';
        g.fillRect(95, 0, 10, 100);
      });
      const n = pp.plainNarrowSpans(painted, mask);
      const px = Array.from(painted.getContext('2d').getImageData(100, 50, 1, 1).data);
      // Face check: two eyes and a mouth on skin; one painted copy drops the mouth.
      const faceAt = (mouth) =>
        mk(100, 100, (g) => {
          g.fillStyle = '#f0c8a0';
          g.fillRect(0, 0, 100, 100);
          g.fillStyle = '#201010';
          g.fillRect(25, 30, 10, 10);
          g.fillRect(65, 30, 10, 10);
          if (mouth) g.fillRect(40, 70, 20, 6);
        });
      const faceMask = mk(100, 100, (g) => {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, 100, 100);
      });
      const good = pp.faceFeaturesKept(faceAt(true), faceAt(true), faceMask);
      const bad = pp.faceFeaturesKept(faceAt(true), faceAt(false), faceMask);
      return { text, n, px, center, good, bad };
    }, root);
    assert.match(res.text, /65% of the width/);
    assert.equal(res.n, 1);
    assert.deepEqual([res.good.total, res.good.kept], [3, 3], JSON.stringify(res.good));
    assert.equal(res.bad.lost.length, 1);
    assert.ok(res.bad.lost[0].y > 0.6, 'lost feature is the mouth');
    assert.deepEqual(res.center.slice(0, 3), [0x00, 0xc8, 0x53], 'wrapped front rolled to the middle');
    assert.deepEqual(res.px.slice(0, 3), [0x5a, 0x3a, 0x20]);
    await page.close();
  });

  await step('torso wrapped side|front|side|back: a design centred by Muse lands on the front centre', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Mock Muse: whatever it gets, it paints a red stripe down the middle of the image.
    const wrapEdits = [];
    const stripe = makePng(64, 64, (x) => (x >= 30 && x < 34 ? [255, 0, 0] : [40, 60, 200])).toString('base64');
    await page.route('https://api.meta.ai/v1/**', (route) => {
      const isChat = route.request().url().endsWith('/chat/completions');
      if (!isChat) wrapEdits.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(isChat ? { choices: [{ message: { content: '{}' } }] } : { data: [{ b64_json: stripe }] }),
      });
    });
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildAvatarTestGlb({ singleMesh: true, torsoWrap: true })));
    });
    const res = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      const logs = [];
      p.on('warning', (w) => logs.push(w.message));
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'avatar-wrap' });
      await p.postPrompt('tiger', { useVisionPlanning: false, variants: 1, normalMaps: false, roughnessMaps: false });
      const slot = p.layout.slots.find((s) => s.texture);
      const out = p.lastPartJobs.get(slot.id).out;
      const y = Math.round(0.86 * out.height);
      const d = out.getContext('2d').getImageData(0, y, out.width, 1).data;
      const red = [];
      for (let x = Math.round(0.4 * out.width); x < Math.round(0.98 * out.width); x++)
        if (d[x * 4] > 180 && d[x * 4 + 2] < 120) red.push(x / out.width);
      return { red, logs: logs.filter((l) => /torso/i.test(l)), zones: p.idRegions(slot).map((r) => r.name) };
    }, glb);
    // Front panel: u from 0.4 + 0.58/6 to 0.4 + 0.58/2, centre at 0.4 + 0.58/3.
    const frontCentre = 0.4 + 0.58 / 3;
    const near = res.red.filter((u) => Math.abs(u - frontCentre) < 0.02);
    assert.ok(
      near.length > 0,
      `stripe at front centre ${frontCentre.toFixed(3)}: red at ${JSON.stringify(res.red.map((u) => u.toFixed(3)))}; ${JSON.stringify(res)}`,
    );
    // A profile with exact panels and an artists' template: the template goes to Muse with the torso.
    const prof = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const logs = [];
      p.on('warning', (w) => logs.push(w.message));
      const t = document.createElement('canvas');
      t.width = t.height = 64;
      const g = t.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 64, 64);
      g.strokeStyle = '#f00';
      g.strokeRect(8, 8, 48, 48);
      p.setProfile({
        name: 'test',
        templates: [{ image: t, rect: [0.4, 0.74, 0.98, 0.98] }],
        panels: [{ zone: 'torso', facing: 'front', rect: [0.4 + 0.58 / 6, 0.74, 0.4 + 0.58 / 2, 0.98] }],
      });
      await p.postPrompt('tiger', { useVisionPlanning: false, variants: 1, normalMaps: false, roughnessMaps: false });
      p.setProfile(null);
      return logs.filter((l) => /template|torso/i.test(l));
    });
    assert.ok(
      prof.some((l) => /artists' template/.test(l)),
      JSON.stringify(prof),
    );
    const withTpl = wrapEdits.filter((e) => /artists' template for this same area/.test(e.prompt));
    assert.ok(withTpl.length > 0, 'template sent with the areas');
    assert.ok(withTpl.every((e) => e.images.length >= 3));
    await page.close();
  });

  await step('edge padding removes dark gaps; tiny islands become one solid color', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    // Mock paint: black background, red over the arm area, 1-texel red/yellow stripes elsewhere (64px -> 16px stripes).
    const png = makePng(64, 64, (x, y) => {
      const u = (x + 0.5) / 64,
        v = (y + 0.5) / 64;
      if (u > 0.1 && u < 0.4 && v > 0.1 && v < 0.9) return [255, 0, 0];
      if (v > 0.4 && v < 0.55) return x % 2 ? [255, 255, 0] : [255, 0, 0];
      return [0, 0, 0];
    }).toString('base64');
    await page.route('https://api.meta.ai/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(
          route.request().url().endsWith('/chat/completions')
            ? { choices: [{ message: { content: '{}' } }] }
            : { data: [{ b64_json: png }] },
        ),
      }),
    );
    const glb = await page.evaluate(async () => {
      const mod = await import('/src/sampleModel.js');
      return Array.from(new Uint8Array(await mod.buildPaddingTestGlb()));
    });
    const px = await page.evaluate(async (bytes) => {
      const p = window.reskin.plugin;
      await p.postModel(new Uint8Array(bytes).buffer, { name: 'pad-test' });
      const r = await p.postPrompt('clown', {
        paintMode: 'atlas',
        useVisionPlanning: false,
        normalMaps: false,
        roughnessMaps: false,
        detailPreserve: 0,
      });
      const c = r.slots[0].canvas;
      const g = c.getContext('2d');
      const at = (u, v) =>
        Array.from(g.getImageData(Math.round(u * c.width), Math.round(v * c.height), 1, 1).data).slice(0, 3);
      return {
        size: c.width,
        outsideArm: at(0.4 + 6 / 1024, 0.5), // 6px right of the arm island: inside the padding
        farAway: at(0.95, 0.05),
        fingerA: at(0.505, 0.465),
        fingerB: at(0.525, 0.465),
      };
    }, glb);
    assert.equal(px.size, 1024);
    assert.ok(px.outsideArm[0] > 200 && px.outsideArm[1] < 60, `padding should be red, got ${px.outsideArm}`);
    assert.deepEqual(px.farAway, [0, 0, 0]); // far from any island: untouched
    assert.deepEqual(px.fingerA, px.fingerB, 'tiny island is one solid color');
    assert.match(await page.textContent('#log'), /cleaned up 10 tiny island/);
    await page.context().close();
  });

  await step('building: roof and underside are their own areas; the underside is flat black', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    const out = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const mod = await import('/src/sampleModel.js');
      await p.postModel(await mod.buildBuildingTestGlb(), { name: 'building-test' });
      const slot = p.layout.slots[0];
      const names = p.idRegions(slot, { assetClass: 'building' }).map((r) => r.name);
      const r = await p.postPrompt('mossy green stone ruin', { assetClass: 'building' });
      const c = r.slots[0].canvas;
      const k = c.width / 512;
      const mean = (x, y, w, h) => {
        const d = c.getContext('2d').getImageData(x * k, y * k, w * k, h * k).data;
        const m = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) m[j] += d[i + j];
        return m.map((v) => v / (d.length / 4));
      };
      // Fast (one pass): one atlas image, then the roof and underside are filled the same way.
      const notes = [];
      const off1 = p.on('warning', (w) => notes.push(w.message));
      const fast = await p.postPrompt('mossy green stone ruin', { assetClass: 'building', paintMode: 'atlas' });
      off1();
      const fc = fast.slots[0].canvas;
      const fd = fc.getContext('2d').getImageData((345 * fc.width) / 512, (335 * fc.width) / 512, 10, 10).data;
      const fastDoor = Math.max(fd[0], fd[1], fd[2]);
      // Overlapping UVs: the underside shares the front wall's pixels, so it stays with the walls.
      const warnings = [];
      const off = p.on('warning', (w) => warnings.push(w.message));
      await p.postModel(await mod.buildBuildingTestGlb({ sharedUnderside: true }), { name: 'building-shared' });
      const shared = p.idRegions(p.layout.slots[0], { assetClass: 'building' }).map((r) => r.name);
      off();
      return {
        names,
        door: mean(345, 335, 70, 110),
        beside: mean(270, 270, 60, 110),
        shared,
        warnings,
        fastDoor,
        fastNotes: notes.filter((n) => /one-pass mode/.test(n)),
      };
    });
    assert.ok(
      out.names.some((n) => /\(roof\)/.test(n)),
      out.names.join(' | '),
    );
    assert.ok(
      out.names.some((n) => /\(underside\)/.test(n)),
      out.names.join(' | '),
    );
    assert.ok(!out.names.some((n) => /\(roof\)|\(underside\)/.test(n) && /walls/.test(n)));
    // Underside: flat black, the facade door is gone.
    assert.ok(Math.max(...out.door, ...out.beside) < 8, `underside not black: ${out.door} / ${out.beside}`);
    assert.ok(out.fastDoor < 8, `one pass: underside not black (${out.fastDoor})`);
    assert.equal(out.fastNotes.length, 2, out.fastNotes.join('\n'));
    assert.ok(
      out.shared.some((n) => /\(roof\)/.test(n)) && !out.shared.some((n) => /\(underside\)/.test(n)),
      out.shared.join(' | '),
    );
    assert.ok(
      out.warnings.some((w) => /underside uses the same part of the texture/.test(w)),
      out.warnings.join('\n'),
    );
    await page.context().close();
  });

  await step('imageOrder image: handed-out canvases are flipped, the model keeps glTF order', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    const out = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const mod = await import('/src/sampleModel.js');
      const glb = await mod.buildBuildingTestGlb();
      const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3));
      const pts = [
        [10, 10],
        [100, 80],
        [370, 380],
        [250, 300],
      ];
      const sample = (c, flip) => pts.map(([x, y]) => px(c, x, flip ? c.height - 1 - y : y));
      const run = async (loadOpts, promptOpts) => {
        await p.postModel(glb.slice(0), { name: 'order', ...loadOpts });
        const ev = [];
        const off = p.on('textureUpdated', (e) => ev.push(e));
        const r = await p.postPrompt('mossy stone', { assetClass: 'prop', paintMode: 'atlas', ...promptOpts });
        off();
        const mapImg = p.layout.slots[0].materials[0].map.image;
        return {
          canvas: r.slots[0].canvas,
          order: r.slots[0].imageOrder,
          ev: ev.find((e) => e.kind === 'baseColor'),
          mapImg,
        };
      };
      const a = await run({}, {});
      const b = await run({ imageOrder: 'image' }, {});
      const c = await run({}, { imageOrder: 'image' });
      return {
        a: sample(a.canvas, false),
        aOrder: a.order,
        bFlipped: sample(b.canvas, true),
        bOrder: b.order,
        bEvent: sample(b.ev.canvas, true),
        bEventOrder: b.ev.imageOrder,
        bModel: sample(b.mapImg, false),
        cFlipped: sample(c.canvas, true),
      };
    });
    assert.equal(out.aOrder, 'gltf');
    assert.equal(out.bOrder, 'image');
    assert.equal(out.bEventOrder, 'image');
    assert.deepEqual(out.bFlipped, out.a, 'result canvas flipped');
    assert.deepEqual(out.bEvent, out.a, 'textureUpdated canvas flipped');
    assert.deepEqual(out.bModel, out.a, 'model texture stays in glTF order');
    assert.deepEqual(out.cFlipped, out.a, 'postPrompt option works too');
    await page.context().close();
  });

  await step(
    'vehicle: light lenses and tyre treads keep their original pixels; sidewalls, lens rings and mirrors are painted (both modes)',
    async () => {
      const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
      await page.evaluate(
        (r) => (window.__pluginRoot = r),
        fileURLToPath(new URL('../../plugin/src/', import.meta.url)),
      );
      const out = await page.evaluate(async () => {
        const p = window.reskin.plugin;
        const mod = await import('/src/sampleModel.js');
        const glb = await mod.buildVehicleTestGlb();
        const mean = (c, x, y, w, h) => {
          const k = c.width / 512;
          const d = c.getContext('2d').getImageData(x * k, y * k, w * k, h * k).data;
          const m = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) m[j] += d[i + j];
          return m.map((v) => Math.round(v / (d.length / 4)));
        };
        const res = {};
        for (const mode of ['auto', 'atlas']) {
          await p.postModel(glb.slice(0), { name: 'vehicle-test' });
          const notes = [];
          const off = p.on('warning', (w) => notes.push(w.message));
          const r = await p.postPrompt('neon pink candy', { assetClass: 'vehicle', paintMode: mode });
          off();
          const c = r.slots[0].canvas;
          res[mode] = {
            head: mean(c, 40, 296, 48, 48),
            ring: mean(c, 12, 300, 12, 40),
            mirror: mean(c, 290, 290, 60, 60),
            tail: mean(c, 160, 280, 60, 60),
            tread: mean(c, 40, 410, 180, 80),
            side: mean(c, 290, 410, 60, 80),
            body: mean(c, 100, 60, 300, 120),
            note: notes.some((n) => /kept the original lights and tyre treads/.test(n)),
          };
        }
        // The car grouped under "Body + Wheel_FL" (as ModStorm does): the body is not a wheel.
        await p.postModel(await mod.buildVehicleTestGlb({ groupName: 'Body + Wheel_FL' }), { name: 'grouped' });
        const g = await p.postPrompt('neon pink candy', { assetClass: 'vehicle', paintMode: 'atlas' });
        res.grouped = {
          body: mean(g.slots[0].canvas, 100, 60, 300, 120),
          kept: g.thinking.filter((t) => t.step === 'kept').map((t) => t.treadTriangles),
        };
        // Muse's reading wins over names: Muse says the "Wheel FL" part is body paint.
        await p.postModel(glb.slice(0), { name: 'roles' });
        const m = await p.postPrompt('neon pink candy', {
          assetClass: 'vehicle',
          paintMode: 'atlas',
          suggestion: { subject: 'toy car', partRoles: { 'Wheel FL': 'body', 'Headlight L': 'light' } },
        });
        res.roles = {
          tread: mean(m.slots[0].canvas, 40, 410, 180, 80),
          head: mean(m.slots[0].canvas, 40, 296, 48, 48),
          parts: m.thinking.filter((t) => t.step === 'parts').flatMap((t) => t.decisions ?? []),
          checks: m.thinking.filter((t) => t.step === 'check').length,
        };
        // A wide tyre (more tread than sidewall): its tread is still found and kept.
        await p.postModel(await mod.buildVehicleTestGlb({ tyreWidth: 0.45, openTyre: true }), { name: 'wide' });
        const wide = await p.postPrompt('neon pink candy', { assetClass: 'vehicle', paintMode: 'atlas' });
        res.wideTread = mean(wide.slots[0].canvas, 40, 410, 180, 80);
        // Whatever way the wheel was imported (axle along X, Y, Z or tilted), the tread is kept.
        res.turned = [];
        for (const rot of [
          [0, 0, 0],
          [0, Math.PI / 2, 0],
          [0.6, 0.9, 0.3],
          [2.2, -0.5, 1.4],
        ]) {
          await p.postModel(await mod.buildVehicleTestGlb({ tyreWidth: 0.45, openTyre: true, wheelRotation: rot }), {
            name: 'turned',
          });
          const t = await p.postPrompt('neon pink candy', { assetClass: 'vehicle', paintMode: 'atlas' });
          res.turned.push(mean(t.slots[0].canvas, 40, 410, 180, 80));
        }
        // A texture left as the original is flagged by the check.
        await p.postModel(glb.slice(0), { name: 'unpainted' });
        const slot = p.layout.slots[0];
        const c = document.createElement('canvas');
        c.width = c.height = 512;
        c.getContext('2d').drawImage(slot.texture.image, 0, 0, 512, 512);
        res.flagged = p.checkUnpainted(slot, c, c, null, null).map((f) => Math.round(f.share * 100));
        // A SAM "wheels" zone must hold a round piece to be a wheel (else it is wheel arches).
        const ka = await import('/@fs' + window.__pluginRoot + 'analysis/keepAreas.js').catch(() => null);
        const zone = (name) => {
          const m = slot.meshes.find((x) => x.name === name);
          const idx = m.geometry.index;
          const n = (idx ? idx.count : m.geometry.getAttribute('position').count) / 3;
          return { tris: new Map([[m, new Uint8Array(n).fill(1)]]) };
        };
        // Half a wheel (like a wheel arch around it) is not a wheel.
        const half = zone('Wheel_FL');
        for (const [m, use] of half.tris) {
          const pos = m.geometry.getAttribute('position');
          const idx = m.geometry.index;
          m.updateWorldMatrix(true, false);
          const v = new m.position.constructor();
          for (let t = 0; t < use.length; t++) {
            let y = 0;
            for (let k = 0; k < 3; k++)
              y += v.fromBufferAttribute(pos, idx ? idx.getX(t * 3 + k) : t * 3 + k).applyMatrix4(m.matrixWorld).y;
            if (y / 3 < m.getWorldPosition(v.clone()).y) use[t] = 0;
          }
        }
        res.zoneWheel = ka
          ? [ka.zoneHasWheel(slot, zone('Body')), ka.zoneHasWheel(slot, zone('Wheel_FL')), ka.zoneHasWheel(slot, half)]
          : null;
        return res;
      });
      const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
      assert.ok(!near(out.roles.tread, [91, 91, 91], 12), `Muse says body: tread still kept ${out.roles.tread}`);
      assert.ok(near(out.roles.head, [255, 224, 64]), `Muse says light: lens changed ${out.roles.head}`);
      assert.ok(
        out.roles.parts.some((d) => d.source === 'Muse (over its name)' && d.role === 'body'),
        `parts decision logged: ${JSON.stringify(out.roles.parts)}`,
      );
      assert.ok(out.roles.parts.some((d) => d.role === 'light' && d.source === 'Muse'));
      assert.ok(out.roles.checks > 0, 'final texture is checked against the plan');
      assert.deepEqual(out.flagged, [100], 'an unpainted texture is flagged');
      assert.ok(near(out.wideTread, [91, 91, 91], 12), `wide tyre: tread painted ${out.wideTread}`);
      out.turned.forEach((c, i) => assert.ok(near(c, [91, 91, 91], 12), `turned wheel ${i}: tread painted ${c}`));
      assert.deepEqual(
        out.zoneWheel,
        [false, true, false],
        'box body and half a wheel are not wheels, the cylinder is',
      );
      assert.ok(!near(out.grouped.body, [32, 80, 192], 10), `grouped car: body kept as tyre ${out.grouped.body}`);
      for (const mode of ['auto', 'atlas']) {
        const o = out[mode];
        assert.ok(near(o.head, [255, 224, 64]), `${mode}: headlight changed ${o.head}`);
        assert.ok(near(o.tail, [224, 32, 32]), `${mode}: taillight changed ${o.tail}`);
        // Old body paint around a lens, and a mirror taken for a light, are painted like the body.
        assert.ok(!near(o.ring, [32, 80, 192], 30), `${mode}: body-colored ring around the lens kept ${o.ring}`);
        assert.ok(!near(o.mirror, [32, 80, 192], 30), `${mode}: body-colored mirror kept ${o.mirror}`);
        // Original tread: stripes of #303030 and #b0b0b0 (1/3 light).
        assert.ok(near(o.tread, [91, 91, 91], 12), `${mode}: tread changed ${o.tread}`);
        assert.ok(!near(o.side, [128, 128, 128], 10), `${mode}: sidewall not painted ${o.side}`);
        assert.ok(!near(o.body, [32, 80, 192], 10), `${mode}: body not painted ${o.body}`);
        assert.ok(o.note, `${mode}: no "kept" note`);
      }
      await page.context().close();
    },
  );

  console.log('Single textures (postTexture) and texture ids');
  await step('events carry the glTF texture and image index of the texture they replace', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    const out = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      const mod = await import('/src/sampleModel.js');
      await p.postModel(await mod.buildOrientationTestGlb(), { name: 'ids-test' });
      const updates = [];
      const off = p.on('textureUpdated', (e) => updates.push({ ...e, canvas: undefined }));
      const r = await p.postPrompt('lava', { paintMode: 'atlas' });
      // The model has no normal / roughness maps: 'always' creates them, and they replace nothing.
      const made = await p.postPrompt('lava', { paintMode: 'atlas', normalMaps: 'always', roughnessMaps: 'always' });
      off();
      const created = made.slots.flatMap((s) => s.maps.filter((m) => m.kind !== 'baseColor'));
      const json = p.model.gltf.parser.json;
      return {
        updates,
        slots: r.slots.map((s) => ({
          slotId: s.slotId,
          textureIndex: s.textureIndex,
          imageIndex: s.imageIndex,
          textureUuid: s.textureUuid,
        })),
        images: json.images.length,
        created: created.map((m) => ({
          kind: m.kind,
          textureName: m.textureName,
          textureUuid: m.textureUuid,
          imageIndex: m.imageIndex,
        })),
        plainMaps: r.slots.flatMap((s) => s.maps.map((m) => m.kind)),
      };
    });
    const base = out.updates.filter((u) => u.kind === 'baseColor');
    assert.ok(base.length >= 1, 'baseColor update');
    for (const u of base) {
      assert.equal(typeof u.textureIndex, 'number', `textureIndex on ${u.slotId}`);
      assert.ok(u.imageIndex >= 0 && u.imageIndex < out.images, `imageIndex on ${u.slotId}`);
      assert.ok(u.textureUuid && 'textureName' in u && 'imageName' in u);
    }
    assert.equal(out.slots[0].imageIndex, base.find((u) => u.slotId === out.slots[0].slotId).imageIndex);
    assert.deepEqual([...new Set(out.plainMaps)], ['baseColor'], 'no normal/roughness maps made by default');
    assert.ok(out.created.length >= 2, 'always: maps created');
    for (const m of out.created)
      assert.deepEqual([m.textureName, m.textureUuid, m.imageIndex], [null, null, null], m.kind);
    await page.context().close();
  });

  await step('postTexture: a tiling texture comes back tiling, with tiling normal and roughness maps', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    const out = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      // A checker that tiles (period divides the size).
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const g = c.getContext('2d');
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          g.fillStyle = (x + y) % 2 ? '#303030' : '#d0d0d0';
          g.fillRect(x * 32, y * 32, 32, 32);
        }
      const events = [];
      p.on('textureProgress', (e) => events.push(e.stage));
      const r = await p.postTexture(c, { theme: 'molten lava', context: 'race track surface', id: 'img-42' });
      const n = await p.measureSeams(r.normal);
      const rough = await p.measureSeams(r.roughness);
      return {
        id: r.id,
        cls: r.assetClass,
        wrap: r.wrap,
        seams: r.seams,
        n,
        rough,
        w: r.canvas.width,
        h: r.canvas.height,
        events,
        busy: p.isBusy,
      };
    });
    assert.equal(out.id, 'img-42');
    assert.equal(out.cls, 'material');
    assert.equal(out.wrap, 'both');
    assert.ok(out.seams.after.x < 2 && out.seams.after.y < 2, JSON.stringify(out.seams));
    assert.ok(out.n.x < 2 && out.n.y < 2, `normal tiles ${JSON.stringify(out.n)}`);
    assert.ok(out.rough.x < 2 && out.rough.y < 2, `roughness tiles ${JSON.stringify(out.rough)}`);
    assert.deepEqual([out.w, out.h], [256, 256]);
    assert.ok(out.events.includes('done'));
    assert.equal(out.busy, false);
    await page.context().close();
  });

  await step('postTexture: a sky panorama joins left to right, calm poles, Muse gets the equirect prompt', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const prompts = [];
    await page.route('https://api.meta.ai/v1/**', async (route) => {
      const req = route.request();
      if (!req.url().endsWith('/chat/completions')) prompts.push(req.postDataJSON()?.prompt ?? '');
      return museOk(route);
    });
    const out = await page.evaluate(async () => {
      const p = window.reskin.plugin;
      // 2:1 sky: blue gradient to a green ground, a sun near the right edge (does not wrap).
      const c = document.createElement('canvas');
      c.width = 512;
      c.height = 256;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 512, 0);
      grad.addColorStop(0, '#203060');
      grad.addColorStop(1, '#a0c0ff');
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 128);
      g.fillStyle = '#306030';
      g.fillRect(0, 128, 512, 128);
      const before = await p.measureSeams(c);
      const r = await p.postTexture(c, { theme: 'stormy sunset', assetClass: 'sky' });
      const d = r.canvas.getContext('2d').getImageData(0, 0, r.canvas.width, 1).data;
      const top = new Set();
      for (let x = 0; x < r.canvas.width; x += 37) top.add(`${d[x * 4]},${d[x * 4 + 1]},${d[x * 4 + 2]}`);
      return {
        before,
        wrap: r.wrap,
        seams: r.seams,
        normal: r.normal,
        roughness: r.roughness,
        w: r.canvas.width,
        h: r.canvas.height,
        top: top.size,
      };
    });
    assert.ok(out.before.x > 2, 'test sky does not wrap before');
    assert.equal(out.wrap, 'equirect');
    assert.ok(out.seams.after.x < 2, JSON.stringify(out.seams));
    assert.equal(out.normal, null);
    assert.equal(out.roughness, null);
    assert.deepEqual([out.w, out.h], [512, 256]);
    assert.equal(out.top, 1, 'zenith row is one color');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /equirectangular/);
    assert.match(prompts[0], /stormy sunset/);
    await page.context().close();
  });

  console.log('Drag and drop');
  await step('dropping a .glb loads it and opens the prompt', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    await page.evaluate(async (bytes) => {
      const file = new File([new Uint8Array(bytes)], 'dropped-robot.glb', { type: 'model/gltf-binary' });
      const dt = new DataTransfer();
      dt.items.add(file);
      window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, Array.from(exported.buf));
    await page.waitForSelector('#prompt-dialog[open]');
    assert.equal(await page.evaluate(() => window.reskin.plugin.model.name), 'dropped-robot');
    // The reskinned export re-imports with its new textures intact.
    const slots = await page.evaluate(() => window.reskin.plugin.layout.slots.map((s) => s.otherMaps));
    // The sample has no normal / roughness maps, so none are added (only existing ones are regenerated).
    assert.ok(!slots.some((m) => m.includes('normalMap')), 'no normal map added');
    await page.context().close();
  });
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll e2e tests passed');
process.exit(failures ? 1 : 0);
