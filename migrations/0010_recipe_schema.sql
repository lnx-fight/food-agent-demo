-- Recipes are separate from authoritative food measurements and personal logs.
CREATE TABLE IF NOT EXISTS recipe_seed_batches(
  version TEXT PRIMARY KEY,
  recipe_count INTEGER NOT NULL CHECK(recipe_count>0),
  manifest TEXT NOT NULL CHECK(json_valid(manifest))
);
CREATE TABLE IF NOT EXISTS recipes(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  search_text TEXT NOT NULL,
  servings INTEGER NOT NULL CHECK(servings>0),
  portion_type TEXT NOT NULL CHECK(portion_type='dish'),
  minutes INTEGER NOT NULL CHECK(minutes>0),
  water_ml REAL NOT NULL CHECK(water_ml>=0),
  steps TEXT NOT NULL CHECK(json_valid(steps)),
  allergens TEXT NOT NULL CHECK(json_valid(allergens)),
  nutrition TEXT NOT NULL CHECK(json_valid(nutrition)),
  provenance TEXT NOT NULL CHECK(json_valid(provenance)),
  seed_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_ingredients(
  recipe_id TEXT NOT NULL REFERENCES recipes(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  food_id TEXT NOT NULL REFERENCES nutrition_foods(food_id),
  grams REAL NOT NULL CHECK(grams>0 AND grams<=1000),
  role TEXT NOT NULL CHECK(role IN ('main','seasoning')),
  quantity_origin TEXT NOT NULL CHECK(quantity_origin IN ('source','editorial')),
  food_state TEXT NOT NULL,
  PRIMARY KEY(recipe_id,position),
  UNIQUE(recipe_id,food_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS recipe_ingredients_food ON recipe_ingredients(food_id);
