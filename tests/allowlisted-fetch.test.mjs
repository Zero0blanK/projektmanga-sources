import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { allowlistedFetch } from '../scripts/allowlisted-fetch.mjs';

async function withServer(handler, run) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test('allowlisted redirects are followed and each hop is validated', async () => {
  await withServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/end' }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  }, async base => {
    const response = await allowlistedFetch(`${base}/start`, {}, ['127.0.0.1']);
    assert.equal(await response.text(), 'ok');
  });
});

test('disallowed redirect destinations are rejected before fetching them', async () => {
  await withServer((req, res) => res.writeHead(302, { location: 'http://example.invalid/private' }).end(), async base => {
    await assert.rejects(allowlistedFetch(base, {}, ['127.0.0.1']), /not in this source's allowlist/);
  });
});

test('redirect loops are bounded', async () => {
  await withServer((req, res) => res.writeHead(302, { location: req.url }).end(), async base => {
    await assert.rejects(allowlistedFetch(base, {}, ['127.0.0.1']), /Too many redirects/);
  });
});
