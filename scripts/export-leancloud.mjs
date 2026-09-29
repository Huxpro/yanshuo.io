#!/usr/bin/env node
// Exports LeanCloud classes as JSON Lines using the REST "scan" API.
//
//   node scripts/export-leancloud.mjs --master-key <MASTER_KEY> [--out export]
//
// Options (or the matching env vars):
//   --app-id      LC_APP_ID      default: yanshuo.io's app id
//   --master-key  LC_MASTER_KEY  required (console > 设置 > 应用凭证)
//   --server      LC_SERVER      default: https://<first 8 chars of app id>.lc-cn-n1-shared.com
//   --classes     default: _User,YSDeck
//   --out         default: ./export
//   --limit       objects per page, default 100 (decks embed media and are large)
//
// NOTE: the REST API never returns `password`/`salt`, so `_User` exported this
// way cannot log in after the migration. Use the console export for `_User`
// (数据存储 > 导入导出 > 导出) and this script as a fallback / for YSDeck.
// The app must not be archived: restore it in the console first.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'app-id': { type: 'string', default: process.env.LC_APP_ID || 'im99VNboLC4mtFOCDlR3q6hT-gzGzoHsz' },
    'master-key': { type: 'string', default: process.env.LC_MASTER_KEY },
    server: { type: 'string', default: process.env.LC_SERVER },
    classes: { type: 'string', default: '_User,YSDeck' },
    out: { type: 'string', default: 'export' },
    limit: { type: 'string', default: '100' },
  },
});

const appId = args['app-id'];
const masterKey = args['master-key'];
if (!masterKey) {
  console.error('Missing --master-key (or LC_MASTER_KEY).');
  process.exit(1);
}
const server = (args.server || `https://${appId.slice(0, 8).toLowerCase()}.lc-cn-n1-shared.com`).replace(/\/$/, '');
mkdirSync(args.out, { recursive: true });

for (const className of args.classes.split(',').map((s) => s.trim()).filter(Boolean)) {
  const file = join(args.out, `${className}.jsonl`);
  const out = createWriteStream(file);
  let cursor = null;
  let total = 0;
  do {
    const url = new URL(`${server}/1.1/scan/classes/${encodeURIComponent(className)}`);
    url.searchParams.set('limit', args.limit);
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await request(url);
    for (const obj of page.results) out.write(JSON.stringify(obj) + '\n');
    total += page.results.length;
    cursor = page.cursor;
    process.stdout.write(`\r${className}: ${total}`);
  } while (cursor);
  await new Promise((resolve) => out.end(resolve));
  console.log(` -> ${file}`);
}

async function request(url, attempt = 1) {
  const res = await fetch(url, { headers: { 'X-LC-Id': appId, 'X-LC-Key': `${masterKey},master` } });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  if (attempt < 5 && (res.status >= 500 || res.status === 429)) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return request(url, attempt + 1);
  }
  throw new Error(`${res.status} ${url}: ${JSON.stringify(body)}`);
}
