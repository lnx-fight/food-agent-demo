#!/usr/bin/env python3
"""Reproduce a checksum-pinned, complete TFDA CSV snapshot with simplified labels."""
import argparse
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import re
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DOWNLOAD_URL = 'https://data.fda.gov.tw/data/opendata/export/20/csv'
DATASET_URL = 'https://data.gov.tw/dataset/8543'
LICENSE_URL = 'https://data.gov.tw/license'
PINNED_SHA256 = '9aeb0cdbefad3f82be9b4089f044c8d0bc087a6b7453ba96832d126ff6ea3aa1'
DETAIL_COLUMNS = ['group', 'name', 'unit', 'per100gRaw', 'sampleCountRaw', 'standardDeviationRaw', 'perUnitRaw', 'unitWeightRaw', 'perUnitWeightRaw']
RAW_FIELDS = ['分析項分類', '分析項', '含量單位', '每100克含量', '樣本數', '標準差', '每單位含量', '每單位重', '每單位重含量']
FOOD_COLUMNS = ['food_id', 'name', 'original_name', 'english_name', 'category', 'description', 'original_description', 'original_aliases', 'edible_waste_percent', 'kcal', 'protein', 'fat', 'carbs', 'fiber', 'sodium_mg', 'sugar', 'saturated_fat', 'energy_basis', 'nutrient_count']


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (ValueError, TypeError):
        return None


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def sql_value(value):
    if value is None:
        return 'NULL'
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def split_aliases(value):
    # Commas inside parentheses are alternatives, not independent food names.
    result, start, depth = [], 0, 0
    for i, ch in enumerate(value):
        if ch in '(（':
            depth += 1
        elif ch in ')）':
            depth = max(0, depth - 1)
        elif ch in ',，、;' and depth == 0:
            result.append(value[start:i].strip()); start = i + 1
    result.append(value[start:].strip())
    return [term for term in result if term]


def group_rows(rows):
    foods, seen = {}, set()
    for row in rows:
        fid = row['整合編號'].strip()
        if not re.fullmatch(r'[A-R]\d{4,8}', fid):
            raise ValueError(f'Invalid TFDA identifier: {fid}')
        identity = (fid, row['分析項'], row['含量單位'])
        if identity in seen:
            raise ValueError(f'Duplicate nutrient: {identity}')
        seen.add(identity)
        meta = {k: row[k].strip() for k in ['樣品名稱', '樣品英文名稱', '食品分類', '內容物描述', '俗名', '廢棄率']}
        food = foods.setdefault(fid, {'food_id': fid, 'original_name': meta['樣品名稱'], 'english_name': meta['樣品英文名稱'], 'category': meta['食品分類'], 'description': meta['內容物描述'], 'original_description': meta['內容物描述'], 'original_aliases': meta['俗名'], 'edible_waste_percent': number(meta['廢棄率']), 'meta': meta, 'nutrients': [], 'values': {}})
        if food['meta'] != meta:
            raise ValueError(f'Inconsistent sample metadata: {fid}')
        food['nutrients'].append([row[k].strip() for k in RAW_FIELDS])
        food['values'][(row['分析項'], row['含量單位'])] = number(row['每100克含量'])
    for food in foods.values():
        values = food['values']
        # TFDA publishes both legacy and corrected energy. Use corrected kcal
        # when present; retain both original observations in the detail data.
        energy = next((name for name in ['修正熱量', '熱量'] if values.get((name, 'kcal')) is not None), None)
        food.update(kcal=values.get((energy, 'kcal')), energy_basis=energy, protein=values.get(('粗蛋白', 'g')), fat=values.get(('粗脂肪', 'g')), carbs=values.get(('總碳水化合物', 'g')), fiber=values.get(('膳食纖維', 'g')), sodium_mg=values.get(('鈉', 'mg')), sugar=values.get(('糖質總量', 'g')), saturated_fat=values.get(('飽和脂肪', 'g')), nutrient_count=len(food['nutrients']))
        food['nutrients'].sort(key=lambda r: (r[0], r[1], r[2]))
        food['names'] = [(food['original_name'], 'name')] + [(term, 'alias') for term in split_aliases(food['original_aliases'])]
        if food['english_name']:
            food['names'].append((food['english_name'], 'english'))
    return sorted(foods.values(), key=lambda food: food['food_id'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    output = ROOT / 'data/tfda'; output.mkdir(exist_ok=True)
    archive = output / 'source.zip'
    if not archive.exists():
        if args.offline:
            raise SystemExit(f'Missing archive: {archive}')
        with urllib.request.urlopen(DOWNLOAD_URL, timeout=240) as response:
            archive.write_bytes(response.read())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != PINNED_SHA256:
        raise SystemExit('TFDA source checksum changed; review the upstream release before updating the pin')
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise SystemExit('Invalid TFDA ZIP')
        csv_name = next(name for name in z.namelist() if name.endswith('.csv'))
        foods = group_rows(csv.DictReader(io.TextIOWrapper(z.open(csv_name), encoding='utf-8-sig')))
    details = {f['food_id']: f.pop('nutrients') for f in foods}
    for f in foods:
        del f['values']; del f['meta']
    labeler = subprocess.run(['node', str(ROOT / 'scripts/tfda-labels.mjs')], input=compact(foods), text=True, capture_output=True, check=True, cwd=ROOT)
    foods = json.loads(labeler.stdout)
    curated = json.loads((output / 'aliases.json').read_text())['foods']
    # Normalize curated aliases through exactly the same Unicode/OpenCC path.
    labeler = subprocess.run(['node', str(ROOT / 'scripts/tfda-labels.mjs')], input=compact([{'original_name': '', 'category': '', 'description': '', 'food_id': item['foodId'], 'names': [(term, 'curated') for term in item['aliases']]} for item in curated]), text=True, capture_output=True, check=True, cwd=ROOT)
    extra = {f['food_id']: f['names'] for f in json.loads(labeler.stdout)}
    if set(extra) - {f['food_id'] for f in foods}:
        raise SystemExit('Curated alias points to a missing official food')
    for food in foods:
        food['names'] = sorted(set(map(tuple, food['names'] + extra.get(food['food_id'], []))))
    manifest = {'source': 'TFDA', 'publisher': '卫生福利部食品药物管理署', 'dataset': '食品營養成分資料集', 'datasetUrl': DATASET_URL, 'downloadUrl': DOWNLOAD_URL, 'license': 'Open Government Data License, version 1.0', 'licenseUrl': LICENSE_URL, 'retrievedOn': '2026-10-20', 'release': 'snapshot-2026-10-20', 'sha256': digest, 'csvFile': csv_name, 'archiveBytes': archive.stat().st_size, 'basis': 'per100g_edible', 'energyPreference': ['修正熱量', '熱量'], 'totalRows': len(foods), 'nutrientRows': sum(f['nutrient_count'] for f in foods), 'rowsWithEnergy': sum(f['kcal'] is not None for f in foods), 'detailColumns': DETAIL_COLUMNS, 'attribution': '卫生福利部食品药物管理署，2026，食品营养成分资料集（小饭下载快照2026-10-20）。依政府资料开放授权条款第1版使用；简体名称及检索别名由小饭整理。'}
    # Keep each SQL statement < D1's 100KB limit; split migration requests < 1MB.
    statements, chunks, current, size = [], [], [], 0
    for food in foods:
        statements.append('INSERT INTO nutrition_foods(' + ','.join(FOOD_COLUMNS) + ') VALUES(' + ','.join(sql_value(food[k]) for k in FOOD_COLUMNS) + ');\n')
        payload = compact(details[food['food_id']])
        statements.append('INSERT INTO nutrition_nutrient_data(food_id,payload) VALUES(' + sql_value(food['food_id']) + ',' + sql_value(payload) + ');\n')
        terms = {}
        for term, kind in food['names']:
            if term and (term not in terms or kind == 'curated'):
                terms[term] = kind
        statements.append('INSERT INTO nutrition_names(term,food_id,kind) VALUES' + ','.join('(' + ','.join(map(sql_value, [term, food['food_id'], kind])) + ')' for term, kind in sorted(terms.items())) + ';\n')
    for statement in statements:
        length = len(statement.encode())
        if length > 95_000:
            raise SystemExit('Statement exceeds safe D1 SQL size')
        if size + length > 850_000:
            chunks.append(''.join(current)); current, size = [], 0
        current.append(statement); size += length
    if current:
        chunks.append(''.join(current))
    manifest['snapshotMigrations'] = [f'0008_tfda_snapshot_{i:03}.sql' for i in range(1, len(chunks) + 1)]
    manifest['migrationSha256'] = {}
    for filename, sql in zip(manifest['snapshotMigrations'], chunks):
        (ROOT / 'migrations' / filename).write_text(sql)
        manifest['migrationSha256'][filename] = hashlib.sha256(sql.encode()).hexdigest()
    (output / 'search-index.json').write_text(compact([{'term': term, 'foodId': f['food_id'], 'name': f['name'], 'curated': kind == 'curated'} for f in foods for term, kind in f['names']]) + '\n')
    manifest_json = compact(manifest)
    # This final migration is reached only after every TFDA chunk succeeded.
    final = 'INSERT INTO nutrition_dataset(source,manifest) VALUES(\'TFDA\',' + sql_value(manifest_json) + ');\n'
    final += 'CREATE TABLE tfda_import_guard(ok INTEGER CHECK(ok=1));\n'
    final += f'INSERT INTO tfda_import_guard SELECT CASE WHEN (SELECT COUNT(*) FROM nutrition_foods)={len(foods)} AND (SELECT SUM(nutrient_count) FROM nutrition_foods)={manifest["nutrientRows"]} AND (SELECT COUNT(*) FROM nutrition_nutrient_data)={len(foods)} THEN 1 ELSE 0 END;\n'
    final += 'DROP TABLE tfda_import_guard;\nDROP TABLE IF EXISTS authoritative_foods_fts;\nDROP TABLE IF EXISTS authoritative_foods;\n'
    (ROOT / 'migrations/0009_tfda_activate.sql').write_text(final)
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: manifest[key] for key in ['totalRows', 'nutrientRows', 'rowsWithEnergy', 'sha256']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
