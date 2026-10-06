// yanshuo.io on Cloudflare Workers.
//
// Static files in ./public are served by Workers Static Assets. This Worker
// only handles:
//
//   /1.1/*      A small, wire-compatible subset of the LeanCloud REST API, so
//               the compiled front end (which bundles the LeanCloud JS SDK
//               0.6.10) keeps working with nothing but its server URL changed.
//   /__admin/*  Bulk import of the LeanCloud export. Disabled unless the
//               ADMIN_TOKEN secret is set.
//
// Only what yanshuo.io uses is implemented: sign up, log in, public cloud
// decks and their owner-only version history.

import { hashPassword, verifyPassword } from './password.js';

const DECK_CLASS = 'YSDeck';
const VERSION_CLASS = 'YSDeckVersion';
// Deck fields kept in R2 rather than D1 (they embed base64 images/videos).
const BLOB_FIELDS = new Set(['metadata', 'metaHTML']);
const RESERVED_FIELDS = new Set(['objectId', 'createdAt', 'updatedAt', 'ACL']);
const MAX_QUERY_LIMIT = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/1.1/')) return await handleApi(request, env, url);
      if (url.pathname.startsWith('/__admin/')) return await handleAdmin(request, env, url);
    } catch (err) {
      if (err instanceof LCError) return json({ code: err.code, error: err.message }, err.status);
      console.error(err);
      return json({ code: 1, error: 'Internal server error.' }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

class LCError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = () => new LCError(404, 101, 'Object not found.');
const forbidden = (msg = 'Forbidden.') => new LCError(403, 403, msg);
const loginRequired = () => new LCError(401, 403, 'Please log in first.');

// ---------------------------------------------------------------------------
// LeanCloud REST API subset
// ---------------------------------------------------------------------------

async function handleApi(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  const req = await parseApiRequest(request, url);
  const path = url.pathname.slice('/1.1/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  req.user = await findUserBySession(env, req.sessionToken);

  // e.g. "PUT classes/YSDeck/:id", "GET users/me", "POST login"
  let route = `${req.method} ${path[0]}`;
  if (path[0] === 'classes') route += `/${path[1]}${path.length > 2 ? '/:id' : ''}`;
  else if (path.length > 1) route += path[1] === 'me' ? '/me' : '/:id';

  switch (route) {
    case `GET classes/${DECK_CLASS}`: return queryDecks(env, req);
    case `POST classes/${DECK_CLASS}`: return createDeck(env, req);
    case `GET classes/${DECK_CLASS}/:id`: return getDeck(env, req, path[2]);
    case `PUT classes/${DECK_CLASS}/:id`: return updateDeck(env, req, path[2]);
    case `DELETE classes/${DECK_CLASS}/:id`: return deleteDeck(env, req, path[2]);
    case `GET classes/${VERSION_CLASS}`: return queryVersions(env, req);
    case `POST classes/${VERSION_CLASS}`: return createVersion(env, req);
    case `GET classes/${VERSION_CLASS}/:id`: return getVersion(env, req, path[2]);
    case `DELETE classes/${VERSION_CLASS}/:id`: return deleteVersion(env, req, path[2]);
    case 'POST users': return signUp(env, req);
    case 'GET login':
    case 'POST login': return logIn(env, req);
    case 'GET users/me': return me(req);
    case 'GET date': return json({ __type: 'Date', iso: new Date().toISOString() });
  }
  throw new LCError(403, 119, 'The operation is not supported.');
}

// The LeanCloud JS SDK 0.6.x sends every request as `POST` with a text/plain
// JSON body carrying `_method`, `_ApplicationId`, `_SessionToken`, ... .
// Plain REST calls (real HTTP verbs, X-LC-Session header, query string) are
// accepted as well.
async function parseApiRequest(request, url) {
  let method = request.method.toUpperCase();
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new LCError(400, 107, 'Malformed json object. A json dictionary is expected.');
      }
    }
  }
  if (typeof body._method === 'string') method = body._method.toUpperCase();

  const data = {};
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('_')) data[key] = value;
  }
  const params = { ...data };
  for (const [key, value] of url.searchParams) params[key] = value;

  const sessionToken =
    body._SessionToken ||
    request.headers.get('X-LC-Session') ||
    request.headers.get('X-AVOSCloud-Session-Token') ||
    null;
  return { method, data, params, sessionToken };
}

// --- users -----------------------------------------------------------------

async function findUserBySession(env, token) {
  if (!token || typeof token !== 'string') return null;
  return env.DB.prepare('SELECT * FROM users WHERE sessionToken = ?').bind(token).first();
}

async function signUp(env, { data }) {
  const { username, password, email } = data;
  if (typeof username !== 'string' || !username) throw new LCError(400, 200, 'Username is missing or empty.');
  if (typeof password !== 'string' || !password) throw new LCError(400, 201, 'Password is missing or empty.');
  if (email != null && (typeof email !== 'string' || !isEmail(email))) {
    throw new LCError(400, 125, 'The email address was invalid.');
  }
  if (data.authData || data.sessionToken || data.emailVerified) throw forbidden();

  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) {
    throw new LCError(400, 202, 'Username has already been taken.');
  }
  if (email && (await env.DB.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').bind(email).first())) {
    throw new LCError(400, 203, 'This email address has already been taken.');
  }

  const extra = {};
  for (const [key, value] of Object.entries(data)) {
    if (!['username', 'password', 'email'].includes(key) && !RESERVED_FIELDS.has(key)) extra[key] = value;
  }
  const pw = await hashPassword(password);
  const now = new Date().toISOString();
  const user = {
    objectId: newObjectId(),
    sessionToken: newSessionToken(),
    createdAt: now,
  };
  try {
    await env.DB.prepare(
      `INSERT INTO users (objectId, username, email, password_algo, password_hash, password_salt,
                          sessionToken, extra, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(user.objectId, username, email || null, pw.algo, pw.hash, pw.salt, user.sessionToken,
        JSON.stringify(extra), now, now)
      .run();
  } catch (err) {
    // Lost a race against a concurrent sign-up.
    if (String(err).includes('UNIQUE')) throw new LCError(400, 202, 'Username has already been taken.');
    throw err;
  }
  return json(user, 201);
}

async function logIn(env, { data }) {
  const { username, email, password } = data;
  let row = null;
  if (typeof username === 'string' && username) {
    row = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  } else if (typeof email === 'string' && email) {
    row = await env.DB.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').bind(email).first();
  } else {
    throw new LCError(400, 200, 'Username is missing or empty.');
  }
  if (!row) throw new LCError(400, 211, 'Could not find user.');
  if (!(await verifyPassword(password, row))) {
    throw new LCError(401, 210, 'The username and password mismatch.');
  }

  const updates = {};
  if (row.password_algo !== 'pbkdf2') {
    const pw = await hashPassword(password);
    Object.assign(updates, { password_algo: pw.algo, password_hash: pw.hash, password_salt: pw.salt });
  }
  if (!row.sessionToken) updates.sessionToken = newSessionToken();
  if (Object.keys(updates).length) {
    const cols = Object.keys(updates);
    await env.DB.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE objectId = ?`)
      .bind(...cols.map((c) => updates[c]), row.objectId)
      .run();
    Object.assign(row, updates);
  }
  return json(userToJSON(row));
}

function me({ user }) {
  if (!user) throw new LCError(400, 211, 'Could not find user.');
  return json(userToJSON(user));
}

function userToJSON(row) {
  return {
    ...JSON.parse(row.extra || '{}'),
    objectId: row.objectId,
    username: row.username,
    ...(row.email ? { email: row.email } : {}),
    emailVerified: !!row.emailVerified,
    sessionToken: row.sessionToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- decks -----------------------------------------------------------------

async function getDeckRow(env, id) {
  return env.DB.prepare('SELECT * FROM decks WHERE objectId = ?').bind(id).first();
}

// Anyone may read a deck by id: that is how shared links
// (/assets/player/?deck=<id>) work.
async function getDeck(env, { params }, id) {
  const row = await getDeckRow(env, id);
  if (!row) throw notFound();
  return json(await deckToJSON(env, row, parseKeys(params.keys)));
}

async function createDeck(env, { user, data }) {
  if (!user) throw loginRequired();
  if (data.pubUserId != null && data.pubUserId !== user.objectId) throw forbidden();
  const now = new Date().toISOString();
  const row = { objectId: newObjectId(), pubUserId: user.objectId, blob_fields: '[]', extra: '{}', createdAt: now, updatedAt: now };
  applyDeckChanges(row, data);
  await putBlobs(env, row.objectId, data);
  await env.DB.prepare(
    'INSERT INTO decks (objectId, pubUserId, blob_fields, extra, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(row.objectId, row.pubUserId, row.blob_fields, row.extra, row.createdAt, row.updatedAt)
    .run();
  return json({ objectId: row.objectId, createdAt: now, updatedAt: now }, 201);
}

async function updateDeck(env, { user, data }, id) {
  if (!user) throw loginRequired();
  const row = await getDeckRow(env, id);
  if (!row) throw notFound();
  if (row.pubUserId !== user.objectId) throw forbidden('Forbidden to update by ACL.');
  if ('pubUserId' in data && data.pubUserId !== user.objectId) throw forbidden();

  applyDeckChanges(row, data);
  row.updatedAt = new Date().toISOString();
  await putBlobs(env, id, data);
  await env.DB.prepare('UPDATE decks SET blob_fields = ?, extra = ?, updatedAt = ? WHERE objectId = ?')
    .bind(row.blob_fields, row.extra, row.updatedAt, id)
    .run();
  return json({ objectId: id, updatedAt: row.updatedAt });
}

async function deleteDeck(env, { user }, id) {
  if (!user) throw loginRequired();
  const row = await getDeckRow(env, id);
  if (!row) return json({});
  if (row.pubUserId !== user.objectId) throw forbidden('Forbidden to delete by ACL.');
  const { results: versions } = await env.DB.prepare('SELECT objectId FROM deck_versions WHERE deckId = ?').bind(id).all();
  await env.DB.prepare('DELETE FROM decks WHERE objectId = ?').bind(id).run();
  const blobs = JSON.parse(row.blob_fields).map((f) => blobKey(id, f));
  blobs.push(...versions.map((version) => versionBlobKey(version.objectId)));
  for (let i = 0; i < blobs.length; i += 1000) await env.BUCKET.delete(blobs.slice(i, i + 1000));
  return json({});
}

// Supports what the app and SDK send: equality on `objectId` (AV.Query#get)
// or on `pubUserId` (the dashboard's "my decks" list), plus order / limit /
// skip / keys / count. Listing is restricted to the caller's own decks.
async function queryDecks(env, { user, params }) {
  let where = params.where ?? {};
  if (typeof where === 'string') {
    try {
      where = JSON.parse(where);
    } catch {
      throw new LCError(400, 107, 'Malformed where.');
    }
  }
  const conds = [];
  const binds = [];
  for (const [key, value] of Object.entries(where || {})) {
    const v = value && typeof value === 'object' && '$eq' in value ? value.$eq : value;
    if (!['objectId', 'pubUserId'].includes(key) || typeof v !== 'string') {
      throw new LCError(400, 1, `Unsupported query on "${key}".`);
    }
    conds.push(`${key} = ?`);
    binds.push(v);
  }
  if (!('objectId' in (where || {}))) {
    const owner = where?.pubUserId?.$eq ?? where?.pubUserId;
    if (!user || owner !== user.objectId) throw forbidden('Only your own decks can be listed.');
  }

  const order = parseOrder(params.order);
  const limit = Math.min(Math.max(parseInt(params.limit ?? '100', 10) || 0, 0), MAX_QUERY_LIMIT);
  const skip = Math.max(parseInt(params.skip ?? '0', 10) || 0, 0);
  const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const result = {};
  if (limit > 0) {
    const { results } = await env.DB.prepare(`SELECT * FROM decks ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .bind(...binds, limit, skip)
      .all();
    const keys = parseKeys(params.keys);
    result.results = await Promise.all(results.map((row) => deckToJSON(env, row, keys)));
  } else {
    result.results = [];
  }
  if (params.count == 1) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM decks ${whereSql}`).bind(...binds).first();
    result.count = row.n;
  }
  return json(result);
}

function parseOrder(order) {
  if (!order) return 'createdAt ASC';
  return String(order)
    .split(',')
    .map((part) => {
      const desc = part.startsWith('-');
      const field = desc ? part.slice(1) : part;
      if (!['createdAt', 'updatedAt', 'objectId'].includes(field)) {
        throw new LCError(400, 1, `Unsupported order on "${field}".`);
      }
      return `${field} ${desc ? 'DESC' : 'ASC'}`;
    })
    .join(', ');
}

function parseKeys(keys) {
  if (!keys) return null;
  return new Set(String(keys).split(',').map((k) => k.trim()).filter(Boolean));
}

// Applies a LeanCloud-style change set to a deck row (in memory). Blob field
// contents are written separately by putBlobs().
function applyDeckChanges(row, data) {
  const extra = JSON.parse(row.extra);
  const blobs = new Set(JSON.parse(row.blob_fields));
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_FIELDS.has(key)) continue;
    const isDelete = value && typeof value === 'object' && value.__op === 'Delete';
    if (value && typeof value === 'object' && value.__op && !isDelete) {
      throw new LCError(400, 1, `Unsupported operation "${value.__op}".`);
    }
    if (key === 'pubUserId') continue; // owner is fixed at creation
    if (BLOB_FIELDS.has(key)) {
      if (isDelete || value == null) blobs.delete(key);
      else blobs.add(key);
    } else if (isDelete) {
      delete extra[key];
    } else {
      extra[key] = value;
    }
  }
  row.extra = JSON.stringify(extra);
  row.blob_fields = JSON.stringify([...blobs].sort());
}

async function putBlobs(env, id, data) {
  const puts = [];
  const deletes = [];
  for (const field of BLOB_FIELDS) {
    if (!(field in data)) continue;
    const value = data[field];
    if (value == null || value.__op === 'Delete') {
      deletes.push(blobKey(id, field));
    } else if (typeof value === 'string') {
      puts.push(env.BUCKET.put(blobKey(id, field), value, { customMetadata: { type: 'string' } }));
    } else {
      puts.push(env.BUCKET.put(blobKey(id, field), JSON.stringify(value), { customMetadata: { type: 'json' } }));
    }
  }
  if (deletes.length) puts.push(env.BUCKET.delete(deletes));
  await Promise.all(puts);
}

async function deckToJSON(env, row, keys) {
  const want = (k) => !keys || keys.has(k);
  const out = { objectId: row.objectId, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (row.pubUserId != null && want('pubUserId')) out.pubUserId = row.pubUserId;
  for (const [key, value] of Object.entries(JSON.parse(row.extra))) {
    if (want(key)) out[key] = value;
  }
  await Promise.all(
    JSON.parse(row.blob_fields)
      .filter(want)
      .map(async (field) => {
        const obj = await env.BUCKET.get(blobKey(row.objectId, field));
        if (!obj) return;
        const text = await obj.text();
        out[field] = obj.customMetadata?.type === 'json' ? JSON.parse(text) : text;
      }),
  );
  return out;
}

const blobKey = (id, field) => `decks/${id}/${field}`;

// --- private deck versions -------------------------------------------------

const VERSION_FIELDS = new Set(['hash', 'name', 'reason', 'authorId', 'authorName', 'title', 'slideCount']);
const versionBlobKey = (id) => `versions/${id}/metadata`;

async function getVersionRow(env, id) {
  return env.DB.prepare('SELECT * FROM deck_versions WHERE objectId = ?').bind(id).first();
}

async function createVersion(env, { user, data }) {
  if (!user) throw loginRequired();
  if (typeof data.deckId !== 'string' || !data.deckId) throw new LCError(400, 1, 'deckId is required.');
  if (typeof data.metadata !== 'string' || !data.metadata) throw new LCError(400, 1, 'metadata is required.');
  if (data.pubUserId != null && data.pubUserId !== user.objectId) throw forbidden();
  const deck = await getDeckRow(env, data.deckId);
  if (!deck) throw notFound();
  if (deck.pubUserId !== user.objectId) throw forbidden('Versions belong to the deck owner.');

  const now = new Date().toISOString();
  const row = {
    objectId: newObjectId(),
    deckId: data.deckId,
    pubUserId: user.objectId,
    extra: JSON.stringify(
      Object.fromEntries(Object.entries(data).filter(([key]) => VERSION_FIELDS.has(key))),
    ),
    createdAt: now,
    updatedAt: now,
  };
  await env.BUCKET.put(versionBlobKey(row.objectId), data.metadata, { customMetadata: { type: 'string' } });
  try {
    await env.DB.prepare(
      'INSERT INTO deck_versions (objectId, deckId, pubUserId, extra, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(row.objectId, row.deckId, row.pubUserId, row.extra, row.createdAt, row.updatedAt)
      .run();
  } catch (error) {
    await env.BUCKET.delete(versionBlobKey(row.objectId));
    throw error;
  }
  return json({ objectId: row.objectId, createdAt: now, updatedAt: now }, 201);
}

async function getVersion(env, { user, params }, id) {
  if (!user) throw loginRequired();
  const row = await getVersionRow(env, id);
  if (!row) throw notFound();
  if (row.pubUserId !== user.objectId) throw forbidden('Version history belongs to its owner.');
  return json(await versionToJSON(env, row, parseKeys(params.keys)));
}

async function deleteVersion(env, { user }, id) {
  if (!user) throw loginRequired();
  const row = await getVersionRow(env, id);
  if (!row) return json({});
  if (row.pubUserId !== user.objectId) throw forbidden('Version history belongs to its owner.');
  await env.DB.prepare('DELETE FROM deck_versions WHERE objectId = ?').bind(id).run();
  await env.BUCKET.delete(versionBlobKey(id));
  return json({});
}

async function queryVersions(env, { user, params }) {
  if (!user) throw loginRequired();
  let where = params.where ?? {};
  if (typeof where === 'string') {
    try {
      where = JSON.parse(where);
    } catch {
      throw new LCError(400, 107, 'Malformed where.');
    }
  }
  const owner = where?.pubUserId?.$eq ?? where?.pubUserId;
  const deckId = where?.deckId?.$eq ?? where?.deckId;
  const objectId = where?.objectId?.$eq ?? where?.objectId;
  if (owner !== user.objectId) throw forbidden('Version history belongs to its owner.');
  if (typeof deckId !== 'string' || !deckId) throw new LCError(400, 1, 'A deckId query is required.');
  for (const key of Object.keys(where || {})) {
    if (!['objectId', 'pubUserId', 'deckId'].includes(key)) {
      throw new LCError(400, 1, `Unsupported query on "${key}".`);
    }
  }

  const order = parseOrder(params.order);
  const limit = Math.min(Math.max(parseInt(params.limit ?? '100', 10) || 0, 0), MAX_QUERY_LIMIT);
  const skip = Math.max(parseInt(params.skip ?? '0', 10) || 0, 0);
  const idFilter = typeof objectId === 'string' && objectId ? ' AND objectId = ?' : '';
  const binds = [user.objectId, deckId, ...(idFilter ? [objectId] : []), limit, skip];
  const { results } = await env.DB.prepare(
    `SELECT * FROM deck_versions WHERE pubUserId = ? AND deckId = ?${idFilter} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...binds)
    .all();
  const keys = parseKeys(params.keys);
  return json({ results: await Promise.all(results.map((row) => versionToJSON(env, row, keys))) });
}

async function versionToJSON(env, row, keys) {
  const want = (key) => !keys || keys.has(key);
  const out = { objectId: row.objectId, createdAt: row.createdAt, updatedAt: row.updatedAt };
  if (want('pubUserId')) out.pubUserId = row.pubUserId;
  if (want('deckId')) out.deckId = row.deckId;
  for (const [key, value] of Object.entries(JSON.parse(row.extra))) if (want(key)) out[key] = value;
  if (want('metadata')) {
    const object = await env.BUCKET.get(versionBlobKey(row.objectId));
    if (object) out.metadata = await object.text();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin: bulk import of the LeanCloud export (see scripts/import.mjs)
// ---------------------------------------------------------------------------

async function handleAdmin(request, env, url) {
  const expected = env.ADMIN_TOKEN;
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !given || !(await sameSecret(given, expected))) {
    return json({ code: 403, error: 'Forbidden.' }, 403);
  }

  if (request.method === 'GET' && url.pathname === '/__admin/stats') {
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
    const decks = await env.DB.prepare('SELECT COUNT(*) AS n FROM decks').first();
    return json({ users: users.n, decks: decks.n });
  }
  if (request.method !== 'POST') throw new LCError(405, 1, 'Method not allowed.');

  const { results } = await request.json();
  if (!Array.isArray(results)) throw new LCError(400, 107, 'Expected {"results": [...]}.');
  if (url.pathname === '/__admin/import/users') return json({ imported: await importUsers(env, results) });
  if (url.pathname === '/__admin/import/decks') return json({ imported: await importDecks(env, results) });
  throw notFound();
}

// Upserts LeanCloud `_User` records, preserving objectId, sessionToken (so
// already-logged-in browsers stay logged in) and the password hash + salt.
async function importUsers(env, records) {
  const stmts = records.map((u) => {
    if (!u.objectId || !u.username) throw new LCError(400, 1, `Bad user record: ${JSON.stringify(u).slice(0, 200)}`);
    const known = ['objectId', 'username', 'email', 'emailVerified', 'password', 'salt', 'sessionToken', 'createdAt', 'updatedAt', 'ACL', 'authData'];
    const extra = Object.fromEntries(Object.entries(u).filter(([k]) => !known.includes(k)));
    const hasPw = typeof u.password === 'string' && u.password !== '';
    return env.DB.prepare(
      `INSERT OR REPLACE INTO users (objectId, username, email, emailVerified, password_algo, password_hash,
                                     password_salt, sessionToken, extra, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      u.objectId,
      u.username,
      u.email || null,
      u.emailVerified ? 1 : 0,
      hasPw ? 'leancloud' : null,
      hasPw ? u.password : null,
      hasPw ? (u.salt ?? '') : null,
      u.sessionToken || null,
      JSON.stringify(extra),
      isoDate(u.createdAt),
      isoDate(u.updatedAt ?? u.createdAt),
    );
  });
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

// Upserts LeanCloud `YSDeck` records, preserving objectId so existing share
// links keep working.
async function importDecks(env, records) {
  const stmts = [];
  for (const d of records) {
    if (!d.objectId) throw new LCError(400, 1, 'Bad deck record: missing objectId.');
    const row = { blob_fields: '[]', extra: '{}' };
    const fields = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'pubUserId'));
    applyDeckChanges(row, fields);
    await putBlobs(env, d.objectId, fields);
    stmts.push(
      env.DB.prepare(
        'INSERT OR REPLACE INTO decks (objectId, pubUserId, blob_fields, extra, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(d.objectId, d.pubUserId ?? null, row.blob_fields, row.extra, isoDate(d.createdAt), isoDate(d.updatedAt ?? d.createdAt)),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-LC-Id, X-LC-Key, X-LC-Session',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
  });
}

// LeanCloud exports dates either as ISO strings or as {__type: 'Date', iso}.
function isoDate(value) {
  const raw = value && typeof value === 'object' ? value.iso : value;
  const d = raw ? new Date(raw) : new Date();
  if (Number.isNaN(d.getTime())) throw new LCError(400, 1, `Bad date: ${JSON.stringify(value)}`);
  return d.toISOString();
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Same shape as LeanCloud/MongoDB ObjectIds: 4-byte timestamp + 8 random bytes, hex.
function newObjectId() {
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return ts + rand;
}

function newSessionToken() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.getRandomValues(new Uint8Array(25))].map((b) => alphabet[b % alphabet.length]).join('');
}

async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
