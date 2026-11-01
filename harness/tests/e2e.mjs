// End-to-end test of the harness + plugin in a real browser (Playwright / Chromium).
// - Starts the Vite dev server for the harness.
// - Offline backend: sample model -> prompt popup -> reskin -> export GLB -> validate.
// - Muse backend: same flow with the Meta Model API mocked, checking request shapes.
// - Drag-and-drop: drops the exported GLB back into the window.
// Run: npm run test:e2e   (needs `playwright` available; screenshots go to harness/test-results/)
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
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
  if (!suggest && (await page.isVisible('#opt-suggest'))) await page.uncheck('#opt-suggest');
  await page.fill('#prompt-text', prompt);
  await page.click('#prompt-go');
  await page.waitForSelector('#prompt-dialog:not([open])', { state: 'attached', timeout: 120_000 });
  if (variations > 1) await page.waitForSelector('#variations:not([hidden])', { timeout: 120_000 });
  else await page.waitForSelector('#run-dialog:not([open])', { state: 'attached', timeout: 120_000 });
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
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
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
    await page.click('#btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    const summary = await page.textContent('#layout-summary');
    assert.match(summary, /9 meshes/);
    assert.match(summary, /2 texture slot/);
    await page.screenshot({ path: `${outDir}01-loaded.png` });
    await reskinViaPopup(page, 'molten lava rock with glowing magma veins');
    const kinds = await page.$$eval('#generated figure', (f) => f.map((x) => x.dataset.kind));
    assert.deepEqual(kinds, ['baseColor'], `maps: ${kinds}`); // no normal/roughness in the sample to regenerate
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}02-reskinned-offline.png` });
    exported = await exportAndCheck(page, 'offline.glb');
    assert.match(exported.name, /sample-robot-molten-lava/);
    // Compare toggle works
    await page.click('#btn-toggle');
    await page.screenshot({ path: `${outDir}03-original.png` });
    await page.context().close();
  });

  await step('3 variations at once: pick one, history + undo, before/after slider', async () => {
    const page = await newPage({ provider: 'offline', apiKey: '', useProxy: false });
    await page.click('#btn-sample');
    await reskinViaPopup(page, 'molten lava rock', { variations: 3 }).catch(async (e) => {
      await page.screenshot({ path: `${outDir}08-variations-fail.png` });
      throw e;
    });
    assert.equal(await page.locator('#variation-list button').count(), 3);
    const h = await page.evaluate(() => window.reskin.plugin.historySummary());
    assert.equal(h.entries.length, 3);
    assert.equal(h.index, 0);
    // Variations differ (different variation notes reach the provider; offline palettes hash the theme only,
    // so compare the stored states instead).
    const mapOf = () => page.$eval('#generated [data-kind="baseColor"] canvas', (c) => c.toDataURL().length);
    const first = await mapOf();
    await page.click('#variation-list button:nth-child(2)');
    assert.notEqual(await mapOf(), first, 'generated maps follow the picked variation');
    assert.equal(await page.evaluate(() => window.reskin.plugin.historyIndex), 1);
    await page.screenshot({ path: `${outDir}08-variations.png` });
    await page.click('#run-cancel');
    await page.waitForSelector('#run-dialog:not([open])', { state: 'attached' });
    assert.equal(await page.locator('#history button.entry').count(), 4); // original + 3
    await page.click('#btn-undo');
    assert.equal(await page.evaluate(() => window.reskin.plugin.historyIndex), 0);
    await page.click('#history button.entry:nth-child(1)'); // original
    assert.equal(await page.evaluate(() => window.reskin.plugin.historyIndex), -1);
    assert.match(await page.textContent('#generated'), /Original textures/);
    await page.click('#history button.entry:nth-child(3)');
    await page.click('#btn-compare');
    assert.ok(await page.isVisible('#compare-handle'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}09-compare.png` });
    await page.click('#btn-compare');
    assert.ok(!(await page.isVisible('#compare-handle')));
    // Turntable spins after load and stops when the user drags.
    assert.ok(await page.evaluate(() => window.reskin.viewer.controls.autoRotate));
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
          }
        : { created: 1, data: [{ b64_json: png }], output_format: 'png', background: 'opaque' };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(json),
      });
    });
    await page.click('#btn-sample');
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

    // Second prompt on the same model: layout reading is cached, so only the paint call is made.
    const before = calls.length;
    await page.click('#btn-reskin');
    await reskinViaPopup(page, 'mossy ancient stone ruin', { paintMode: 'atlas' });
    const second = calls.slice(before).map((c) => c.url.split('/v1/')[1]);
    assert.deepEqual(second, ['images/edits']);
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
    await page.click('#btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    assert.equal(await page.textContent('#prompt-go'), 'Get Muse suggestion');
    await setPaintMode(page, 'atlas');
    await setReview(page, false);
    await page.selectOption('#opt-variations', '1');
    await page.fill('#prompt-text', 'ice');
    await page.click('#prompt-go');
    await page.waitForSelector('#suggestion:not([hidden])');
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
    assert.equal(await page.textContent('#run-go'), 'Paint with this prompt');
    const sheet = await page.$eval('#sugg-sheet canvas', (c) => [c.width, c.height]);
    assert.ok(sheet[0] > sheet[1], 'contact sheet is 3x2');
    await page.screenshot({ path: `${outDir}05-muse-suggestion.png` });

    await page.fill('#sugg-prompt', suggestion.prompt + ' Add tiny snowflakes.');
    await page.click('#run-go');
    await page.waitForSelector('#run-dialog:not([open])', { state: 'attached', timeout: 120_000 });
    const urls = calls.map((c) => c.url.split('/v1/')[1]);
    assert.deepEqual(urls, ['chat/completions', 'images/edits']); // region plan reused, no extra layout reading
    const edit = calls[1].body;
    assert.match(edit.prompt, /Add tiny snowflakes/);
    assert.match(edit.prompt, /frosted ice face plate/);
    assert.match(edit.prompt, /cartoon toy robot/);
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
    await page.click('#btn-sample');
    await page.waitForSelector('#prompt-dialog[open]');
    await page.fill('#prompt-text', 'gold armor');
    await page.click('#prompt-go');
    await page.waitForFunction(
      () => /Invalid API key/.test(document.querySelector('#err-text')?.textContent ?? ''),
      null,
      { timeout: 30_000 },
    );
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
    await page.click('#btn-sample');
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
    await page.click('#btn-sample');
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
    await page.click('#btn-sample');
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
    await page.click('#btn-idmap');
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
    // Zones list in the side panel; lock the legs there and repaint in red.
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

  await step('review & fix: one 8-angle image goes to Muse, only the flagged area is repainted', async () => {
    const page = await newPage({ provider: 'muse', apiKey: 'k', useProxy: false });
    const png = makePng().toString('base64');
    const edits = [];
    const chats = [];
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
      if (req.url().endsWith('/chat/completions')) {
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
      await p.postPrompt('steampunk', { useVisionPlanning: false, normalMaps: false, roughnessMaps: false });
      const r = await p.postReview({ passes: 1 });
      return { repainted: r.passes[0].repainted, sheet: [r.passes[0].sheet.width, r.passes[0].sheet.height] };
    }, glb);
    assert.equal(chats.length, 1);
    const images = chats[0].messages[0].content.filter((x) => x.type === 'image_url');
    assert.equal(images.length, 1, 'one combined review image');
    assert.match(chats[0].messages[0].content[0].text, /front 45°/);
    assert.match(chats[0].messages[0].content[0].text, /- Body = \w+/);
    assert.deepEqual(res.repainted, ['Body']);
    assert.equal(res.sheet[0], 1024); // 4 columns x 256
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
