-- Private, immutable checkpoints for cloud decks. Snapshot bodies can contain
-- inlined media, so `metadata` lives in R2 under versions/<objectId>/metadata.
CREATE TABLE deck_versions (
  objectId  TEXT PRIMARY KEY,
  deckId    TEXT NOT NULL,
  pubUserId TEXT NOT NULL,
  extra     TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (deckId) REFERENCES decks(objectId) ON DELETE CASCADE
);

CREATE INDEX deck_versions_by_deck ON deck_versions (pubUserId, deckId, createdAt DESC);
