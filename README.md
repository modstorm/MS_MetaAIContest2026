# Muse Reskin

Drop a 3D model into the browser, type a theme, and get the model back retextured, as a GLB.

Muse Reskin reads a glTF/GLB model's texture atlas and UV layout. It then asks **Meta Muse** to repaint the atlas in the theme you typed, while keeping every UV island where it was so the new texture still wraps the model. It also rebuilds the normal and roughness maps to match. The result can be exported as a new `.glb`.

**Live demo:** https://modstorm.github.io/MS_MetaAIContest2026/
(Click **Sample model**, pick a theme, press **Reskin**. Without a key, choose the *Offline* backend in ⚙ Settings.)

---

## Quick start (local)

Requires Node.js 20 or newer.

```bash
git clone https://github.com/modstorm/MS_MetaAIContest2026.git
cd MS_MetaAIContest2026
npm install
cp .env.example .env        # then put your Meta Model API key in MUSE_API_KEY
npm run dev                 # opens http://localhost:5173
```

You can get a key at [dev.meta.ai](https://dev.meta.ai). Without one, the harness falls back to the offline procedural backend, so the whole pipeline (analysis, maps, export) still runs.

| Command | What it does |
| --- | --- |
| `npm run dev` | Harness dev server with the local Muse proxy |
| `npm run build` | Static build of the harness into `harness/dist/` (no key is ever included) |
| `npm test` | Plugin unit tests (Vitest) |
| `npm run test:e2e` | Browser tests with Playwright: offline backend, mocked Muse API, drag-and-drop |

## How it works

```
GLB ──► load (GLTFLoader, Draco + meshopt)
     ──► analyze: group meshes by base color texture → UV islands, coverage, overlap, tiling
     ──► suggest: renders six axis views (±X ±Y ±Z); muse-spark-1.3 looks at them + the UV atlases,
                  says what the object is, and recommends a stronger part-by-part prompt
                  and a per-region paint plan → shown to the user to review and edit
     ──► plan:    (without suggest) muse-spark-1.3 reads the atlas + UV wireframe and names each region
     ──► paint:   muse-image-1.0 /images/edits repaints the atlas in the theme, layout locked
               (untextured or tiled materials: /images/generations makes a seamless texture)
     ──► post:    resize to the source size, keep a little of the original shading,
                  derive normal + roughness maps from the new albedo (glTF ORM packing kept)
     ──► apply:   swap textures on the live three.js materials (original kept for compare)
     ──► export:  GLTFExporter → .glb
```

Edge cases handled:

- **Which patch is which part**: each mesh's UV area is drawn in its own color and named (Hair, Head, Body…) in a part map sent to Muse, so details land on the right part.
- **Part by part**: when a texture is shared by several named meshes (head, shirt, pants, shoes…), each part is cut out of the atlas on its own, turned upright, greyed outside its islands and painted with its own prompt (up to 4 Muse calls at once). The result is pasted back only inside that part's islands, so a design can't drift onto the wrong part or leave stripes of the old texture. `paintMode: 'atlas'` paints the whole atlas in one call instead.
- **Upside-down, sideways or mirrored islands**: the plugin works out from the 3D data which way "up" points in the texture. It turns the atlas upright before painting (head/face first) and turns the result back. The texture's own `flipY` and `KHR_texture_transform` are applied first, and the popup has a manual orientation override.
- **Safety filter rejections**: a plainer retry runs automatically, the popup shows a clear error with Retry, and a **filter probe** shows which input was rejected.

- **Meshes with no UVs** get box-projected UVs and a seamless texture.
- **Materials with no texture** get a generated seamless texture.
- **Stacked or mirrored UVs** and **tiled UVs** (outside 0..1) are detected and reported.
- **Shared atlases**: a texture used by many meshes or materials is repainted once.
- **Multi-file `.gltf`**: drop the `.gltf` together with its `.bin` and image files.

## Repository layout

```
plugin/            the reskin plugin (plain ES modules, depends only on three)
  src/
    ReskinPlugin.js        the class a host uses: post functions + update listener
    muse/MuseClient.js     Meta Model API client (images/generations, images/edits, chat/completions)
    muse/prompts.js        all prompts sent to Muse
    providers/             MuseProvider, ProceduralProvider (offline), provider contract
    analysis/              UV islands, coverage/overlap, texture layout, UV generation
    texture/               canvas helpers, UV guide rendering, normal/roughness derivation
    io/modelIO.js          GLB/glTF loading and GLB export
    server/index.js        optional Node proxy that adds the API key server-side
  test/                    unit tests
harness/           browser test harness (three.js viewer, drag-and-drop, prompt popup)
  src/                     main.js, viewer.js, sampleModel.js, styles.css
  tests/e2e.mjs            Playwright end-to-end tests
```

## Using the plugin in your own app

The plugin is a single class. You post inputs to it and listen for updates. It owns every Muse call and all mesh and texture processing.

```js
import { ReskinPlugin } from '@metaai26/reskin-plugin';

const plugin = new ReskinPlugin({ muse: { apiKey: 'YOUR_KEY' } }); // or { muse: { baseUrl: '/api/muse' } } behind a proxy

plugin.onUpdate(({ type, data }) => console.log(type, data));   // every event
plugin.on('textureUpdated', ({ kind, canvas }) => { /* preview */ });

const { model, layout } = await plugin.postModel(file);          // File, File[], Blob, ArrayBuffer or URL
scene.add(model.scene);

const suggestion = await plugin.postSuggest('haunted Halloween pumpkin armor'); // optional: review suggestion.prompt
await plugin.postPrompt(suggestion.prompt, { suggestion, detailPreserve: 0.35 });
const { glb, filename } = await plugin.postExport();             // ArrayBuffer
```

| Method | Purpose |
| --- | --- |
| `postModel(input, opts?)` | Load and analyze a model. Emits `loaded`. |
| `postSuggest(theme, opts?)` | Art-director step: six-view renders + atlases → Muse Spark recommends a prompt and region plan. Emits `views`, `suggestion`. Nothing is painted. |
| `postPrompt(prompt, opts?)` | Reskin the current model. Emits `progress`, `plan`, `textureUpdated`, `reskinned`. |
| `postExport(filename?)` | Export a GLB. Emits `exported`. |
| `on(type, cb)` / `onUpdate(cb)` | Subscribe to one event type or to all events. Both return an unsubscribe function. |
| `showOriginal(bool)`, `revert()`, `cancel()` | Compare before and after, undo, or stop a running reskin. |
| `setProvider(provider)` | Swap the backend (`MuseProvider`, `ProceduralProvider`, or your own). |
| `summary()`, `slotPreview(id)` | JSON layout summary, plus atlas and UV preview canvases. |

`postPrompt` options: `suggestion` (from `postSuggest`), `fast` (default on: no Muse web search, low reasoning, smaller uploads), `detailPreserve` (0..1), `useVisionPlanning`, `normalMaps`, `roughnessMaps`, `maxTextureSize`, `extraInstructions`, `slotIds`, `signal`.

A custom backend is any object with `reskinAtlas(req)` and `generateTexture(req)`. It may also have `planLayout(req)` and `reskinAuxMap(req)`. See `plugin/src/providers/types.js`.

## API keys and security

- Keys go in `.env`. Only `.env.example` is committed, and `.env` is git-ignored.
- In `npm run dev`, the key from `.env` is given to the browser so it can call `https://api.meta.ai/v1` directly. If the browser call is blocked (for example by CORS), the request is retried through the dev server's proxy at `/api/muse`, which adds the key on the server side.
- `npm run build` never embeds the key. On the hosted demo, you paste your own key in ⚙ Settings, and it is stored only in that browser's localStorage.
- For production, put `plugin/src/server/index.js` (`createMuseMiddleware`) in front of the API and point the plugin at it with `baseUrl`.

## Muse API reference

These are the endpoints used, from [dev.meta.ai/docs](https://dev.meta.ai/docs/image-generation):

- `POST /v1/images/edits`: `muse-image-1.0`, JSON body `{ model, prompt, images: [{ image_url }], size, output_format }`
- `POST /v1/images/generations`: `muse-image-1.0`, `{ model, prompt, size, output_format }`
- `POST /v1/chat/completions`: `muse-spark-1.3`, OpenAI-style messages with `image_url` parts

## License

MIT. See [LICENSE](LICENSE).
