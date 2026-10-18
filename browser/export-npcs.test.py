import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("export_npcs", Path(__file__).with_name("export-npcs.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportTests(unittest.TestCase):
    def test_tuple_reader_retains_quoted_commas_and_escaped_apostrophes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.sql"
            path.write_text(
                "INSERT INTO `creature_template` (`entry`, `name`) VALUES\n"
                "(1, 'A name, with comma'),\n"
                "(2, 'It\\'s quoted');\n", encoding="utf-8")
            rows = list(module.rows(path))
            self.assertEqual(rows[0][1]["name"], "A name, with comma")
            self.assertEqual(rows[1][1]["name"], "It's quoted")

    def test_absent_or_corrupt_world_data_is_not_an_empty_success(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.sql"
            path.write_text("-- no world rows\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no usable"):
                module.export(path)
            path.write_text("INSERT INTO `creature` (`guid`, `id`) VALUES\n(1);\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "column count"):
                list(module.rows(path))


if __name__ == "__main__":
    unittest.main()
