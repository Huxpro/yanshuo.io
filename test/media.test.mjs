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
  server = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--test-scheduled'], {
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

test('guest media is staged before deck creation and adopted only by its owner', async () => {
  const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 4, 3, 2, 1]);
  const stage = await fetch(`${base}/1.1/media/staged`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-LC-Session': owner.sessionToken },
    body: bytes,
  });
  assert.equal(stage.status, 201, await stage.clone().text());
  const item = await stage.json();
  assert.equal((await fetch(item.url)).status, 404, 'staged media is not public before adoption');
  const metadata = JSON.stringify({ slides: [{ blocks: [{ type: 'IMG', src: item.url }] }] });
  const guestSyncId = crypto.randomUUID();
  const payload = { metadata, stagedMediaIds: [item.objectId], guestSyncId };
  assert.equal((await api('classes/YSDeck', 'POST', payload, other.sessionToken)).status, 409);
  assert.equal((await api('classes/YSDeck', 'POST', { metadata: '{}', stagedMediaIds: [item.objectId] }, owner.sessionToken)).status, 400);
  const created = await api('classes/YSDeck', 'POST', payload, owner.sessionToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const adopted = await api(`media?deckId=${created.body.objectId}`, 'GET', null, owner.sessionToken);
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.bytes, bytes.length);
  assert.deepEqual(adopted.body.results.map((row) => row.objectId), [item.objectId]);
  assert.deepEqual(new Uint8Array(await (await fetch(item.url)).arrayBuffer()), bytes);
  const saved = await api(`classes/YSDeck/${created.body.objectId}`, 'GET', null, owner.sessionToken);
  assert.equal(saved.body.metadata, metadata);
  assert.equal(saved.body.guestSyncId, guestSyncId);
  assert.equal(saved.body.stagedMediaIds, undefined);
  const duplicate = await api('classes/YSDeck', 'POST', payload, owner.sessionToken);
  assert.equal(duplicate.status, 409, 'retrying an ambiguous create cannot duplicate the deck');
  assert.equal(duplicate.body.code, 409);
  const where = encodeURIComponent(JSON.stringify({ pubUserId: owner.objectId, guestSyncId }));
  const found = await api(`classes/YSDeck?where=${where}`, 'GET', null, owner.sessionToken);
  assert.deepEqual(found.body.results.map((deck) => deck.objectId), [created.body.objectId]);
  assert.equal((await api(`classes/YSDeck?where=${where}`, 'GET', null, other.sessionToken)).status, 403);
  assert.equal((await api(`classes/YSDeck/${created.body.objectId}`, 'DELETE', null, owner.sessionToken)).status, 200);
  assert.equal((await fetch(item.url)).status, 404);
});

test('concurrent retries of one guest sync create at most one deck', async () => {
  const guestSyncId = crypto.randomUUID();
  const payload = { metadata: '{}', guestSyncId };
  const results = await Promise.all([
    api('classes/YSDeck', 'POST', payload, owner.sessionToken),
    api('classes/YSDeck', 'POST', payload, owner.sessionToken),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const where = encodeURIComponent(JSON.stringify({ pubUserId: owner.objectId, guestSyncId }));
  const found = await api(`classes/YSDeck?where=${where}`, 'GET', null, owner.sessionToken);
  assert.equal(found.body.results.length, 1);
});

test('a failed guest sync can discard its staged media without touching another owner', async () => {
  const upload = await fetch(`${base}/1.1/media/staged`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-LC-Session': owner.sessionToken },
    body: Uint8Array.from([1, 2, 3]),
  });
  assert.equal(upload.status, 201);
  const item = await upload.json();
  const remove = (token) => fetch(`${base}/1.1/media/staged/${item.objectId}`, {
    method: 'DELETE',
    headers: token ? { 'X-LC-Session': token } : {},
  });
  assert.equal((await remove(other.sessionToken)).status, 403);
  assert.equal((await remove(owner.sessionToken)).status, 204);
  assert.equal((await remove(owner.sessionToken)).status, 404);
  assert.equal((await api('classes/YSDeck', 'POST', {
    metadata: JSON.stringify({ image: item.url }), stagedMediaIds: [item.objectId],
  }, owner.sessionToken)).status, 409);
});

test('scheduled cleanup expires unadopted staged media', async () => {
  const upload = await fetch(`${base}/1.1/media/staged`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png', 'X-LC-Session': owner.sessionToken },
    body: Uint8Array.from([9, 8, 7]),
  });
  assert.equal(upload.status, 201);
  const item = await upload.json();
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'yanshuo', '--local', '--persist-to', persist,
    '--command', `UPDATE staged_media SET createdAt = '2020-01-01T00:00:00.000Z' WHERE objectId = '${item.objectId}'`],
  { stdio: 'ignore' });
  const scheduled = await fetch(`${base}/cdn-cgi/local/scheduled?format=json`);
  assert.equal(scheduled.status, 200, await scheduled.text());
  assert.equal((await api('classes/YSDeck', 'POST', {
    metadata: JSON.stringify({ image: item.url }), stagedMediaIds: [item.objectId],
  }, owner.sessionToken)).status, 409);
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
