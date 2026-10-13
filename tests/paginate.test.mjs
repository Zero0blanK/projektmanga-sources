import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: "export { collectPaged } from './src/lib/paginate.ts'; export { SourceError } from './src/lib/sourceError.ts';", resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`;
const { collectPaged, SourceError } = await import(moduleUrl);

test('pagination treats only later-page 404 as end-of-list', async () => {
  const result = await collectPaged({ limit: 10, offset: 0, sitePageSize: 3 }, async page => {
    if (page === 1) return [1, 2, 3];
    throw new SourceError('NOT_FOUND', 'missing', 'fixture');
  });
  assert.deepEqual(result, [1, 2, 3]);
});

test('pagination propagates later-page timeout, rate-limit, server, and parse errors', async () => {
  for (const [code, status] of [['TIMEOUT'], ['RATE_LIMITED', 429], ['UPSTREAM_ERROR', 503], ['PARSE_ERROR']]) {
    const error = new SourceError(code, code, 'fixture', { statusCode: status });
    await assert.rejects(collectPaged({ limit: 10, offset: 0, sitePageSize: 3 }, async page => {
      if (page === 1) return [1, 2, 3];
      throw error;
    }), value => value === error);
  }
});
