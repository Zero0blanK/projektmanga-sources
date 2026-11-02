// Runs probe.mjs for every listed source, six at a time, each in its own process (the
// allowlisted fetch is global). Usage (cwd = projektmanga-sources): node scripts/keiyoushi/probe-all.mjs [keys…]
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.PROBE_OUT ?? path.join(HERE, 'probe-results.jsonl');
const index = JSON.parse(await (await import('node:fs/promises')).readFile('index.json', 'utf8'));
const all = (Array.isArray(index) ? index : index.sources).map((s) => s.source_key);
const keys = process.argv.slice(2).length ? process.argv.slice(2) : all;
writeFileSync(OUT, '');

function run(key) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'probe.mjs'), key], { cwd: process.cwd() });
    let out = '';
    let err = '';
    const kill = setTimeout(() => child.kill(), 15 * 60_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', () => {
      clearTimeout(kill);
      const line = out.trim().split('\n').pop() || JSON.stringify({ key, crashed: true, error: err.slice(-300) });
      appendFileSync(OUT, line + '\n');
      console.log(`done ${key}`);
      resolve();
    });
  });
}

const queue = [...keys];
await Promise.all(Array.from({ length: 6 }, async () => { while (queue.length) await run(queue.shift()); }));
console.log(`ALL DONE (${keys.length})`);
