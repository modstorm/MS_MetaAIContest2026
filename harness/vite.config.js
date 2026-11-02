import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { museProxy } from '../plugin/src/server/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ command, mode }) => {
  // .env lives at the repo root (one level up).
  const env = loadEnv(mode, root, '');
  const isDev = command === 'serve';
  if (isDev && !env.MUSE_API_KEY)
    console.warn(
      '\n  No MUSE_API_KEY found. Copy .env.example to .env at the repo root, set MUSE_API_KEY, and restart "npm run dev".\n',
    );
  return {
    // Relative base so the static build works on GitHub Pages under any repo name.
    base: './',
    envDir: root,
    resolve: {
      // Use the plugin's source directly: no plugin build step needed, and HMR works.
      alias: { '@metaai26/reskin-plugin': fileURLToPath(new URL('../plugin/src/index.js', import.meta.url)) },
    },
    define: {
      // The key is injected ONLY for the local dev server, never into `vite build` output.
      __MUSE_DEV_KEY__: JSON.stringify(isDev ? (env.MUSE_API_KEY ?? '') : ''),
      __MUSE_API_BASE__: JSON.stringify(env.MUSE_API_BASE || 'https://api.meta.ai/v1'),
      __MUSE_IMAGE_MODEL__: JSON.stringify(env.MUSE_IMAGE_MODEL || 'muse-image-1.0'),
      __MUSE_VISION_MODEL__: JSON.stringify(env.MUSE_VISION_MODEL || 'muse-spark-1.3'),
      __HAS_DEV_PROXY__: JSON.stringify(isDev),
    },
    plugins: [museProxy({ apiKey: env.MUSE_API_KEY, apiBase: env.MUSE_API_BASE || undefined })],
    server: { port: 5173, open: !process.env.CI && !process.env.NO_OPEN },
    build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  };
});
