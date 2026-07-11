"""Unit tests for the pure helpers — no db, disk, network or browser.

Run: .venv/bin/python -m unittest discover -s tests
"""

import unittest

from modman import buckets, collection_rules, commit, conflicts, engine, llm_refine, mo2_order, precedence


class ParseReply(unittest.TestCase):
    def test_basic_lines(self):
        r = llm_refine._parse_reply("123|4\n55|2|UNCERTAIN")
        self.assertEqual(r["order"], [{"id": 123, "b": 4}, {"id": 55, "b": 2, "f": ["UNCERTAIN"]}])
        self.assertEqual(r["conflicts"], [])

    def test_negative_ids_kept(self):
        # adopted local mods carry negative ids
        r = llm_refine._parse_reply("-123456789|4")
        self.assertEqual(r["order"], [{"id": -123456789, "b": 4}])

    def test_conflicts_section(self):
        r = llm_refine._parse_reply("12|3\nCONFLICTS:\n12 (A) vs 34 (B): A wins")
        self.assertEqual(r["order"], [{"id": 12, "b": 3}])
        self.assertEqual(r["conflicts"], ["12 (A) vs 34 (B): A wins"])

    def test_code_fences_and_noise_skipped(self):
        r = llm_refine._parse_reply("```\n12|3\nnot a line\n```")
        self.assertEqual(r["order"], [{"id": 12, "b": 3}])

    def test_out_of_range_bucket_dropped(self):
        # a hallucinated bucket (STEP has exactly 1-20) must not reach mod_sort
        r = llm_refine._parse_reply("12|25\n13|0\n14|20")
        self.assertEqual(
            r["order"], [{"id": 12}, {"id": 13}, {"id": 14, "b": 20}]
        )

    def test_invented_flags_dropped(self):
        # only UNCERTAIN / CONFLICT:<id> / DUPLICATE:<id> are clearable later
        r = llm_refine._parse_reply("12|3|UNCERTAIN,BOGUS,CONFLICT 55,CONFLICT:55,DUPLICATE:-9")
        self.assertEqual(r["order"], [{"id": 12, "b": 3, "f": ["UNCERTAIN", "CONFLICT:55", "DUPLICATE:-9"]}])


class Classify(unittest.TestCase):
    def test_keyword_beats_category(self):
        bucket, flags = buckets.classify("Address Library for SKSE Plugins", "Bug Fixes")
        self.assertEqual(bucket, 1)
        self.assertEqual(flags, [])

    def test_category_fallback(self):
        bucket, flags = buckets.classify("Some Mod", "User Interface")
        self.assertEqual(bucket, 15)

    def test_unknown_is_uncertain(self):
        bucket, flags = buckets.classify("Totally Opaque Name", None)
        self.assertEqual(bucket, 8)
        self.assertIn("UNCERTAIN", flags)


class NormalizePath(unittest.TestCase):
    def test_data_wrapper_stripped(self):
        self.assertEqual(conflicts._normalize("Data/textures/a.dds"), "textures/a.dds")

    def test_extra_top_folder_stripped(self):
        self.assertEqual(conflicts._normalize("MyMod 1.2/meshes/x.nif"), "meshes/x.nif")

    def test_backslashes_and_case(self):
        self.assertEqual(conflicts._normalize(r"Textures\A.DDS"), "textures/a.dds")

    def test_plugin_at_root_kept(self):
        self.assertEqual(conflicts._normalize("MyMod.esp"), "mymod.esp")


class LcsSet(unittest.TestCase):
    def test_identical(self):
        self.assertEqual(mo2_order._lcs_set([1, 2, 3], [1, 2, 3]), {1, 2, 3})

    def test_one_moved(self):
        # 3 jumped to the front: everything else is still in relative order
        self.assertEqual(mo2_order._lcs_set([1, 2, 3, 4], [3, 1, 2, 4]), {1, 2, 4})


class Prefix(unittest.TestCase):
    def test_width_tracks_total(self):
        self.assertEqual(commit._prefix(0, 5), "1__")
        self.assertEqual(commit._prefix(0, 100), "001__")
        self.assertEqual(commit._prefix(99, 100), "100__")


class Sanitize(unittest.TestCase):
    def test_strips_separators_and_dots(self):
        self.assertEqual(engine.sanitize('A/B\\C:D*E?F"G<H>I|J.K'), "ABCDEFGHIJK")


class OnCycle(unittest.TestCase):
    # must_precede maps dependent -> {precedents}
    def test_two_cycle(self):
        rules = {1: {2}, 2: {1}}  # 2 before 1 AND 1 before 2
        self.assertTrue(precedence._on_cycle(1, 2, rules))

    def test_chain_is_not_cycle(self):
        # C before B, B before A is a plain chain — re-breaking (C,B) via
        # (B,A)'s move must be re-fixable, not dropped as a cycle
        rules = {"B": {"C"}, "A": {"B"}}
        self.assertFalse(precedence._on_cycle("B", "C", rules))
        self.assertFalse(precedence._on_cycle("A", "B", rules))

    def test_three_cycle(self):
        rules = {"B": {"A"}, "C": {"B"}, "A": {"C"}}
        self.assertTrue(precedence._on_cycle("B", "A", rules))


class ResolveRules(unittest.TestCase):
    MANIFEST = {
        "mods": [
            {"name": "Mod A", "source": {"type": "nexus", "modId": 11, "md5": "aaa", "logicalFilename": "ModA.7z"}},
            {"name": "Mod B", "source": {"type": "nexus", "modId": 22, "logicalFilename": "ModB.zip"}},
            {"name": "Off-site", "source": {"type": "browse"}},
        ]
    }

    def test_md5_primary(self):
        by_md5, by_name = collection_rules._resolve_index(self.MANIFEST)
        self.assertEqual(collection_rules._resolve({"fileMD5": "aaa"}, by_md5, by_name), 11)

    def test_logical_filename_fallback(self):
        # md5-less rules resolve via logicalFileName
        by_md5, by_name = collection_rules._resolve_index(self.MANIFEST)
        self.assertEqual(collection_rules._resolve({"logicalFileName": "ModB.zip"}, by_md5, by_name), 22)

    def test_unresolvable(self):
        by_md5, by_name = collection_rules._resolve_index(self.MANIFEST)
        self.assertIsNone(collection_rules._resolve({"logicalFileName": "Nope.7z"}, by_md5, by_name))


class DiffHelpers(unittest.TestCase):
    def test_version_key_orders(self):
        self.assertLess(engine._version_key("2.5"), engine._version_key("2.10"))
        self.assertLess(engine._version_key("v1.2a"), engine._version_key("1.3"))

    def test_version_key_unparseable(self):
        self.assertIsNone(engine._version_key("beta"))
        self.assertIsNone(engine._version_key(None))

    def test_norm_file_name_strips_versions(self):
        self.assertEqual(engine._norm_file_name("SkySA 2.5"), engine._norm_file_name("SkySA v2.8.3"))
        self.assertNotEqual(
            engine._norm_file_name("Ordinator Main File"),
            engine._norm_file_name("Ordinator - Vokrii Patch"),
        )

    def test_predecessor_unique_title_match(self):
        rows = [
            {"file_id": 1, "file_name": "Main File 1.0"},
            {"file_id": 2, "file_name": "Optional Patch 1.0"},
        ]
        self.assertEqual(engine._predecessor(rows, "Main File 2.0")["file_id"], 1)

    def test_predecessor_sibling_is_none(self):
        # a patch for a mod we only have the main file of must NOT claim
        # the main file as its past — it's an addition, not a replacement
        rows = [{"file_id": 1, "file_name": "Main File"}]
        self.assertIsNone(engine._predecessor(rows, "Hotfix ESL"))

    def test_predecessor_ambiguous_is_none(self):
        rows = [
            {"file_id": 1, "file_name": "Patch 1"},
            {"file_id": 2, "file_name": "Patch 2"},
        ]
        self.assertIsNone(engine._predecessor(rows, "Patch 3"))


if __name__ == "__main__":
    unittest.main()
