-- User-confirmed packaged foods are private to an existing browser owner.
CREATE TABLE IF NOT EXISTS packaged_foods(
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  barcode TEXT NOT NULL,
  product TEXT NOT NULL CHECK(json_valid(product)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,barcode)
) WITHOUT ROWID;
