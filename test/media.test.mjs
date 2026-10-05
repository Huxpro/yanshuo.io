import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';

const port = await new Promise((resolve) => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1', () => {
    const free = listener.address().port;
    listener.close(() => resolve(free));
  });
});
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), 'yanshuo-media-'));
const persist = join(dir, 'state');
let server;
let owner;
let other;
let deckId;
let logs = '';

async function api(path, method, body, token) {
  const response = await fetch(`${base}/1.1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-LC-Session': token } : {}) },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'yanshuo', '--local', '--persist-to', persist], { stdio: 'ignore' });
  server = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  server.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  server.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) { ready = true; break; }
    } catch {}
    if (server.exitCode != null) throw new Error(`wrangler dev exited early:\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`wrangler dev did not start:\n${logs}`);
  owner = (await api('users', 'POST', { username: 'owner', password: 'secret' })).body;
  other = (await api('users', 'POST', { username: 'other', password: 'secret' })).body;
  deckId = (await api('classes/YSDeck', 'POST', { metadata: '{}' }, owner.sessionToken)).body.objectId;
  assert.match(deckId, /^[0-9a-f]{24}$/);
});

after(() => {
  if (server && server.exitCode == null) process.kill(-server.pid);
  rmSync(dir, { recursive: true, force: true });
});

test('media upload, list, and public byte-range read', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const upload = await fetch(`${base}/1.1/media?deckId=${deckId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-LC-Session': owner.sessionToken },
    body: bytes,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(upload.status, 201, `${await upload.clone().text()}\n${logs}`);
  const media = await upload.json();
  assert.match(media.objectId, /^[0-9a-f]{24}$/);
  assert.equal(media.bytes, bytes.length);
  assert.equal(media.url, `${base}/1.1/media/${media.objectId}`);

  const listing = await api(`media?deckId=${deckId}`, 'GET', null, owner.sessionToken);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.bytes, bytes.length);
  assert.deepEqual(listing.body.results.map((item) => item.objectId), [media.objectId]);

  const read = await fetch(media.url);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('Content-Type'), 'image/png');
  assert.equal(read.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);

  const head = await fetch(media.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(bytes.length));

  const range = await fetch(media.url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), `bytes 2-4/${bytes.length}`);
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(2, 5));

});

test('upload and library enforce owner, type, and declared size', async () => {
  const url = `${base}/1.1/media?deckId=${deckId}`;
  const body = Uint8Array.from([1, 2, 3, 4]);
  const post = (token, type, extra = {}) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': type, 'X-LC-Session': token, ...extra }, body,
  });
  assert.equal((await post(other.sessionToken, 'image/png')).status, 403);
  assert.equal((await api(`media?deckId=${deckId}`, 'GET', null, other.sessionToken)).status, 403);
  assert.equal((await post(owner.sessionToken, 'image/svg+xml')).status, 415);
  const mismatched = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-LC-Session': owner.sessionToken, 'X-Media-Bytes': '1' },
    body: new ReadableStream({ start(controller) { controller.enqueue(body); controller.close(); } }),
    duplex: 'half',
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mismatched.status, 400, `${await mismatched.clone().text()}\n${logs}`);
  const listing = await api(`media?deckId=${deckId}`, 'GET', null, owner.sessionToken);
  assert.equal(listing.body.results.length, 1);
  assert.equal(listing.body.bytes, 8);

  const mediaUrl = listing.body.results[0].url;
  assert.equal((await api(`classes/YSDeck/${deckId}`, 'DELETE', null, owner.sessionToken)).status, 200);
  assert.equal((await fetch(mediaUrl)).status, 404);
});

test('discarding an orphan upload is owner-only and releases quota once', async () => {
  const newDeck = (await api('classes/YSDeck', 'POST', { metadata: '{}' }, owner.sessionToken)).body;
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  const upload = await fetch(`${base}/1.1/media?deckId=${newDeck.objectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-LC-Session': owner.sessionToken },
    body: bytes,
  });
  assert.equal(upload.status, 201);
  const media = await upload.json();
  const remove = (token) => fetch(media.url, {
    method: 'DELETE',
    headers: token ? { 'X-LC-Session': token } : {},
  });
  assert.equal((await remove()).status, 401);
  assert.equal((await remove(other.sessionToken)).status, 403);
  assert.equal((await fetch(media.url)).status, 200);
  const removed = await Promise.all([remove(owner.sessionToken), remove(owner.sessionToken)]);
  assert.ok(removed.every((response) => [204, 404].includes(response.status)));
  assert.ok(removed.some((response) => response.status === 204));
  const listing = await api(`media?deckId=${newDeck.objectId}`, 'GET', null, owner.sessionToken);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.bytes, 0, 'concurrent delete releases the reservation only once');
  assert.deepEqual(listing.body.results, []);
  assert.equal((await fetch(media.url)).status, 404);
});

test('deleting a deck during a streamed upload cancels the media object', async () => {
  const newDeck = (await api('classes/YSDeck', 'POST', { metadata: '{}' }, owner.sessionToken)).body;
  const url = `${base}/1.1/media?deckId=${newDeck.objectId}`;
  const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  let send;
  const body = new ReadableStream({
    start(controller) {
      send = controller;
      controller.enqueue(bytes.slice(0, 1));
    },
  });
  const upload = fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'image/png',
      'X-LC-Session': owner.sessionToken,
      'X-Media-Bytes': String(bytes.length),
    },
    body,
    duplex: 'half',
  });
  let reserved = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const listing = await api(`media?deckId=${newDeck.objectId}`, 'GET', null, owner.sessionToken);
    if (listing.body.bytes === bytes.length) {
      reserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(reserved, `upload did not reserve space before deck deletion:\n${logs}`);
  assert.equal((await api(`classes/YSDeck/${newDeck.objectId}`, 'DELETE', null, owner.sessionToken)).status, 200);
  send.enqueue(bytes.slice(1));
  send.close();
  const response = await upload;
  assert.equal(response.status, 409, await response.text());
  assert.equal((await api(`media?deckId=${newDeck.objectId}`, 'GET', null, owner.sessionToken)).status, 404);
});
