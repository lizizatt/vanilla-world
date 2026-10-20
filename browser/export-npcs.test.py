import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("export_npcs", Path(__file__).with_name("export-npcs.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def insert(table, columns, values):
    return (f"INSERT INTO `{table}` (" + ", ".join(f"`{c}`" for c in columns.split()) + ") VALUES\n"
            + ",\n".join("(" + ", ".join(str(v) for v in row) + ")" for row in values) + ";\n")


def fixture():
    return (
        insert("creature_template",
               "entry patch display_id1 display_id2 display_id3 display_id4 display_scale1",
               [(1, 10, 100, 0, 0, 0, 1)])
        + insert("creature",
                 "guid id id2 id3 id4 map patch_min patch_max spawn_flags position_x position_y position_z orientation",
                 [(i, 1, 0, 0, 0, 1, 0, 10, flag, 0, 0, 0, 0)
                  for i, flag in enumerate([0, 2, 64, 1, 128, 0, 0, 0, 0, 0, 0, 0, 0], 1)])
        + insert("game_event", "entry disabled patch_min patch_max",
                 [(1, 1, 0, 10), (2, 0, 7, 7), (3, 0, 7, 10), (4, 0, 0, 10)])
        + insert("game_event_creature", "guid event",
                 [(7, 1), (8, 2), (9, 3), (10, -1), (11, 1), (11, -2),
                  (12, 1), (12, 4), (13, 1), (13, 2)])
        + insert("pool_creature", "guid pool_entry", [(6, 1)])
        + insert("pool_template", "entry flags max_limit", [(1, 0, 1)])
    )


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

    def test_conservative_visibility_preserves_negative_events_and_ordinary_pools(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "synthetic.sql"
            path.write_text(fixture(), encoding="utf-8")
            pack = module.export(path)
            self.assertEqual([s["id"] for s in pack["spawns"]], [1, 4, 5, 6, 9, 10, 11, 12])
            self.assertEqual(pack["provenance"]["filteredSpawns"],
                             {"inactiveEvents": 3, "disabledOrInvisible": 2})
            self.assertEqual(pack["provenance"]["patch"], 10)
            self.assertEqual(pack["provenance"]["redistribution"], "private-local-only")

    def test_invalid_event_metadata_does_not_silently_guess_visibility(self):
        for extra, error in [
            (insert("game_event_creature", "guid event", [(1, 99)]), "Unknown creature event"),
            (insert("game_event_creature", "guid event", [(1, 0)]), "Unknown creature event"),
            (insert("game_event", "entry disabled patch_min patch_max", [(5, 0, 10, 7)]), "Invalid event patch"),
            (insert("game_event", "entry disabled patch_min patch_max", [(5, 0, 0, 11)]), "Invalid event patch"),
        ]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "synthetic.sql"
                path.write_text(fixture() + extra, encoding="utf-8")
                with self.assertRaisesRegex(ValueError, error):
                    module.export(path)


if __name__ == "__main__":
    unittest.main()
