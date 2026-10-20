-- TFDA source data is separate from account / confirmed-meal tables.
CREATE TABLE nutrition_foods(
  food_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_name TEXT NOT NULL,
  english_name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  original_description TEXT NOT NULL,
  original_aliases TEXT NOT NULL,
  edible_waste_percent REAL,
  kcal REAL,
  protein REAL,
  fat REAL,
  carbs REAL,
  fiber REAL,
  sodium_mg REAL,
  sugar REAL,
  saturated_fat REAL,
  energy_basis TEXT,
  nutrient_count INTEGER NOT NULL
);
CREATE TABLE nutrition_names(
  term TEXT NOT NULL,
  food_id TEXT NOT NULL REFERENCES nutrition_foods(food_id),
  kind TEXT NOT NULL,
  PRIMARY KEY(term,food_id)
) WITHOUT ROWID;
-- All 230,152 observations are retained in compact JSON by food: this keeps
-- import writes inside D1's free allowance, rather than creating 230k rows.
CREATE TABLE nutrition_nutrient_data(
  food_id TEXT PRIMARY KEY REFERENCES nutrition_foods(food_id),
  payload TEXT NOT NULL
);
CREATE TABLE nutrition_dataset(
  source TEXT PRIMARY KEY,
  manifest TEXT NOT NULL
);
