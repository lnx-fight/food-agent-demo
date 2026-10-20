ALTER TABLE recipes ADD COLUMN origin TEXT NOT NULL DEFAULT 'seed' CHECK(origin IN ('seed','llm'));
ALTER TABLE recipes ADD COLUMN cache_key TEXT;
CREATE UNIQUE INDEX recipes_cache_key ON recipes(cache_key) WHERE cache_key IS NOT NULL;
