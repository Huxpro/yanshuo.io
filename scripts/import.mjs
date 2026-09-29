#!/usr/bin/env node
// Imports a LeanCloud export into the Cloudflare deployment (D1 + R2) through
// the Worker's admin endpoint. Safe to re-run: records are upserted by objectId.
//
//   ADMIN_TOKEN=... node scripts/import.mjs --target https://yanshuo.io \
//       --users export/_User.jsonl --decks export/YSDeck.jsonl
//
// --users / --decks accept files or directories and may be repeated. Files may
// be a JSON array, {"results": [...]}, or JSON Lines, i.e. both the console
// export and scripts/export-leancloud.mjs output.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: process.env.TARGET || 'http://127.0.0.1:8787' },
    token: { type: 'string', default: process.env.ADMIN_TOKEN },
    users: { type: 'string', multiple: true, default: [] },
    decks: { type: 'string', multiple: true, default: [] },
  },
});
if (!args.token) {
  console.error('Missing --token (or ADMIN_TOKEN).');
  process.exit(1);
}
const target = args.target.replace(/\/$/, '');

const users = args.users.flatMap(readRecords);
const decks = args.decks.flatMap(readRecords);

const noPassword = users.filter((u) => !u.password).length;
if (noPassword) {
  console.warn(`WARNING: ${noPassword}/${users.length} users have no password hash and will not be able to log in.`);
  console.warn('         Use the console export for _User; the REST API does not return password/salt.');
}

await upload('users', users, { maxCount: 200, maxBytes: 5e6 });
// Decks embed base64 media; keep each request well under the 100 MB limit.
await upload('decks', decks, { maxCount: 50, maxBytes: 40e6 });

const stats = await post('/__admin/stats', null, 'GET');
console.log(`Done. Server now has ${stats.users} users and ${stats.decks} decks.`);

async function upload(kind, records, { maxCount, maxBytes }) {
  let batch = [];
  let bytes = 0;
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    await post(`/__admin/import/${kind}`, { results: batch });
    done += batch.length;
    process.stdout.write(`\r${kind}: ${done}/${records.length}`);
    batch = [];
    bytes = 0;
  };
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (batch.length && (batch.length >= maxCount || bytes + size > maxBytes)) await flush();
    batch.push(record);
    bytes += size;
  }
  await flush();
  if (records.length) process.stdout.write('\n');
}

async function post(path, body, method = 'POST', attempt = 1) {
  const res = await fetch(target + path, {
    method,
    headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.ok) return JSON.parse(text);
  if (attempt < 4 && res.status >= 500) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return post(path, body, method, attempt + 1);
  }
  throw new Error(`${res.status} ${path}: ${text.slice(0, 500)}`);
}

function readRecords(path) {
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((f) => /\.(json|jsonl)$/.test(f))
      .sort()
      .flatMap((f) => readRecords(join(path, f)));
  }
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.results)) return data.results;
    return [data];
  } catch {
    return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
}
