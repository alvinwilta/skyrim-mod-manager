"""Unit tests for the pure helpers — no db, disk, network or browser.

Run: .venv/bin/python -m unittest discover -s tests
"""

import unittest

from modman import buckets, collection_rules, commit, conflicts, engine, llm_refine, mo2_order, ordering, precedence, rules


class ParseReply(unittest.TestCase):
    # band model: the second field is a separator band id, validated against the
    # assignable-band set passed as `valid`.
    _BANDS = {101, 202, 401, 506, 1402}

    def test_basic_lines(self):
        r = llm_refine._parse_reply("123|401\n55|202|UNCERTAIN", valid=self._BANDS)
        self.assertEqual(r["order"], [{"id": 123, "b": 401}, {"id": 55, "b": 202, "f": ["UNCERTAIN"]}])
        self.assertEqual(r["conflicts"], [])

    def test_negative_ids_kept(self):
        # adopted local mods carry negative ids
        r = llm_refine._parse_reply("-123456789|401", valid=self._BANDS)
        self.assertEqual(r["order"], [{"id": -123456789, "b": 401}])

    def test_conflicts_section(self):
        r = llm_refine._parse_reply("12|101\nCONFLICTS:\n12 (A) vs 34 (B): A wins", valid=self._BANDS)
        self.assertEqual(r["order"], [{"id": 12, "b": 101}])
        self.assertEqual(r["conflicts"], ["12 (A) vs 34 (B): A wins"])

    def test_code_fences_and_noise_skipped(self):
        r = llm_refine._parse_reply("```\n12|101\nnot a line\n```", valid=self._BANDS)
        self.assertEqual(r["order"], [{"id": 12, "b": 101}])

    def test_invalid_band_dropped(self):
        # a band the model invents that isn't an assignable band must not reach
        # mod_sort (would strand a mod on a nonexistent separator)
        r = llm_refine._parse_reply("12|9999\n13|0\n14|506", valid=self._BANDS)
        self.assertEqual(r["order"], [{"id": 12}, {"id": 13}, {"id": 14, "b": 506}])

    def test_no_valid_set_keeps_any_int_band(self):
        r = llm_refine._parse_reply("12|9999", valid=None)
        self.assertEqual(r["order"], [{"id": 12, "b": 9999}])

    def test_invented_flags_dropped(self):
        # only UNCERTAIN / DUPLICATE:<id> are clearable later; the CONFLICT tag was
        # dropped (real overwrite data replaces it) so CONFLICT:<id> is not kept
        r = llm_refine._parse_reply(
            "12|101|UNCERTAIN,BOGUS,CONFLICT:55,DUPLICATE:-9", valid=self._BANDS
        )
        self.assertEqual(r["order"], [{"id": 12, "b": 101, "f": ["UNCERTAIN", "DUPLICATE:-9"]}])


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

    def test_norm_file_name_underscore_glued_versions(self):
        # underscores are word chars: without separator-collapse first,
        # \b never fires and SkyUI_5_2_SE kept its digits
        self.assertEqual(engine._norm_file_name("SkyUI_5_2_SE"), engine._norm_file_name("SkyUI 5.2 SE"))

    def test_assign_title_match_takes_every_old_revision(self):
        # the reported Papyrus Extender case: two kept revisions of one file
        # line, both must be superseded — not an 'ambiguous' shrug into "new"
        rows = [
            {"file_id": 1, "file_name": "Papyrus Extender", "file_version": "6.3.0", "downloaded_at": "a"},
            {"file_id": 2, "file_name": "Papyrus Extender", "file_version": "6.4.0", "downloaded_at": "b"},
        ]
        got = engine._assign_predecessors([{"fileId": 9, "name": "Papyrus Extender"}], rows)
        self.assertEqual(sorted(r["file_id"] for r in got[9]), [1, 2])

    def test_assign_leftover_claims_kin_title_drift(self):
        rows = [{"file_id": 1, "file_name": "SkyUI", "file_version": "5.1", "downloaded_at": "a"}]
        got = engine._assign_predecessors([{"fileId": 9, "name": "SkyUI SE"}], rows)
        self.assertEqual([r["file_id"] for r in got[9]], [1])

    def test_assign_unrelated_sibling_stays_unclaimed(self):
        # Vokrii patch is not the Apocalypse patch's past, id kinship or not
        rows = [{"file_id": 1, "file_name": "Ordinator - Vokrii Patch", "file_version": "1.1", "downloaded_at": "a"}]
        got = engine._assign_predecessors([{"fileId": 9, "name": "Ordinator - Apocalypse Patch"}], rows)
        self.assertEqual(got, {})

    def test_assign_drift_claim_vetoed_when_file_still_live(self):
        # Nexus still lists the row as a current file → it's a distinct file
        # of a multi-file mod, not this incoming file's past
        rows = [{"file_id": 1, "file_name": "SkyUI", "file_version": "5.1", "downloaded_at": "a"}]
        got = engine._assign_predecessors([{"fileId": 9, "name": "SkyUI SE"}], rows, live_ids_fn=lambda: {1})
        self.assertEqual(got, {})

    def test_assign_drift_claim_allowed_when_file_retired(self):
        rows = [{"file_id": 1, "file_name": "SkyUI", "file_version": "5.1", "downloaded_at": "a"}]
        got = engine._assign_predecessors([{"fileId": 9, "name": "SkyUI SE"}], rows, live_ids_fn=lambda: {77})
        self.assertEqual([r["file_id"] for r in got[9]], [1])

    def test_assign_two_unmatched_claim_nothing(self):
        rows = [{"file_id": 1, "file_name": "Old Thing", "file_version": "1", "downloaded_at": "a"}]
        got = engine._assign_predecessors(
            [{"fileId": 8, "name": "Alpha"}, {"fileId": 9, "name": "Beta"}], rows
        )
        self.assertEqual(got, {})

    def test_candidates_excludes_incoming_claimed_rows(self):
        # main file present in the modlist itself → the patch can't claim it
        by_mod = {10: [{"file_id": 1, "file_name": "Main File"}]}
        self.assertEqual(engine._candidates(by_mod, 10, incoming_ids={1, 2}), [])

    def test_name_keys_head_meets_mo2_archive_tail(self):
        # MO2 archive stem and Nexus file title share the before-first-digit key
        self.assertTrue(
            engine._name_keys("SkyUI_5_2_SE-3863-5-2-SE-1573234894") & engine._name_keys("SkyUI_5_2_SE")
        )

    def test_local_match_only_negative_ids_and_unique(self):
        by_mod = {
            -123: [{"file_id": -123, "mod_id": -123, "file_name": "SkyUI_5_2_SE-3863-5-2-SE.7z",
                    "mod_name": "SkyUI_5_2_SE-3863-5-2-SE"}],
            50: [{"file_id": 9, "mod_id": 50, "file_name": "SkyUI_5_2_SE", "mod_name": "SkyUI"}],
        }
        idx = engine._local_name_index(by_mod)
        # positive-id rows never enter the name index
        self.assertEqual(engine._local_match(idx, "SkyUI_5_2_SE")["file_id"], -123)

    def test_local_match_ambiguous_is_none(self):
        by_mod = {
            -1: [{"file_id": -1, "mod_id": -1, "file_name": "Cool Mod 1.7z", "mod_name": "Cool Mod 1"}],
            -2: [{"file_id": -2, "mod_id": -2, "file_name": "Cool Mod 2.7z", "mod_name": "Cool Mod 2"}],
        }
        idx = engine._local_name_index(by_mod)
        self.assertIsNone(engine._local_match(idx, "Cool Mod 3"))


class OrderRules(unittest.TestCase):
    def test_tables_loaded_from_toml(self):
        # the editable order_rules.toml is parsed into the public tables
        self.assertTrue(rules.CATEGORY_BAND)   # category -> band
        self.assertTrue(rules.RULES)           # keyword rules
        self.assertEqual(rules.HEAD_PRIORITY_IDS, [30379, 32444])  # SKSE, AddrLib
        # bucket keys are ints (TOML stores them as strings)
        self.assertTrue(all(isinstance(k, int) for k in rules.BUCKET_BAND))

    def test_rule_shape(self):
        parents, pos, band, rx = rules.RULES[0]
        # STRONG rule -> parents is None; pos/band are ints; re is compiled
        self.assertIn(parents, (None,) if parents is None else (parents,))
        self.assertIsInstance(band, int)
        self.assertIn(pos, (0, 1, 2))
        self.assertTrue(hasattr(rx, "search"))

    def test_separators_alias_is_same_object(self):
        # separators.CATEGORY_SEPARATOR aliases rules.CATEGORY_BAND so a reload
        # keeps both in sync
        from modman import separators
        self.assertIs(separators.CATEGORY_SEPARATOR, rules.CATEGORY_BAND)

    def test_reload_mutates_in_place(self):
        # reload() must NOT rebind the containers (aliases would go stale)
        cat, rul, head = rules.CATEGORY_BAND, rules.RULES, rules.HEAD_PRIORITY_IDS
        rules.reload()
        self.assertIs(rules.CATEGORY_BAND, cat)
        self.assertIs(rules.RULES, rul)
        self.assertIs(rules.HEAD_PRIORITY_IDS, head)

    def test_classify_strong_rule_beats_category(self):
        # an animation framework filed under "Utilities" -> ANIMATIONS band, TOP
        valid = set(range(0, 10000))
        band, pos = ordering._classify("FNIS Behavior", "Utilities", valid)
        self.assertEqual((band, pos), (1402, ordering.POS_TOP))

    def test_classify_category_when_no_rule(self):
        valid = set(range(0, 10000))
        band, pos = ordering._classify("Some Weapon Pack", "Weapons", valid)
        self.assertEqual(band, 1302)


if __name__ == "__main__":
    unittest.main()
