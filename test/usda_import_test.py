import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("usda", Path(__file__).resolve().parent.parent / "scripts/import-usda.py")
usda = importlib.util.module_from_spec(spec)
spec.loader.exec_module(usda)


class NutritionImportTest(unittest.TestCase):
    def row(self, nutrients):
        return usda.normalize({"fdcId": 123, "description": "Test food"}, nutrients, "Foundation Foods", "2026-04")

    def test_energy_units_and_preference(self):
        self.assertEqual(self.row({1062: (418.4, "kJ")})["kcal"], 100)
        row = self.row({2048: (90, "kcal"), 2047: (95, "KCAL"), 1008: (100, "kcal")})
        self.assertEqual(row["kcal"], 90)
        self.assertEqual(row["energy_nutrient_id"], 2048)

    def test_unknown_is_not_zero(self):
        self.assertIsNone(self.row({})["kcal"])
        self.assertIsNone(self.row({1008: (100, "kJ")})["kcal"])
        self.assertEqual(self.row({1008: (0, "kcal")})["kcal"], 0)
        self.assertIsNone(self.row({1003: (12, "mg")})["protein"])

    def test_invalid_values_and_sql_quotes(self):
        for value in (None, "", -1, "NaN", "Infinity"):
            self.assertIsNone(usda.number(value))
        self.assertEqual(usda.sql_value("Chef's rice"), "'Chef''s rice'")


if __name__ == "__main__":
    unittest.main()
