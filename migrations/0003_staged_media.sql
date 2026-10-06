-- Guest decks upload each embedded file before sending their metadata. A
-- staged object belongs to a user until the first deck create adopts it.
CREATE TABLE staged_media (
  objectId  TEXT PRIMARY KEY,
  ownerId   TEXT NOT NULL,
  key       TEXT NOT NULL UNIQUE,
  mime      TEXT NOT NULL,
  bytes     INTEGER NOT NULL,
  status    TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  createdAt TEXT NOT NULL
);

CREATE INDEX staged_media_by_owner ON staged_media (ownerId, createdAt);

-- A browser may close after the Worker creates a deck but before it sees the
-- response. Keep one stable key for that guest project across retries.
ALTER TABLE decks ADD COLUMN guest_sync_id TEXT;
CREATE UNIQUE INDEX decks_guest_sync_id ON decks (guest_sync_id) WHERE guest_sync_id IS NOT NULL;
