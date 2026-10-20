import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('tfda', Path(__file__).resolve().parent.parent / 'scripts/import-tfda.py')
tfda = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tfda)


class TfdaImportTest(unittest.TestCase):
    def row(self, name, value, unit='g', **changes):
        row = {key: '' for key in tfda.RAW_FIELDS}
        row.update({'整合編號': 'A0100101', '樣品名稱': '測試食品', '樣品英文名稱': 'Test food', '食品分類': '穀物類', '內容物描述': '樣品狀態:生', '俗名': '', '廢棄率': '', '分析項分類': '一般成分', '分析項': name, '含量單位': unit, '每100克含量': value})
        row.update(changes)
        return row

    def test_corrected_energy_preference_and_unit_checks(self):
        food = tfda.group_rows([self.row('熱量', '100', 'kcal'), self.row('修正熱量', '95', 'kcal'), self.row('粗蛋白', '12', 'mg')])[0]
        self.assertEqual(food['kcal'], 95)
        self.assertEqual(food['energy_basis'], '修正熱量')
        self.assertIsNone(food['protein'])
        self.assertEqual(tfda.group_rows([self.row('熱量', '100', 'kJ')])[0]['kcal'], None)
        self.assertEqual(tfda.group_rows([self.row('熱量', '100', 'kcal')])[0]['kcal'], 100)

    def test_missing_values_and_zero_remain_distinct(self):
        food = tfda.group_rows([self.row('熱量', '0', 'kcal'), self.row('粗蛋白', ''), self.row('粗脂肪', '0')])[0]
        self.assertEqual(food['kcal'], 0)
        self.assertIsNone(food['protein'])
        self.assertEqual(food['fat'], 0)
        self.assertEqual(len(food['nutrients']), 3)
        for value in [None, '', 'ND', 'NaN', 'Infinity', '-1']:
            self.assertIsNone(tfda.number(value))

    def test_preserves_all_detail_units_and_sample_information(self):
        row = self.row('鈉', '  3.5 ', 'mg', 樣本數='2', 標準差='1.2', 每單位重='20.0克', 每單位重含量='0.7')
        food = tfda.group_rows([row])[0]
        self.assertEqual(food['sodium_mg'], 3.5)
        self.assertEqual(food['nutrients'][0], ['一般成分', '鈉', 'mg', '3.5', '2', '1.2', '', '20.0克', '0.7'])

    def test_duplicate_and_inconsistent_source_data_are_rejected(self):
        row = self.row('熱量', '100', 'kcal')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            tfda.group_rows([row, row])
        with self.assertRaisesRegex(ValueError, 'Inconsistent'):
            tfda.group_rows([row, self.row('粗蛋白', '3', 樣品名稱='另一食品')])

    def test_alias_parentheses_and_sql_quoting(self):
        self.assertEqual(tfda.split_aliases('甲(乙,丙),丁'), ['甲(乙,丙)', '丁'])
        self.assertEqual(tfda.sql_value("Chef's rice"), "'Chef''s rice'")


if __name__ == '__main__':
    unittest.main()
