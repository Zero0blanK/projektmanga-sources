import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: "export { HttpClient } from './src/lib/http.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`;
const { HttpClient } = await import(moduleUrl);

test('HTTP timeouts abort the pending fetch and do not start an overlapping retry', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let aborted = false;
  globalThis.fetch = (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, { once: true });
    });
  };
  try {
    const client = new HttpClient({ sourceId: 'fixture', sourceName: 'Fixture', baseUrl: 'https://fixture.invalid', timeoutMs: 5, maxRetries: 3 });
    await assert.rejects(client.get('/slow'), error => error.code === 'TIMEOUT');
    assert.equal(calls, 1);
    assert.equal(aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});
