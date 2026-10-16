#!/usr/bin/env python3
"""Reproduce the pinned USDA snapshot; no API key or third-party package needed."""
import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCES = [
    ("Foundation Foods", "2026-04", "FoodData_Central_foundation_food_json_2026-04-30.zip", "186e988ec542e913f51ef62b86a47758e8cdd0d1dc3889e7b055581f3c09c77a"),
    ("SR Legacy", "2018-04", "FoodData_Central_sr_legacy_food_csv_2018-04.zip", "b80817294b8850530aaedf2e515c02593b1824f763a0ff356e5c2081643e6fd0"),
    ("FNDDS", "2021-2023 (2024-10 release)", "FoodData_Central_survey_food_json_2024-10-31.zip", "dfb06ae7ddc397ccd570b91c14b75438ab2ba39f64f22d321f61d4a52a77f3eb"),
]
COLUMNS = ["fdc_id", "name", "category", "kcal", "protein", "fat", "carbs", "fiber", "sodium_mg", "energy_nutrient_id", "data_type", "release", "publication_date", "source_url"]


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None


def normalize(food, nutrients, data_type, release):
    # Prefer the source's food-specific Atwater energy, then general factors,
    # then legacy kcal. Never confuse a kJ energy value with a kcal value.
    energy_id = next((key for key in (2048, 2047, 1008) if nutrients.get(key, (None, ""))[0] is not None and nutrients[key][1].upper() == "KCAL"), None)
    kcal = nutrients[energy_id][0] if energy_id else None
    if kcal is None and nutrients.get(1062, (None, ""))[0] is not None and nutrients[1062][1].upper() == "KJ":
        kcal, energy_id = round(nutrients[1062][0] / 4.184, 6), 1062
    def grams(key):
        value, unit = nutrients.get(key, (None, ""))
        return value if unit.upper() == "G" else None
    sodium, sodium_unit = nutrients.get(1093, (None, ""))
    fdc_id = int(food["fdcId"])
    return dict(zip(COLUMNS, [fdc_id, food["description"], food.get("category", ""), kcal, grams(1003), grams(1004), grams(1005), grams(1079), sodium if sodium_unit.upper() == "MG" else None, energy_id, data_type, release, food.get("publicationDate", ""), f"https://fdc.nal.usda.gov/food-details/{fdc_id}/nutrients"]))


def rows_from_archive(path, data_type, release):
    with zipfile.ZipFile(path) as archive:
        if "_json_" in path.name:
            document = json.loads(archive.read(next(name for name in archive.namelist() if name.endswith(".json"))))
            foods = next(value for value in document.values() if isinstance(value, list))
            for food in foods:
                if not isinstance(food, dict):
                    continue
                nutrients = {int(item["nutrient"]["id"]): (number(item.get("amount")), item["nutrient"].get("unitName", "")) for item in food.get("foodNutrients", []) if isinstance(item, dict) and isinstance(item.get("nutrient"), dict)}
                food["category"] = (food.get("foodCategory") or {}).get("description", "") or (food.get("wweiaFoodCategory") or {}).get("wweiaFoodCategoryDescription", "")
                yield normalize(food, nutrients, data_type, release)
        else:
            def read_csv(table):
                name = next(name for name in archive.namelist() if name.endswith("/" + table))
                return csv.DictReader(io.TextIOWrapper(archive.open(name), encoding="utf-8-sig"))
            units = {int(row["id"]): row["unit_name"] for row in read_csv("nutrient.csv")}
            categories = {row["id"]: row["description"] for row in read_csv("food_category.csv")}
            nutrients = {}
            for row in read_csv("food_nutrient.csv"):
                nutrient_id = int(row["nutrient_id"])
                if nutrient_id in (1003, 1004, 1005, 1008, 1062, 1079, 1093, 2047, 2048):
                    nutrients.setdefault(row["fdc_id"], {})[nutrient_id] = (number(row["amount"]), units[nutrient_id])
            for row in read_csv("food.csv"):
                yield normalize({"fdcId": row["fdc_id"], "description": row["description"], "category": categories.get(row["food_category_id"], ""), "publicationDate": row["publication_date"]}, nutrients.get(row["fdc_id"], {}), data_type, release)


def sql_value(value):
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="Require the previously downloaded, checksum-verified archives")
    args = parser.parse_args()
    downloads = ROOT / "data/downloads"
    output = ROOT / "data/usda"
    downloads.mkdir(exist_ok=True); output.mkdir(exist_ok=True)
    rows, manifest = [], []
    for data_type, release, filename, expected in SOURCES:
        url = "https://fdc.nal.usda.gov/fdc-datasets/" + filename
        path = downloads / filename
        if not path.exists():
            if args.offline:
                raise SystemExit(f"Missing archive: {path}")
            with urllib.request.urlopen(url, timeout=120) as response:
                path.write_bytes(response.read())
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit(f"SHA-256 mismatch: {filename}; refusing to import changed upstream data")
        imported = list(rows_from_archive(path, data_type, release))
        rows.extend(imported)
        manifest.append({"dataType": data_type, "release": release, "url": url, "sha256": digest, "archiveBytes": path.stat().st_size, "rows": len(imported), "rowsWithEnergy": sum(row["kcal"] is not None for row in imported)})
    rows.sort(key=lambda row: row["fdc_id"])
    assert len({row["fdc_id"] for row in rows}) == len(rows), "Duplicate FDC identifiers"
    with (output / "nutrition.csv").open("w", newline="", encoding="utf-8-sig") as stream:
        writer = csv.DictWriter(stream, fieldnames=COLUMNS); writer.writeheader(); writer.writerows(rows)
    sql = "-- USDA FoodData Central CC0 snapshot; all quantities per 100 g edible food.\n"
    for offset in range(0, len(rows), 40):
        sql += "INSERT INTO authoritative_foods(" + ",".join(COLUMNS) + ") VALUES\n"
        sql += ",\n".join("(" + ",".join(sql_value(row[key]) for key in COLUMNS) + ")" for row in rows[offset:offset+40])
        sql += " ON CONFLICT(fdc_id) DO NOTHING;\n"
    (ROOT / "migrations/0004_usda_snapshot.sql").write_text(sql, encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps({"publisher": "U.S. Department of Agriculture, Agricultural Research Service", "license": "CC0-1.0", "licenseUrl": "https://fdc.nal.usda.gov/", "downloadPage": "https://fdc.nal.usda.gov/download-datasets/", "retrievedOn": "2026-10-16", "basis": "per100g", "sources": manifest, "totalRows": len(rows), "rowsWithEnergy": sum(row["kcal"] is not None for row in rows), "sqlSha256": hashlib.sha256(sql.encode()).hexdigest()}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"totalRows": len(rows), "rowsWithEnergy": sum(row["kcal"] is not None for row in rows), "sources": manifest}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
