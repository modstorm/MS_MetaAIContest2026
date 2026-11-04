import { describe, expect, it } from 'vitest';
import { MuseClient } from '../src/muse/MuseClient.js';

const okImage = () =>
  new Response(JSON.stringify({ data: [{ b64_json: 'iVBORw0KGgo=' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('Muse Image timeout', () => {
  it('gives up on a request that never returns (even if fetch ignores abort), asks once more, then fails', async () => {
    let calls = 0;
    const client = new MuseClient({
      apiKey: 'k',
      imageTimeoutMs: 40,
      fetch: () => {
        calls++;
        return new Promise(() => {}); // never settles, ignores the signal
      },
    });
    const t0 = Date.now();
    await expect(client.generateImage({ prompt: 'x' })).rejects.toMatchObject({ status: 408, type: 'timeout' });
    expect(calls).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('a stuck first request is aborted and the retry succeeds', async () => {
    let calls = 0,
      aborted = false;
    const client = new MuseClient({
      apiKey: 'k',
      imageTimeoutMs: 40,
      fetch: (_url, init) => {
        calls++;
        if (calls === 1) {
          init.signal.addEventListener('abort', () => (aborted = true));
          return new Promise(() => {});
        }
        return Promise.resolve(okImage());
      },
    });
    const blob = await client.generateImage({ prompt: 'x' });
    expect(blob).toBeTruthy();
    expect(calls).toBe(2);
    expect(aborted).toBe(true);
  });
});
