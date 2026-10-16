CREATE TABLE IF NOT EXISTS authoritative_foods(
  fdc_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  kcal REAL CHECK(kcal IS NULL OR kcal>=0),
  protein REAL,
  fat REAL,
  carbs REAL,
  fiber REAL,
  sodium_mg REAL,
  energy_nutrient_id INTEGER,
  data_type TEXT NOT NULL,
  release TEXT NOT NULL,
  publication_date TEXT,
  source_url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS authoritative_foods_name ON authoritative_foods(name COLLATE NOCASE);
