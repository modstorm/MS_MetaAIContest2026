// Counts the billed Muse calls of one avatar reskin per quality setting, with the
// Meta Model API mocked (no key needed, nothing is billed). Prints images, chat calls
// and SAM checks, and the cost at Meta's prices (chat tokens: a fixed per-call guess).
// Run: node harness/tests/cost-modes.mjs
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const harnessDir = fileURLToPath(new URL('..', import.meta.url));
process.env.NO_OPEN = '1';
const server = await createServer({
  root: harnessDir,
  configFile: `${harnessDir}/vite.config.js`,
  server: { port: 5198, strictPort: true, open: false },
});
await server.listen();
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });

function png(w = 64, h = 64) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
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
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set([40 + x * 3, 90, 160 - y], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG = png().toString('base64');
const SUGGESTION = JSON.stringify({
  subject: 'toy avatar',
  parts: [{ name: 'body', description: 'a toy figure' }],
  prompt: 'Pirate captain: long red coat with brass buttons, black boots, tricorn hat.',
  atlases: [],
});

// Rough chat token sizes per call (input, output), from the README's ~$0.06 Spark per reskin.
const CHAT_TOKENS = { in: 9000, out: 1500 };
const PRICE = { image: 0.01, sam: 0.0025, in: 1.25 / 1e6, out: 4.25 / 1e6 };

async function measure(label, opts, { review = true, suggest = true } = {}) {
  const page = await browser.newPage();
  await page.goto('http://localhost:5198/');
  await page.waitForFunction(() => !!window.reskin);
  const n = { images: 0, chats: 0, sam: 0 };
  await page.route('https://api.meta.ai/v1/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('/responses')) {
      n.sam++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ status: 'completed', output_text: '' }),
      });
    }
    const isChat = u.endsWith('/chat/completions');
    if (isChat) n.chats++;
    else n.images++;
    const text = isChat ? JSON.stringify(route.request().postDataJSON()) : '';
    const reply =
      /art director|recommend|six|views/i.test(text) && !/Each texture area below/.test(text) ? SUGGESTION : '{}';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(isChat ? { choices: [{ message: { content: reply } }] } : { data: [{ b64_json: PNG }] }),
    });
  });
  await page.evaluate(() => {
    localStorage.setItem('muse-reskin-settings', JSON.stringify({ provider: 'muse', apiKey: 'k', useProxy: false }));
  });
  await page.reload();
  await page.waitForFunction(() => !!window.reskin);
  const estimate = await page.evaluate(
    async ({ opts, review, suggest }) => {
      const mod = await import('/src/sampleModel.js');
      const p = window.reskin.plugin;
      await p.postModel(await mod.buildAvatarTestGlb({ singleMesh: true }), { name: 'avatar' });
      window.__estimate = p.estimateCost({ ...opts, suggest, review });
      const s = suggest ? await p.postSuggest('pirate captain') : undefined;
      await p.postPrompt('pirate captain', { suggestion: s, ...opts });
      if (review && p.canReview) await p.postReview({ passes: 1 });
      return window.__estimate;
    },
    { opts, review, suggest },
  );
  await page.close();
  const cost =
    n.images * PRICE.image + n.sam * PRICE.sam + n.chats * (CHAT_TOKENS.in * PRICE.in + CHAT_TOKENS.out * PRICE.out);
  console.log(
    `${label.padEnd(44)} ${String(n.images).padStart(3)} images  ${String(n.chats).padStart(2)} chats  ${String(n.sam).padStart(3)} SAM  ≈ $${cost.toFixed(3)}  (estimate shown before: ${estimate.images} images ≈ $${estimate.cost.toFixed(3)})`,
  );
  return { ...n, cost };
}

const CONFIGS = JSON.parse(process.env.CONFIGS ?? 'null') ?? [
  ['current default: part by part, 3 variations', { variants: 3 }],
  ['part by part, 1 variation', { variants: 1 }],
  ['whole atlas (one pass), 3 variations', { variants: 3, paintMode: 'atlas' }],
  ['whole atlas (one pass), 1 variation', { variants: 1, paintMode: 'atlas' }],
  ['one pass, high detail, 1 variation', { variants: 1, paintMode: 'atlas', imageReasoning: 'high' }],
];
for (const [label, opts, extra] of CONFIGS) await measure(label, opts, extra);
await browser.close();
await server.close();
