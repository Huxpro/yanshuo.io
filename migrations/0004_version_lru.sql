-- Critical versions are retained with LRU semantics. Listing history does not
-- count as use; opening/restoring a full snapshot refreshes this timestamp.
ALTER TABLE deck_versions ADD COLUMN accessedAt TEXT;
UPDATE deck_versions SET accessedAt = createdAt WHERE accessedAt IS NULL;

CREATE INDEX deck_versions_by_access ON deck_versions (pubUserId, deckId, accessedAt ASC);
