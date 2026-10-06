// End-to-end test of the migration path: a fixture LeanCloud export is imported
// through scripts/import.mjs into a local `wrangler dev`, then exercised the way
// the front end and the player do.
//
//   npm test

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';

const PORT = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close((error) => (error ? reject(error) : resolve(port)));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'test-admin-token';
const VERSION_HISTORY_POLICIES = JSON.stringify({
  free: {
    maxVersionsPerDeck: 3,
    maxCriticalVersionsPerDeck: 3,
    maxNamedVersionsPerDeck: 3,
    maxPublishedVersionsPerDeck: 3,
    maxRestoreVersionsPerDeck: 3,
  },
  pro: { autoIntervalMs: 0 },
});
const dir = mkdtempSync(join(tmpdir(), 'yanshuo-test-'));
let server;

// LeanCloud's documented export hash (docs.leancloud.cn, NodeJS sample).
function leancloudHash(password, salt) {
  let value = createHash('sha512').update(salt).update(password).digest();
  for (let i = 0; i < 512; i++) value = createHash('sha512').update(value).digest();
  return value.toString('base64');
}

const legacyUser = {
  objectId: '5750f2a5a341310063a1b2c3',
  username: '老用户',
  email: 'old@example.com',
  emailVerified: false,
  salt: 'b6d0f0bd7a0b4f0b9e5e3c1a2d4f6a8c',
  password: leancloudHash('old-password', 'b6d0f0bd7a0b4f0b9e5e3c1a2d4f6a8c'),
  sessionToken: 'legacysessiontoken0000001',
  mobilePhoneVerified: false,
  ACL: { '*': { read: true, write: true } },
  createdAt: '2016-06-02T04:04:27.123Z',
  updatedAt: '2016-06-03T04:04:27.123Z',
};
const bigMetadata = JSON.stringify({
  __airtalk__: true,
  img: 'data:image/png;base64,' + 'A'.repeat(15e6),
});
const legacyDecks = [
  {
    objectId: '5750f2a5a341310063aaaaaa',
    pubUserId: legacyUser.objectId,
    metadata: bigMetadata,
    metaHTML: '<div id="YS" data-ys-title="老演说" data-ys-user="老用户"></div>',
    ACL: { '*': { read: true, write: true } },
    createdAt: { __type: 'Date', iso: '2016-07-01T00:00:00.000Z' },
    updatedAt: '2016-07-02T00:00:00.000Z',
  },
  {
    objectId: '5750f2a5a341310063bbbbbb',
    pubUserId: legacyUser.objectId,
    metadata: '{"__airtalk__":true}',
    createdAt: '2016-08-01T00:00:00.000Z',
    updatedAt: '2016-08-02T00:00:00.000Z',
  },
];

// Mimics LeanCloud JS SDK 0.6.x: POST + text/plain JSON with `_method`.
async function sdk(path, method, data = {}, sessionToken) {
  const body = {
    ...data,
    _ApplicationId: 'im99VNboLC4mtFOCDlR3q6hT-gzGzoHsz',
    _ApplicationKey: 'x',
  };
  if (method !== 'POST') body._method = method;
  if (sessionToken) body._SessionToken = sessionToken;
  const res = await fetch(`${BASE}/1.1/${path}?`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function sdkAfterLocalD1(path, method, data = {}, sessionToken) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await sdk(path, method, data, sessionToken);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

before(async () => {
  const persist = join(dir, 'state');
  execFileSync(
    'npx',
    ['wrangler', 'd1', 'migrations', 'apply', 'yanshuo', '--local', '--persist-to', persist],
    { stdio: 'ignore' },
  );
  writeFileSync(join(dir, 'users.json'), JSON.stringify({ results: [legacyUser] }));
  writeFileSync(join(dir, 'decks.jsonl'), legacyDecks.map((d) => JSON.stringify(d)).join('\n'));
  server = spawn(
    'npx',
    [
      'wrangler',
      'dev',
      '--port',
      String(PORT),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      persist,
      '--var',
      `ADMIN_TOKEN:${ADMIN_TOKEN}`,
      '--var',
      `VERSION_HISTORY_POLICIES:${VERSION_HISTORY_POLICIES}`,
      '--var',
      'ALLOW_DEV_PLAN_SWITCH:true',
    ],
    { stdio: 'ignore', detached: true },
  );
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

after(() => {
  if (server) process.kill(-server.pid);
  rmSync(dir, { recursive: true, force: true });
});

test('admin endpoints require the token', async () => {
  const res = await fetch(`${BASE}/__admin/stats`, {
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(res.status, 403);
});

test('import script loads the LeanCloud export', () => {
  const out = execFileSync(
    'node',
    [
      'scripts/import.mjs',
      '--target',
      BASE,
      '--token',
      ADMIN_TOKEN,
      '--users',
      join(dir, 'users.json'),
      '--decks',
      join(dir, 'decks.jsonl'),
    ],
    { encoding: 'utf8' },
  );
  assert.match(out, /1 users and 2 decks/);
  // Re-running is idempotent.
  const again = execFileSync(
    'node',
    [
      'scripts/import.mjs',
      '--target',
      BASE,
      '--token',
      ADMIN_TOKEN,
      '--users',
      join(dir, 'users.json'),
      '--decks',
      join(dir, 'decks.jsonl'),
    ],
    { encoding: 'utf8' },
  );
  assert.match(again, /1 users and 2 decks/);
});

test('an existing browser session keeps working (sessionToken preserved)', async () => {
  const res = await fetch(`${BASE}/1.1/users/me`, {
    headers: { 'X-LC-Session': legacyUser.sessionToken },
  });
  const me = await res.json();
  assert.equal(me.objectId, legacyUser.objectId);
  assert.equal(me.username, legacyUser.username);
  assert.equal(me.password, undefined);
  assert.equal(me.salt, undefined);
});

test('imported users log in with their LeanCloud password; hash gets upgraded', async () => {
  const bad = await sdk('login', 'GET', {
    username: legacyUser.username,
    password: 'nope',
  });
  assert.equal(bad.body.code, 210);

  const ok = await sdk('login', 'GET', {
    username: legacyUser.username,
    password: 'old-password',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.sessionToken, legacyUser.sessionToken);

  const row = JSON.parse(
    execFileSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'yanshuo',
        '--local',
        '--persist-to',
        join(dir, 'state'),
        '--json',
        '--command',
        `SELECT password_algo FROM users WHERE objectId = '${legacyUser.objectId}'`,
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.equal(row[0].results[0].password_algo, 'pbkdf2');

  // A separate local D1 command briefly restarts the dev Worker.
  const again = await sdkAfterLocalD1('login', 'GET', {
    username: legacyUser.username,
    password: 'old-password',
  });
  assert.equal(again.status, 200);
});

test('old share links still open in the player', async () => {
  const res = await fetch(`${BASE}/1.1/classes/YSDeck/${legacyDecks[0].objectId}?keys=metaHTML`);
  const deck = await res.json();
  assert.equal(deck.metaHTML, legacyDecks[0].metaHTML);
  assert.equal(deck.metadata, undefined);
  assert.equal((await fetch(`${BASE}/assets/player/?deck=${legacyDecks[0].objectId}`)).status, 200);
});

test("dashboard lists the user's decks, newest first, with full (15 MB) bodies", async () => {
  const { body } = await sdk(
    'classes/YSDeck',
    'GET',
    { where: { pubUserId: legacyUser.objectId }, order: '-updatedAt' },
    legacyUser.sessionToken,
  );
  assert.deepEqual(
    body.results.map((d) => d.objectId),
    [legacyDecks[1].objectId, legacyDecks[0].objectId],
  );
  assert.equal(body.results[1].metadata, bigMetadata);
  assert.equal(body.results[1].createdAt, '2016-07-01T00:00:00.000Z');
});

test("listing someone else's decks is refused", async () => {
  const other = await sdk('users', 'POST', {
    username: 'mallory',
    password: 'x',
    email: 'm@example.com',
  });
  assert.equal(other.status, 201);
  const res = await sdk(
    'classes/YSDeck',
    'GET',
    { where: { pubUserId: legacyUser.objectId } },
    other.body.sessionToken,
  );
  assert.equal(res.status, 403);
  const put = await sdk(
    `classes/YSDeck/${legacyDecks[0].objectId}`,
    'PUT',
    { metaHTML: 'pwned' },
    other.body.sessionToken,
  );
  assert.equal(put.status, 403);
});

test('version history is private, ordered, projected, and restorable by id', async () => {
  const token = legacyUser.sessionToken;
  const firstMetadata = JSON.stringify({
    title: '第一稿',
    slides: [{ id: 1 }],
  });
  const first = await sdk(
    'classes/YSDeckVersion',
    'POST',
    {
      pubUserId: legacyUser.objectId,
      deckId: legacyDecks[0].objectId,
      metadata: firstMetadata,
      hash: 'first',
      name: '客户确认稿',
      reason: 'named',
      authorName: legacyUser.username,
      title: '第一稿',
      slideCount: 1,
    },
    token,
  );
  assert.equal(first.status, 201);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await sdk(
    'classes/YSDeckVersion',
    'POST',
    {
      deckId: legacyDecks[0].objectId,
      metadata: JSON.stringify({ title: '第二稿', slides: [] }),
      hash: 'second',
      reason: 'published',
    },
    token,
  );
  assert.equal(second.status, 201);

  const where = {
    pubUserId: legacyUser.objectId,
    deckId: legacyDecks[0].objectId,
  };
  assert.equal((await sdk('classes/YSDeckVersion', 'GET', { where })).status, 401);
  const mallory = await sdk('login', 'GET', {
    username: 'mallory',
    password: 'x',
  });
  assert.equal((await sdk('classes/YSDeckVersion', 'GET', { where }, mallory.body.sessionToken)).status, 403);

  const listed = await sdk(
    'classes/YSDeckVersion',
    'GET',
    {
      where,
      order: '-createdAt',
      keys: 'deckId,hash,name,reason,authorName,title,slideCount',
    },
    token,
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.results.map((version) => version.hash),
    ['second', 'first'],
  );
  assert.equal(
    listed.body.results[1].metadata,
    undefined,
    'list projections do not download snapshot bodies',
  );
  assert.equal(listed.body.results[1].title, '第一稿');

  const selected = await sdk(
    'classes/YSDeckVersion',
    'GET',
    { where: { ...where, objectId: first.body.objectId }, limit: 1 },
    token,
  );
  assert.equal(selected.body.results.length, 1);
  assert.equal(selected.body.results[0].metadata, firstMetadata);

  assert.equal((await sdk(`classes/YSDeckVersion/${first.body.objectId}`, 'GET')).status, 401);
  assert.equal(
    (await sdk(`classes/YSDeckVersion/${first.body.objectId}`, 'GET', {}, mallory.body.sessionToken)).status,
    403,
  );
  const fetched = await sdk(`classes/YSDeckVersion/${first.body.objectId}`, 'GET', {}, token);
  assert.equal(fetched.body.metadata, firstMetadata);
  assert.equal((await sdk(`classes/YSDeckVersion/${first.body.objectId}`, 'DELETE', {}, token)).status, 200);
  assert.equal((await sdk(`classes/YSDeckVersion/${first.body.objectId}`, 'GET', {}, token)).status, 404);
});

test('free keeps critical versions with LRU, while dev tiers control automatic history', async () => {
  const token = legacyUser.sessionToken;
  const policy = await sdk('classes/YSDeckVersionPolicy', 'GET', {}, token);
  assert.equal(policy.status, 200);
  assert.equal(policy.body.results[0].plan, 'free');
  assert.equal(policy.body.results[0].autoEnabled, false);
  assert.equal(policy.body.results[0].maxVersionsPerDeck, 3);

  const attemptedUpgrade = await sdk('users', 'POST', {
    username: 'quota-hacker',
    password: 'x',
    plan: 'pro',
  });
  const attemptedPolicy = await sdk(
    'classes/YSDeckVersionPolicy',
    'GET',
    {},
    attemptedUpgrade.body.sessionToken,
  );
  assert.equal(attemptedPolicy.body.results[0].plan, 'free');

  const createdDeck = await sdk(
    'classes/YSDeck',
    'POST',
    { pubUserId: legacyUser.objectId, metadata: '{"title":"policy"}' },
    token,
  );
  const deckId = createdDeck.body.objectId;
  const automatic = await sdk(
    'classes/YSDeckVersion',
    'POST',
    { deckId, metadata: '{"auto":true}', reason: 'auto' },
    token,
  );
  assert.equal(automatic.status, 403, 'Free never stores automatic cloud history');

  for (const [index, reason] of ['named', 'published', 'named'].entries()) {
    const saved = await sdk(
      'classes/YSDeckVersion',
      'POST',
      {
        deckId,
        metadata: JSON.stringify({ index }),
        hash: String(index),
        reason,
        name: reason === 'named' ? `n${index}` : '',
      },
      token,
    );
    assert.equal(saved.status, 201);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // Touch the oldest version. The middle version is now least recently used.
  const where = { pubUserId: legacyUser.objectId, deckId };
  const before = await sdk('classes/YSDeckVersion', 'GET', { where, order: 'createdAt' }, token);
  const oldest = before.body.results[0];
  const middle = before.body.results[1];
  await sdk(`classes/YSDeckVersion/${oldest.objectId}`, 'GET', {}, token);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(
    (
      await sdk(
        'classes/YSDeckVersion',
        'POST',
        {
          deckId,
          metadata: '{"published":true}',
          hash: 'published',
          reason: 'published',
        },
        token,
      )
    ).status,
    201,
  );

  const listed = await sdk('classes/YSDeckVersion', 'GET', { where, order: '-createdAt' }, token);
  assert.equal(listed.body.results.length, 3);
  assert.ok(listed.body.results.some((version) => version.objectId === oldest.objectId));
  assert.ok(!listed.body.results.some((version) => version.objectId === middle.objectId));

  const withUsage = await sdk('classes/YSDeckVersionPolicy', 'GET', { where: { deckId } }, token);
  assert.equal(withUsage.body.results[0].usage.deck.critical, 3);

  const switched = await sdk('classes/YSDeckVersionPolicy/current', 'PUT', { plan: 'pro' }, token);
  assert.equal(switched.status, 200);
  assert.equal((await sdk('classes/YSDeckVersionPolicy', 'GET', {}, token)).body.results[0].plan, 'pro');
  assert.equal(
    (
      await sdk(
        'classes/YSDeckVersion',
        'POST',
        { deckId, metadata: '{"auto":"pro"}', reason: 'auto' },
        token,
      )
    ).status,
    201,
  );
});

test('owner can save a large deck, publish, and delete', async () => {
  const token = legacyUser.sessionToken;
  const huge = 'x'.repeat(30e6);
  const created = await sdk(
    'classes/YSDeck',
    'POST',
    { pubUserId: legacyUser.objectId, metadata: huge },
    token,
  );
  assert.equal(created.status, 201);
  const id = created.body.objectId;
  assert.match(id, /^[0-9a-f]{24}$/);
  const version = await sdk(
    'classes/YSDeckVersion',
    'POST',
    { deckId: id, metadata: '{"title":"before delete"}', reason: 'named' },
    token,
  );
  assert.equal(version.status, 201);

  const published = await sdk(`classes/YSDeck/${id}`, 'PUT', { metaHTML: '<div id="YS"></div>' }, token);
  assert.equal(published.status, 200);
  const fetched = await (await fetch(`${BASE}/1.1/classes/YSDeck/${id}`)).json();
  assert.equal(fetched.metadata.length, huge.length);
  assert.equal(fetched.metaHTML, '<div id="YS"></div>');

  assert.equal((await sdk(`classes/YSDeck/${id}`, 'DELETE', {}, token)).status, 200);
  assert.equal((await fetch(`${BASE}/1.1/classes/YSDeck/${id}`)).status, 404);
  assert.equal((await sdk(`classes/YSDeckVersion/${version.body.objectId}`, 'GET', {}, token)).status, 404);
});
