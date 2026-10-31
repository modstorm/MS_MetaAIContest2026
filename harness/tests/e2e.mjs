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

async function reskinViaPopup(page, prompt, { suggest = false } = {}) {
  await page.waitForSelector('#prompt-dialog[open]');
  if (!suggest && (await page.isVisible('#opt-suggest'))) await page.uncheck('#opt-suggest');
  await page.fill('#prompt-text', prompt);
  await page.click('#prompt-go');
  await page.waitForSelector('#prompt-dialog:not([open])', { state: 'attached', timeout: 120_000 });
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
  assert.ok(robot.normalTexture, 'normal map exported');
  assert.ok(robot.pbrMetallicRoughness.metallicRoughnessTexture, 'roughness map exported');
  assert.ok(json.images.length >= 3, `expected >= 3 images, got ${json.images.length}`);
  return { buf, json, name: download.suggestedFilename() };
}

// A small valid PNG (64x64 gradient) used as the mocked Muse image.
function makePng(w = 64, h = 64) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 200;
      raw[o + 1] = (x * 4) & 255;
      raw[o + 2] = (y * 4) & 255;
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
    assert.ok(kinds.includes('baseColor') && kinds.includes('normal') && kinds.includes('roughness'), `maps: ${kinds}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${outDir}02-reskinned-offline.png` });
    exported = await exportAndCheck(page, 'offline.glb');
    assert.match(exported.name, /sample-robot-molten-lava/);
    // Compare toggle works
    await page.click('#btn-toggle');
    await page.screenshot({ path: `${outDir}03-original.png` });
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
    await reskinViaPopup(page, 'frozen ice crystal, frost and snow');
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
    await reskinViaPopup(page, 'mossy ancient stone ruin');
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
    await page.fill('#prompt-text', 'ice');
    await page.click('#prompt-go');
    await page.waitForSelector('#suggestion:not([hidden])');
    // Nothing painted yet: only the art-director call was made, with the 6-view sheet + 1 atlas.
    assert.deepEqual(
      calls.map((c) => c.url.split('/v1/')[1]),
      ['chat/completions'],
    );
    const content = calls[0].body.messages[0].content;
    assert.equal(content.filter((p) => p.type === 'image_url').length, 2);
    assert.match(content[0].text, /six orthographic renders/);
    assert.match(content[0].text, /"ice"/);
    assert.equal(await page.textContent('#sugg-subject'), suggestion.subject);
    assert.equal(await page.inputValue('#sugg-prompt'), suggestion.prompt);
    assert.equal(await page.textContent('#prompt-go'), 'Paint with this prompt');
    const sheet = await page.$eval('#sugg-sheet canvas', (c) => [c.width, c.height]);
    assert.ok(sheet[0] > sheet[1], 'contact sheet is 3x2');
    await page.screenshot({ path: `${outDir}05-muse-suggestion.png` });

    await page.fill('#sugg-prompt', suggestion.prompt + ' Add tiny snowflakes.');
    await page.click('#prompt-go');
    await page.waitForSelector('#prompt-dialog:not([open])', { state: 'attached', timeout: 120_000 });
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
      () => /Invalid API key/.test(document.querySelector('#prompt-stage')?.textContent ?? ''),
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
    await reskinViaPopup(page, 'gold armor', { suggest: false });
    assert.equal(bodies.length, 2);
    assert.ok('tool_enablement' in bodies[0] && !('tool_enablement' in bodies[1]));
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
    assert.ok(
      slots.some((m) => m.includes('normalMap')),
      'normal map survived round trip',
    );
    await page.context().close();
  });
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} test(s) failed` : '\nAll e2e tests passed');
process.exit(failures ? 1 : 0);
