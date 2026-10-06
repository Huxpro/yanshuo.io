// Exercise media storage through the Worker API. Remote writes require both the
// exact isolated staging URL and an explicit opt-in; production is rejected.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const base = new URL(process.env.TARGET_URL || 'http://127.0.0.1:9281/');
const local = base.origin === 'http://127.0.0.1:9281';
const staging = base.origin === 'https://yanshuo-staging.huxpro.workers.dev';
assert.equal(base.pathname, '/');
assert.ok(
  local || (staging && process.env.ALLOW_STAGING === '1'),
  'Only localhost or explicitly allowed isolated staging may be tested',
);
const origin = base.origin;
const image = await readFile(
  new URL('../public/assets/images/icon_128x128@2x.png', import.meta.url),
);
const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const password = randomBytes(18).toString('base64url');

async function request(path, { method = 'GET', token, body, mime } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token ? { 'X-LC-Session': token } : {}),
      ...(body == null
        ? {}
        : mime
          ? { 'Content-Type': mime, 'X-Media-Bytes': String(body.length) }
          : { 'Content-Type': 'application/json' }),
    },
    ...(body == null ? {} : { body: mime ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  return response;
}

async function json(response, expected) {
  const text = await response.text();
  assert.equal(response.status, expected, `${response.url}: ${text}`);
  return text ? JSON.parse(text) : null;
}

const owner = await json(
  await request('1.1/users', {
    method: 'POST',
    body: { username: `media-smoke-${stamp}`, password },
  }),
  201,
);
const other = await json(
  await request('1.1/users', {
    method: 'POST',
    body: { username: `media-other-${stamp}`, password },
  }),
  201,
);
const deckIds = [];
let unadopted;
let passed = false;
try {
  const deck = await json(
    await request('1.1/classes/YSDeck', {
      method: 'POST',
      token: owner.sessionToken,
      body: { metadata: '{}' },
    }),
    201,
  );
  deckIds.push(deck.objectId);
  const uploaded = await json(
    await request(`1.1/media?deckId=${deck.objectId}`, {
      method: 'POST',
      token: owner.sessionToken,
      body: image,
      mime: 'image/png',
    }),
    201,
  );
  assert.equal(uploaded.url, `${origin}/1.1/media/${uploaded.objectId}`);
  assert.equal(uploaded.bytes, image.length);
  const list = await json(
    await request(`1.1/media?deckId=${deck.objectId}`, {
      token: owner.sessionToken,
    }),
    200,
  );
  assert.equal(list.bytes, image.length);
  assert.deepEqual(
    list.results.map((item) => item.objectId),
    [uploaded.objectId],
  );
  assert.equal(
    (
      await request(`1.1/media?deckId=${deck.objectId}`, {
        token: other.sessionToken,
      })
    ).status,
    403,
  );
  const publicImage = await request(`1.1/media/${uploaded.objectId}`);
  assert.equal(publicImage.status, 200);
  assert.equal(publicImage.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), image);
  const range = await fetch(`${origin}/1.1/media/${uploaded.objectId}`, {
    headers: { Range: 'bytes=2-4' },
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 2-4/${image.length}`);
  assert.deepEqual(
    Buffer.from(await range.arrayBuffer()),
    image.subarray(2, 5),
  );
  await json(
    await request(`1.1/media/${uploaded.objectId}`, {
      method: 'DELETE',
      token: owner.sessionToken,
    }),
    204,
  );
  assert.equal((await request(`1.1/media/${uploaded.objectId}`)).status, 404);
  const empty = await json(
    await request(`1.1/media?deckId=${deck.objectId}`, {
      token: owner.sessionToken,
    }),
    200,
  );
  assert.equal(empty.bytes, 0);

  unadopted = await json(
    await request('1.1/media/staged', {
      method: 'POST',
      token: owner.sessionToken,
      body: image,
      mime: 'image/png',
    }),
    201,
  );
  assert.equal(unadopted.url, `${origin}/1.1/media/${unadopted.objectId}`);
  assert.equal((await request(`1.1/media/${unadopted.objectId}`)).status, 404);
  const guestSyncId = randomUUID();
  const metadata = JSON.stringify({
    slides: [{ blocks: [{ type: 'IMG', src: unadopted.url }] }],
  });
  const payload = {
    metadata,
    stagedMediaIds: [unadopted.objectId],
    guestSyncId,
  };
  assert.equal(
    (
      await request('1.1/classes/YSDeck', {
        method: 'POST',
        token: other.sessionToken,
        body: payload,
      })
    ).status,
    409,
  );
  const adoptedDeck = await json(
    await request('1.1/classes/YSDeck', {
      method: 'POST',
      token: owner.sessionToken,
      body: payload,
    }),
    201,
  );
  deckIds.push(adoptedDeck.objectId);
  unadopted = null;
  assert.equal(
    (
      await request('1.1/classes/YSDeck', {
        method: 'POST',
        token: owner.sessionToken,
        body: payload,
      })
    ).status,
    409,
  );
  const where = encodeURIComponent(
    JSON.stringify({ pubUserId: owner.objectId, guestSyncId }),
  );
  const found = await json(
    await request(`1.1/classes/YSDeck?where=${where}`, {
      token: owner.sessionToken,
    }),
    200,
  );
  assert.deepEqual(
    found.results.map((item) => item.objectId),
    [adoptedDeck.objectId],
  );
  const adopted = await json(
    await request(`1.1/media?deckId=${adoptedDeck.objectId}`, {
      token: owner.sessionToken,
    }),
    200,
  );
  assert.deepEqual(
    adopted.results.map((item) => item.objectId),
    [payload.stagedMediaIds[0]],
  );
  assert.deepEqual(
    Buffer.from(
      await (
        await request(`1.1/media/${payload.stagedMediaIds[0]}`)
      ).arrayBuffer(),
    ),
    image,
  );
  await json(
    await request(`1.1/classes/YSDeck/${adoptedDeck.objectId}`, {
      method: 'DELETE',
      token: owner.sessionToken,
    }),
    200,
  );
  deckIds.pop();
  assert.equal(
    (await request(`1.1/media/${payload.stagedMediaIds[0]}`)).status,
    404,
  );
  passed = true;
  console.log(
    JSON.stringify({
      target: origin,
      directUpload: 'PASS',
      range: 'PASS',
      ownership: 'PASS',
      stagedPrivacy: 'PASS',
      adoption: 'PASS',
      idempotency: 'PASS',
      cleanup: 'PASS',
    }),
  );
} finally {
  const cleanupErrors = [];
  if (unadopted) {
    try {
      const response = await request(`1.1/media/staged/${unadopted.objectId}`, {
        method: 'DELETE',
        token: owner.sessionToken,
      });
      assert.ok(
        [204, 404].includes(response.status),
        `staged cleanup: ${response.status}`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const id of deckIds.reverse()) {
    try {
      const response = await request(`1.1/classes/YSDeck/${id}`, {
        method: 'DELETE',
        token: owner.sessionToken,
      });
      assert.equal(
        response.status,
        200,
        `deck cleanup ${id}: ${response.status}`,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    for (const error of cleanupErrors)
      console.error('Smoke cleanup failed:', error);
    if (passed) throw new Error('Smoke passed, but cleanup failed');
  }
}
