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


if __name__ == "__main__":
    unittest.main()
