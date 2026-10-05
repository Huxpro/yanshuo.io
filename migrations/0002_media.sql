-- Media is stored separately from deck JSON so saving a deck does not
-- re-upload every image and video. The byte counter reserves space before
-- streaming an upload to R2, including concurrent uploads to the same deck.
ALTER TABLE decks ADD COLUMN media_bytes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE media (
  objectId  TEXT PRIMARY KEY,
  deckId    TEXT NOT NULL,
  ownerId   TEXT NOT NULL,
  key       TEXT NOT NULL UNIQUE,
  mime     TEXT NOT NULL,
  bytes    INTEGER NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('uploading', 'ready')),
  createdAt TEXT NOT NULL,
  FOREIGN KEY (deckId) REFERENCES decks(objectId)
);

CREATE INDEX media_by_deck ON media (deckId, createdAt DESC);
