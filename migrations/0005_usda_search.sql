CREATE VIRTUAL TABLE IF NOT EXISTS authoritative_foods_fts USING fts5(name,content='authoritative_foods',content_rowid='fdc_id');
INSERT INTO authoritative_foods_fts(authoritative_foods_fts) VALUES('rebuild');
