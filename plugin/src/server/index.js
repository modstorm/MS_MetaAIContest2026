/**
 * Optional Node-side proxy for the Meta Model API. Browser calls are fine to start
 * with, but this keeps the key off the client and avoids CORS issues if the API
 * does not allow browser origins. It forwards `{mount}/*` to `{MUSE_API_BASE}/*`
 * and adds `Authorization: Bearer {MUSE_API_KEY}`.
 *
 * Use as a Vite plugin:   plugins: [museProxy({ apiKey: env.MUSE_API_KEY })]
 * or as Connect/Express middleware: app.use(createMuseMiddleware({ apiKey }))
 */

export function createMuseMiddleware(opts) {
  const mount = (opts.mount ?? '/api/muse').replace(/\/+$/, '');
  const base = (opts.apiBase ?? 'https://api.meta.ai/v1').replace(/\/+$/, '');
  return async (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(mount + '/')) return next();
    const rest = url.slice(mount.length);
    if (rest === '/_status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ configured: !!opts.apiKey, apiBase: base }));
      return;
    }
    if (!opts.apiKey) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { type: 'auth_error', message: 'MUSE_API_KEY is not set in .env' } }));
      return;
    }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const upstream = await fetch(base + rest, {
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] ?? 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      res.statusCode = upstream.status;
      const type = upstream.headers.get('content-type');
      if (type) res.setHeader('Content-Type', type);
      const retry = upstream.headers.get('retry-after');
      if (retry) res.setHeader('Retry-After', retry);
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(err?.message ?? err) } }));
    }
  };
}

/** Vite plugin wrapper (dev server and `vite preview`). */
export function museProxy(opts) {
  const mw = createMuseMiddleware(opts);
  return {
    name: 'muse-proxy',
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}
