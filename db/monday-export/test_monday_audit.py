#!/usr/bin/env python3
"""
Tests for monday_audit.py.

    python3 db/monday-export/test_monday_audit.py

The last class builds a synthetic export on disk and runs the whole audit over
it, so the reports are known to be producible before a token exists. Every
fixture site name here is one of the real board's aliases, because the point of
the register is that the three boards spell the same shop three ways.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import monday_audit as ma  # noqa: E402


class Normalisation(unittest.TestCase):
    def test_en_dash_and_hyphen_are_the_same_character(self):
        self.assertEqual(ma.norm("Aldgate – Whitechapel Road"),
                         ma.norm("Aldgate - Whitechapel Road"))

    def test_double_space_in_the_live_group_title_normalises_away(self):
        # The live board really does read "Westfield Stratford  completed".
        self.assertEqual(ma.norm("Westfield Stratford  completed"),
                         ma.norm("Westfield Stratford completed"))

    def test_monday_typo_suffix_is_stripped_like_the_correct_one(self):
        self.assertEqual(ma.strip_group_suffix("Nottingham complited"), "Nottingham")
        self.assertEqual(ma.strip_group_suffix("Bullring completed"), "Bullring")


class Resolution(unittest.TestCase):
    def setUp(self):
        self.register = ma.SiteRegister()

    def test_canonical_name_is_an_exact_match(self):
        classification, canonical, confidence, _ = self.register.resolve("Brent Cross")
        self.assertEqual(classification, "EXACT CANONICAL MATCH")
        self.assertEqual(canonical, "Brent Cross")
        self.assertEqual(confidence, 1.0)

    def test_store_documentation_name_is_a_known_alias(self):
        classification, canonical, _c, _r = self.register.resolve("Brentcross")
        self.assertEqual(classification, "KNOWN ALIAS MATCH")
        self.assertEqual(canonical, "Brent Cross")

    def test_store_location_label_is_a_known_alias(self):
        _cl, canonical, _c, _r = self.register.resolve("Sheffield – Meadow Hall")
        self.assertEqual(canonical, "Sheffield – Meadowhall")

    def test_the_group_typo_resolves(self):
        _cl, canonical, _c, _r = self.register.resolve("Nottingham complited", "group")
        self.assertEqual(canonical, "Nottingham – Victoria Centre")

    def test_the_double_spaced_group_resolves(self):
        _cl, canonical, _c, _r = self.register.resolve("Westfield Stratford  completed", "group")
        self.assertEqual(canonical, "Westfield – Stratford")

    def test_a_group_with_no_store_documentation_row_still_resolves(self):
        # Cambridge, Derby and SJQ Edinburgh are former sites whose completed
        # jobs would otherwise be orphaned.
        for group in ("Cambridge completed", "Derby completed", "SJQ Edinburgh completed"):
            _cl, canonical, _c, _r = self.register.resolve(group, "group")
            self.assertTrue(canonical, f"{group} did not resolve")

    def test_one_word_of_a_longer_site_name_resolves(self):
        # Real Location free text from the board. Whole-string similarity puts
        # "Stratford" closer to "Watford – Atria" (0.75) than to the right shop,
        # so the token test has to be what decides these.
        for source, expected in (("Silverburn", "Glasgow – Silverburn"),
                                 ("Stratford", "Westfield – Stratford"),
                                 ("stratford", "Westfield – Stratford"),
                                 ("Trafford", "Manchester – Trafford Centre")):
            classification, canonical, _c, reason = self.register.resolve(source)
            self.assertEqual(canonical, expected, f"{source!r}: {reason}")
            self.assertEqual(classification, "FUZZY CANDIDATE")

    def test_a_token_two_sites_share_still_does_not_resolve(self):
        # "Bristol" is Cabot Circus and Cribbs Causeway; "Westfiled" is a typo
        # for a word Stratford and White City both carry. Guessing either would
        # attach one shop's job history to another.
        for source in ("Bristol", "Westfiled"):
            classification, canonical, _c, reason = self.register.resolve(source)
            self.assertEqual(canonical, "", f"{source!r} resolved to {canonical!r}: {reason}")
            self.assertEqual(classification, "UNRESOLVED")

    def test_the_swedish_locations_do_not_resolve_to_a_uk_site(self):
        # Mall of Scandinavia, Nacka, Solna and Taby are the International
        # group. None of them is a UK site, and none may be forced into one.
        for source in ("Mall of Scandinavia", "Nacka / Sweden", "Solna", "Taby/ Sweden"):
            _cl, canonical, _c, reason = self.register.resolve(source)
            self.assertEqual(canonical, "", f"{source!r} resolved to {canonical!r}: {reason}")

    def test_an_unrelated_string_is_unresolved_not_guessed(self):
        classification, canonical, _c, _r = self.register.resolve("Please call the landlord")
        self.assertEqual(classification, "UNRESOLVED")
        self.assertEqual(canonical, "")

    def test_the_empty_placeholder_does_not_resolve_to_a_site(self):
        classification, canonical, _c, _r = self.register.resolve("Item 5")
        self.assertEqual(canonical, "")
        self.assertEqual(classification, "UNRESOLVED")

    def test_empty_source_is_unresolved(self):
        self.assertEqual(self.register.resolve("")[0], "UNRESOLVED")

    def test_every_alias_in_the_register_resolves_to_its_own_site(self):
        for canonical, store_doc, label, group, _status in ma.SITES:
            for alias, kind in ((store_doc, ""), (label, ""), (group, "group")):
                if not alias:
                    continue
                classification, resolved, _c, reason = self.register.resolve(alias, kind)
                self.assertEqual(
                    resolved, canonical,
                    f"{alias!r} resolved to {resolved!r}, not {canonical!r} ({reason})")
                self.assertIn(classification,
                              ("EXACT CANONICAL MATCH", "KNOWN ALIAS MATCH"))

    def test_two_manchester_sites_do_not_collapse_into_one(self):
        # Arndale and the Trafford Centre share a city; a resolver that scored
        # on the city alone would merge two shops' job histories.
        self.assertEqual(self.register.resolve("Manchester Arndale")[1], "Manchester – Arndale")
        self.assertEqual(self.register.resolve("Trafford Centre - Manchester")[1],
                         "Manchester – Trafford Centre")

    def test_the_two_cardiff_sites_stay_apart(self):
        self.assertEqual(self.register.resolve("Grand Arcade - Cardiff")[1],
                         "Cardiff – Grand Arcade")
        self.assertEqual(self.register.resolve("Cardiff St Davids")[1], "Cardiff St Davids")

    def test_the_two_white_city_sites_stay_apart(self):
        self.assertEqual(self.register.resolve("Westfield White City Original")[1],
                         "Westfield – White City")
        self.assertEqual(self.register.resolve("Westfield White City Bespoke")[1],
                         "Westfield White City Bespoke")


class StoreDocClassification(unittest.TestCase):
    def test_documents_and_dates_are_clear(self):
        self.assertEqual(ma.classify_store_doc("Aldgate", 3, ["PAT Expiry"], 3, "Current stores")[0],
                         "CLEAR")

    def test_an_expiry_with_no_certificate_needs_review(self):
        verdict, reason = ma.classify_store_doc("Mall of Netherlands", 0, ["PLI Expiry"], 0, "Europe")
        self.assertEqual(verdict, "NEEDS REVIEW")
        self.assertIn("no certificate", reason)

    def test_address_only_is_a_placeholder(self):
        self.assertEqual(ma.classify_store_doc("Warehouse 1", 0, [], 2, "Other")[0],
                         "EMPTY/PLACEHOLDER")

    def test_item_five_is_named_as_a_placeholder(self):
        self.assertEqual(ma.classify_store_doc("Item 5", 0, [], 0, "Europe")[0],
                         "EMPTY/PLACEHOLDER")


class FilenameSiteMismatch(unittest.TestCase):
    def setUp(self):
        self.register = ma.SiteRegister()

    def test_the_bluewater_rams_naming_watford_is_flagged(self):
        rows = [{"item_id": "1", "store_name": "Bluewater", "column_id": "files45",
                 "column_title": "RAMS", "asset_id": "9",
                 "filename": "RAMS Watfrod Atria .docx"}]
        flagged = ma.filename_site_mismatch(rows, self.register)
        self.assertEqual(len(flagged), 1)
        self.assertEqual(flagged[0]["filed_against"], "Greenhithe – Bluewater")
        self.assertEqual(flagged[0]["filename_suggests"], "Watford – Atria")

    def test_the_bristol_water_hygiene_naming_meadowhall_is_flagged(self):
        rows = [{"item_id": "2", "store_name": "Cabot Circus - Bristol",
                 "column_id": "file_mm42zvqa", "column_title": "Water Hygiene Test Report",
                 "asset_id": "10",
                 "filename": "Water_Hygiene_and_Legionella_Risk_Assessment_Meadowhall.docx"}]
        flagged = ma.filename_site_mismatch(rows, self.register)
        self.assertEqual(len(flagged), 1)
        self.assertEqual(flagged[0]["filed_against"], "Bristol – Cabot Circus")
        self.assertEqual(flagged[0]["filename_suggests"], "Sheffield – Meadowhall")

    def test_a_correctly_filed_document_is_not_flagged(self):
        rows = [{"item_id": "3", "store_name": "Aldgate", "column_id": "files0",
                 "column_title": "PAT Test Certificate", "asset_id": "11",
                 "filename": "PAT Aldgate 2026.pdf"}]
        self.assertEqual(ma.filename_site_mismatch(rows, self.register), [])

    def test_a_bare_digit_is_not_evidence_of_a_warehouse(self):
        # "Warehouse 1" and "Warehouse 2" share the token `warehouse`, so it is
        # not distinctive, and each site's only remaining token is a digit. The
        # first run of this check flagged eleven correctly-filed documents as
        # misfiled because their names contained "(1)" or "2".
        rows = [
            {"item_id": "1", "store_name": "The Centre:MK", "column_id": "file_mm425qb4",
             "column_title": "Fire Risk Assessment", "asset_id": "1",
             "filename": "Fire Risk Assessment (1).docx"},
            {"item_id": "2", "store_name": "Cabot Circus - Bristol", "column_id": "files4",
             "column_title": "Electrical Wiring Certificate", "asset_id": "2",
             "filename": "EICR 2.png"},
            {"item_id": "3", "store_name": "Churchill Square - Brighton",
             "column_id": "file_mm42pa4c", "column_title": "Sprinkler Report",
             "asset_id": "3", "filename": "image2 (2).jpeg"},
            {"item_id": "4", "store_name": "Grand Arcade - Cardiff", "column_id": "files0",
             "column_title": "PAT Test Certificate", "asset_id": "4",
             "filename": "Invoice-1057752 (1).pdf"},
        ]
        self.assertEqual(ma.filename_site_mismatch(rows, self.register), [])

    def test_a_digit_only_token_is_never_distinctive(self):
        self.assertNotIn("1", self.register.distinctive)
        self.assertNotIn("2", self.register.distinctive)
        self.assertNotIn("warehouse", self.register.distinctive)  # names two sites
        self.assertIn("atria", self.register.distinctive)
        self.assertIn("meadowhall", self.register.distinctive)

    def test_a_filename_naming_no_site_is_not_flagged(self):
        rows = [{"item_id": "4", "store_name": "Aldgate", "column_id": "files0",
                 "column_title": "PAT Test Certificate", "asset_id": "12",
                 "filename": "PAT_certificate_final_v2.pdf"}]
        self.assertEqual(ma.filename_site_mismatch(rows, self.register), [])


class OrganisationLevel(unittest.TestCase):
    def test_one_policy_on_two_sites_is_flagged_by_checksum(self):
        inventory = [
            {"item_id": "1", "store_name": "Aldgate", "column_title": "PLI Document",
             "asset_id": "100", "filename": "PLI-2026.pdf", "column_id": "file"},
            {"item_id": "2", "store_name": "Westfield Stratford", "column_title": "PLI Document",
             "asset_id": "200", "filename": "public-liability.pdf", "column_id": "file"},
        ]
        manifest = [{"asset_id": "100", "sha256": "abc"}, {"asset_id": "200", "sha256": "abc"}]
        found = ma.organisation_level_candidates(inventory, manifest)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["identity"], "sha256")
        self.assertEqual(found[0]["site_count"], 2)

    def test_without_a_manifest_it_falls_back_to_filename_and_says_so(self):
        inventory = [
            {"item_id": "1", "store_name": "Aldgate", "column_title": "PLI Document",
             "asset_id": "100", "filename": "PLI-2026.pdf", "column_id": "file"},
            {"item_id": "2", "store_name": "Westfield Stratford", "column_title": "PLI Document",
             "asset_id": "200", "filename": "PLI-2026.pdf", "column_id": "file"},
        ]
        found = ma.organisation_level_candidates(inventory, None)
        self.assertEqual(found[0]["identity"], "filename only")

    def test_different_certificates_on_different_sites_are_not_flagged(self):
        inventory = [
            {"item_id": "1", "store_name": "Aldgate", "column_title": "PAT Test Certificate",
             "asset_id": "100", "filename": "PAT Aldgate.pdf", "column_id": "files0"},
            {"item_id": "2", "store_name": "Woodgreen", "column_title": "PAT Test Certificate",
             "asset_id": "200", "filename": "PAT Woodgreen.pdf", "column_id": "files0"},
        ]
        manifest = [{"asset_id": "100", "sha256": "aaa"}, {"asset_id": "200", "sha256": "bbb"}]
        self.assertEqual(ma.organisation_level_candidates(inventory, manifest), [])


class JobTitles(unittest.TestCase):
    def setUp(self):
        self.register = ma.SiteRegister()

    @staticmethod
    def item(item_id, group="", **cells):
        return {
            "id": item_id,
            "name": "Incoming form answer",
            "group": {"id": "g", "title": group},
            "column_values": [{"id": ma.COL[k], "type": "text", "text": v, "value": None}
                              for k, v in cells.items()],
        }

    def test_rule_one_when_site_and_label_exist(self):
        rows = ma.job_title_dry_run(
            [self.item("1", store_location="Aldgate – Whitechapel Road", label="Lights")],
            self.register)
        self.assertEqual(rows[0]["rule"], 1)
        self.assertEqual(rows[0]["generated_title"], "Aldgate – Whitechapel Road — Lights")

    def test_rule_two_when_the_label_is_blank(self):
        rows = ma.job_title_dry_run(
            [self.item("2", store_location="Aldgate – Whitechapel Road",
                       description="Front door lock is jammed and will not turn")],
            self.register)
        self.assertEqual(rows[0]["rule"], 2)
        self.assertTrue(rows[0]["generated_title"].startswith("Aldgate – Whitechapel Road — "))

    def test_the_site_can_come_from_the_group_when_the_label_is_unset(self):
        rows = ma.job_title_dry_run(
            [self.item("3", group="Bullring completed", label="Glass")], self.register)
        self.assertEqual(rows[0]["rule"], 1)
        self.assertEqual(rows[0]["site"], "Birmingham – Bullring")
        self.assertEqual(rows[0]["site_resolved_by"], "group")

    def test_rule_three_when_no_site_resolves(self):
        rows = ma.job_title_dry_run(
            [self.item("4", location="Unit 7, somewhere else", description="Shelf broken")],
            self.register)
        self.assertEqual(rows[0]["rule"], 3)
        self.assertEqual(rows[0]["generated_title"], "Unit 7, somewhere else — Shelf broken")

    def test_rule_four_is_the_last_resort(self):
        rows = ma.job_title_dry_run([self.item("5", source_number="418")], self.register)
        self.assertEqual(rows[0]["rule"], 4)
        self.assertEqual(rows[0]["generated_title"], "Job 418")

    def test_description_is_cut_at_sixty_characters(self):
        long_text = "x" * 200
        rows = ma.job_title_dry_run(
            [self.item("6", store_location="Watford – Atria", description=long_text)],
            self.register)
        self.assertEqual(rows[0]["generated_title"], "Watford – Atria — " + "x" * 60)

    def test_the_source_name_is_always_kept(self):
        rows = ma.job_title_dry_run([self.item("7", source_number="1")], self.register)
        self.assertEqual(rows[0]["source_item_name"], "Incoming form answer")

    def test_the_new_monthly_group_is_not_read_as_a_site(self):
        # "September  2026 Recently completed" appeared on the live board after
        # the repository's August capture. A literal list of stage groups sent
        # it to the site resolver as though September were a shop.
        self.assertFalse(ma.is_site_group("September  2026 Recently completed"))
        self.assertFalse(ma.is_site_group("August  2026 Recently completed"))
        self.assertFalse(ma.is_site_group("January 2027 Recently completed"))
        self.assertFalse(ma.is_site_group("Needs attention"))
        self.assertTrue(ma.is_site_group("Bullring completed"))
        self.assertTrue(ma.is_site_group("Nottingham complited"))

    def test_a_stage_group_is_not_read_as_a_site(self):
        rows = ma.job_title_dry_run(
            [self.item("8", group="Needs attention", location="Kiosk 5",
                       description="Light out")], self.register)
        self.assertEqual(rows[0]["site"], "")
        self.assertEqual(rows[0]["rule"], 3)


class Contractors(unittest.TestCase):
    @staticmethod
    def item(item_id, contractor, cost=""):
        return {"id": item_id, "name": "", "group": {}, "column_values": [
            {"id": ma.COL["contractor"], "type": "text", "text": contractor, "value": None},
            {"id": ma.COL["cost"], "type": "numbers", "text": cost, "value": None},
        ]}

    def test_case_and_spacing_variants_are_grouped_not_merged(self):
        rows, blanks, groups = ma.contractor_dry_run([
            self.item("1", "ACME Ltd", "100"),
            self.item("2", "acme  ltd", "50"),
            self.item("3", "Other Co", "25"),
            self.item("4", ""),
        ])
        self.assertEqual(blanks, 1)
        self.assertEqual(groups, 1)
        # Both spellings survive as their own row — nothing is rewritten here.
        self.assertEqual({r["contractor_raw"] for r in rows}, {"ACME Ltd", "acme  ltd", "Other Co"})
        acme = next(r for r in rows if r["contractor_raw"] == "ACME Ltd")
        self.assertEqual(acme["variant_of"], "acme  ltd")
        self.assertEqual(acme["total_cost"], 100.0)

    def test_currency_symbols_do_not_break_the_cost_sum(self):
        rows, _b, _g = ma.contractor_dry_run([self.item("1", "ACME", "£1,250.50")])
        self.assertEqual(rows[0]["total_cost"], 1250.50)


class EndToEnd(unittest.TestCase):
    """Build a small export on disk and run the audit over it."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="monday-audit-test-")
        self.export = os.path.join(self.root, "export")
        self.out = os.path.join(self.root, "reports")
        maintenance = [
            {"id": "1", "name": "Incoming form answer", "state": "active",
             "group": {"id": "g1", "title": "Aldgate completed"},
             "assets": [], "updates": [
                 {"id": "u1", "text_body": "hi", "created_at": "2026-01-01", "creator": {},
                  "assets": [], "replies": [{"id": "r1", "text_body": "ok",
                                             "created_at": "2026-01-02", "creator": {},
                                             "assets": [{"id": 5}]}]}],
             "column_values": [
                 {"id": ma.COL["status"], "type": "status", "text": "Waiting for parts", "value": None},
                 {"id": ma.COL["label"], "type": "status", "text": "Lights", "value": None},
                 {"id": ma.COL["cost"], "type": "numbers", "text": "250", "value": None},
                 {"id": ma.COL["contractor"], "type": "text", "text": "ACME Ltd", "value": None},
                 {"id": ma.COL["store_location"], "type": "status",
                  "text": "Aldgate – Whitechapel Road", "value": None},
             ]},
            {"id": "2", "name": "Incoming form answer", "state": "active",
             "group": {"id": "g2", "title": "Needs attention"},
             "assets": [], "updates": [],
             "column_values": [
                 {"id": ma.COL["status"], "type": "status", "text": "Job Scheduled", "value": None},
                 {"id": ma.COL["source_number"], "type": "numbers", "text": "77", "value": None},
             ]},
        ]
        store_doc = [
            {"id": "10", "name": "Bluewater", "group": {"id": "s", "title": "Current stores"},
             "assets": [], "updates": [],
             "column_values": [
                 {"id": "files45", "type": "file", "text": "RAMS Watfrod Atria .docx",
                  "value": json.dumps({"files": [{"assetId": 900,
                                                  "name": "RAMS Watfrod Atria .docx"}]})},
                 {"id": "date0", "type": "date", "text": "2027-06-28", "value": None},
                 {"id": "text1", "type": "text", "text": "Greenhithe DA9 9ST", "value": None},
             ]},
            {"id": "11", "name": "Item 5", "group": {"id": "e", "title": "Europe"},
             "assets": [], "updates": [], "column_values": []},
        ]
        self._write("maintenance", maintenance, {"groups": [{}] * 38, "columns": [{}] * 25})
        self._write("store-documentation-uk", store_doc, {
            "groups": [{}] * 4,
            "columns": [{"id": "files45", "title": "RAMS", "type": "file"},
                        {"id": "date0", "title": "PAT Test Expiry Date", "type": "date"},
                        {"id": "text1", "title": "Store Address", "type": "text"}]})
        self._write("subitems-of-maintenance", [], {"groups": [], "columns": [], "items_count": 0})
        with open(os.path.join(self.export, "export-summary.json"), "w", encoding="utf-8") as f:
            json.dump({"status": "COMPLETE", "failures": 0, "reply_assets_exposed": "yes",
                       "boards": [
                           {"board_name": "Maintenance", "live_items": 2, "exported_items": 2,
                            "reconciled": True, "items_needing_update_follow_up": 0},
                           {"board_name": "Store Documentation UK", "live_items": 2,
                            "exported_items": 2, "reconciled": True,
                            "items_needing_update_follow_up": 0}]}, f)

    def _write(self, slug, items, schema):
        directory = os.path.join(self.export, slug)
        os.makedirs(directory, exist_ok=True)
        with open(os.path.join(directory, "items.json"), "w", encoding="utf-8") as f:
            json.dump(items, f)
        with open(os.path.join(directory, "schema.json"), "w", encoding="utf-8") as f:
            json.dump(schema, f)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_the_audit_runs_and_writes_every_report(self):
        result = subprocess.run(
            [sys.executable, os.path.join(HERE, "monday_audit.py"),
             "--export", self.export, "--out", self.out],
            capture_output=True, text=True, encoding="utf-8", errors="replace")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("reconciliation.md", "audit-maintenance.md",
                     "audit-store-documentation.md", "site-alias-mapping.csv",
                     "contractor-candidates.csv", "job-titles.csv", "subitems.md",
                     "store-doc-documents.csv", "filename-site-mismatches.csv",
                     "organisation-level-documents.csv",
                     "job-titles-and-contractors.md"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)), f"{name} missing")

        gate = open(os.path.join(self.out, "reconciliation.md"), encoding="utf-8").read()
        self.assertIn("GATE: PASS", gate)

        subitems = open(os.path.join(self.out, "subitems.md"), encoding="utf-8").read()
        self.assertIn("board is empty", subitems)

        flagged = open(os.path.join(self.out, "filename-site-mismatches.csv"),
                       encoding="utf-8-sig").read()
        self.assertIn("Watford – Atria", flagged)

        audit = open(os.path.join(self.out, "audit-maintenance.md"), encoding="utf-8").read()
        # One item sits in a "completed" group while its status says otherwise.
        self.assertIn("disagrees: **1**", audit)
        self.assertIn("\"Incoming form answer\": **2**", audit)

    def test_a_failed_reconciliation_closes_the_gate(self):
        with open(os.path.join(self.export, "export-summary.json"), encoding="utf-8") as f:
            summary = json.load(f)
        summary["boards"][0]["exported_items"] = 1
        summary["boards"][0]["reconciled"] = False
        with open(os.path.join(self.export, "export-summary.json"), "w", encoding="utf-8") as f:
            json.dump(summary, f)
        subprocess.run(
            [sys.executable, os.path.join(HERE, "monday_audit.py"),
             "--export", self.export, "--out", self.out],
            capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
        gate = open(os.path.join(self.out, "reconciliation.md"), encoding="utf-8").read()
        self.assertIn("GATE: FAIL", gate)
        self.assertIn("do not download files", gate)


if __name__ == "__main__":
    unittest.main(verbosity=2)
