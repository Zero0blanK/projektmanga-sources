// Fetches each site's own favicon and redraws it at 128x128 PNG (see THIRD_PARTY_NOTICES).
// Usage: node scripts/keiyoushi/icons.mjs <outDir> key=url ...   — writes <outDir>/<key>.png
// Uses sharp from the ProjektManga app checkout (PROJEKT_MANGA_APP_DIR, default ../ProjektManga).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
const appDir = process.env.PROJEKT_MANGA_APP_DIR ?? fileURLToPath(new URL('../../../ProjektManga/', import.meta.url));
const require = createRequire(`${appDir.replace(/[\\/]$/, '')}/package.json`);
const sharp = require('sharp');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const [outDir, ...pairs] = process.argv.slice(2);
await mkdir(outDir, { recursive: true });

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The largest PNG inside an .ico, or the whole buffer when it is not one. */
function fromIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return buf;
  let best = null;
  for (let i = 0; i < buf.readUInt16LE(4); i++) {
    const o = 6 + i * 16;
    const size = buf.readUInt32LE(o + 8), off = buf.readUInt32LE(o + 12);
    const w = buf[o] || 256;
    const data = buf.subarray(off, off + size);
    if (data.subarray(1, 4).toString() === 'PNG' && (!best || w > best.w)) best = { w, data };
  }
  if (!best) throw new Error('ico has no PNG entries');
  return best.data;
}

for (const pair of pairs) {
  const [key, base] = pair.split('=');
  const tried = [];
  try {
    let candidates = [];
    try {
      const html = (await get(base)).toString('utf8');
      for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
        const tag = m[0];
        const rel = /rel=["']([^"']+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
        const href = /href=["']([^"']+)/i.exec(tag)?.[1];
        if (!href || !rel.includes('icon')) continue;
        const size = Number(/sizes=["'](\d+)/i.exec(tag)?.[1] ?? (rel.includes('apple') ? 180 : 32));
        candidates.push({ url: new URL(href.replaceAll('&amp;', '&'), base).href, size });
      }
    } catch (e) {
      tried.push(`page: ${e.message}`);
    }
    candidates.sort((a, b) => b.size - a.size);
    candidates.push({ url: new URL('/apple-touch-icon.png', base).href }, { url: new URL('/favicon.ico', base).href });
    let done = false;
    for (const c of candidates) {
      try {
        const img = fromIco(await get(c.url));
        const meta = await sharp(img).metadata();
        await sharp(img, { density: 384 })
          .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toFile(`${outDir}/${key}.png`);
        console.log(`${key}: ok ${c.url} (${meta.format} ${meta.width}x${meta.height})`);
        done = true;
        break;
      } catch (e) {
        tried.push(`${c.url}: ${e.message}`);
      }
    }
    if (!done) console.log(`${key}: FAILED\n  ${tried.join('\n  ')}`);
  } catch (e) {
    console.log(`${key}: FAILED ${e.message}`);
  }
}
