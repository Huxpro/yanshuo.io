-- Replacement for LeanCloud's `_User` class.
-- password_algo:
--   'leancloud' : imported hash, base64(sha512^513(salt + password)); upgraded on next login
--   'pbkdf2'    : native hash, see src/password.js
CREATE TABLE users (
  objectId      TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  password_algo TEXT,
  password_hash TEXT,
  password_salt TEXT,
  sessionToken  TEXT UNIQUE,
  extra         TEXT NOT NULL DEFAULT '{}', -- any other exported fields, as JSON
  createdAt     TEXT NOT NULL,              -- ISO 8601, millisecond precision, UTC
  updatedAt     TEXT NOT NULL
);

-- Replacement for LeanCloud's `YSDeck` class. The large string fields
-- (`metadata`, `metaHTML`) live in R2 under decks/<objectId>/<field>.
CREATE TABLE decks (
  objectId    TEXT PRIMARY KEY,
  pubUserId   TEXT,
  blob_fields TEXT NOT NULL DEFAULT '[]', -- JSON array of field names stored in R2
  extra       TEXT NOT NULL DEFAULT '{}', -- any other (small) fields, as JSON
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL
);

CREATE INDEX decks_by_user ON decks (pubUserId, updatedAt DESC);
