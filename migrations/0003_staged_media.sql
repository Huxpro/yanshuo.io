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
