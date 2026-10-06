-- Billing owns this field. It is deliberately not kept in `extra`, whose
-- imported/user-supplied fields are not an entitlement boundary.
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
