import test from 'node:test';
import assert from 'node:assert/strict';
import { healthy } from './healthcheck.mjs';

test('container liveness uses only the configured loopback port and exact API identity', async () => {
  for (const port of ['8080', '65535']) {
    assert.equal(await healthy(port, async (url, init) => {
      assert.equal(String(url), `http://127.0.0.1:${port}/health`);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      return Response.json({ ok: true, service: 'arco-giwa-api' });
    }), true);
  }
  for (const body of [{ ok: false, service: 'arco-giwa-api' }, { ok: true, service: 'other' }, {}, null])
    assert.equal(await healthy('8080', async () => Response.json(body)), false);
});

test('invalid ports are rejected before a request, including URL and shell-like input', async () => {
  for (const port of ['', '0', '65536', '-1', '1.5', ' 8080', '8080/other', 'https://outside.test', '8080;command']) {
    let called = false;
    assert.equal(await healthy(port, async () => { called = true; return Response.json({}); }), false);
    assert.equal(called, false);
  }
});

test('unavailable, malformed and oversized health responses fail without raw output', async () => {
  for (const request of [async () => { throw Error('PRIVATE_ERROR'); },
    async () => Response.json({ ok: true, service: 'arco-giwa-api' }, { status: 503 }),
    async () => new Response('PRIVATE_NOT_JSON'),
    async () => Response.json({ ok: true, service: 'arco-giwa-api', extra: 'x'.repeat(1024) })])
    assert.equal(await healthy('8080', request), false);
});
