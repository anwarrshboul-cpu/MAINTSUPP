#!/usr/bin/env python3
"""
Tests for the pure logic in monday_export.py.

    python3 db/monday-export/test_monday_export.py

Nothing here touches the network. Every function under test is one that decides
what lands in the export or how it is verified, which is where the previous
exporter's silent losses were: a size check that could not fail, an asset that
could not name its column, a reply whose attachments were never asked for.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import monday_export as mx  # noqa: E402


class SizeVerdict(unittest.TestCase):
    """The check the original exporter could not pass.

    monday returns `file_size` as a string on API 2024-10. The original asked
    `file_size in (None, "", size)`, so "12345" was never equal to 12345 and
    every manifest row read size_match=False — a truncation alarm that fired on
    every file and therefore meant nothing.
    """

    def test_string_size_matches_int_download(self):
        self.assertEqual(mx.size_verdict("12345", 12345), "True")

    def test_int_size_matches(self):
        self.assertEqual(mx.size_verdict(12345, 12345), "True")

    def test_short_download_is_a_mismatch(self):
        self.assertEqual(mx.size_verdict("12345", 999), "False")

    def test_absent_size_is_unknown_not_a_pass(self):
        # A missing size must not read as agreement; the migration gate counts
        # "unknown" separately from "verified".
        self.assertEqual(mx.size_verdict(None, 999), "unknown")
        self.assertEqual(mx.size_verdict("", 999), "unknown")

    def test_unparseable_size_is_unknown(self):
        self.assertEqual(mx.size_verdict("about 12 KB", 999), "unknown")

    def test_coerce_handles_whitespace(self):
        self.assertEqual(mx.coerce_int(" 42 "), 42)
        self.assertIsNone(mx.coerce_int(None))


class AssetColumnMapping(unittest.TestCase):
    """Which certificate is which.

    Store Documentation carries eleven file columns, and a PAT certificate is
    only distinguishable from a fire door report by the column it sits in.
    """

    def test_raw_value_asset_id_wins(self):
        item = {"column_values": [
            {"id": "files0", "type": "file", "text": "PAT.pdf",
             "value": json.dumps({"files": [{"assetId": 111, "name": "PAT.pdf"}]})},
            {"id": "files4", "type": "file", "text": "EICR.pdf",
             "value": json.dumps({"files": [{"assetId": 222, "name": "EICR.pdf"}]})},
        ]}
        self.assertEqual(mx.asset_column_index(item), {"111": "files0", "222": "files4"})

    def test_several_files_in_one_column(self):
        item = {"column_values": [
            {"id": "files45", "type": "file", "text": "a.docx, b.docx",
             "value": json.dumps({"files": [{"assetId": 1}, {"assetId": 2}]})},
        ]}
        self.assertEqual(mx.asset_column_index(item), {"1": "files45", "2": "files45"})

    def test_display_text_is_only_a_fallback(self):
        # No parseable raw value, so the rendered link is all there is.
        item = {"column_values": [
            {"id": "files0", "type": "file",
             "text": "https://x.monday.com/resources/987/PAT.pdf", "value": None},
        ]}
        self.assertEqual(mx.asset_column_index(item), {"987": "files0"})

    def test_null_string_value_is_not_parsed_as_json(self):
        item = {"column_values": [
            {"id": "files0", "type": "file", "text": "", "value": "null"},
        ]}
        self.assertEqual(mx.asset_column_index(item), {})

    def test_non_file_columns_are_ignored(self):
        item = {"column_values": [
            {"id": "text1", "type": "text", "text": "/resources/555/x.pdf", "value": '"x"'},
        ]}
        self.assertEqual(mx.asset_column_index(item), {})

    def test_malformed_json_falls_back_rather_than_raising(self):
        item = {"column_values": [
            {"id": "files0", "type": "file",
             "text": "https://x.monday.com/resources/42/a.pdf", "value": "{not json"},
        ]}
        self.assertEqual(mx.asset_column_index(item), {"42": "files0"})


class Filenames(unittest.TestCase):
    def test_path_separators_are_replaced(self):
        self.assertEqual(mx.safe_name("a/b\\c.pdf"), "a_b_c.pdf")

    def test_long_names_stay_under_the_windows_path_budget(self):
        self.assertEqual(len(mx.safe_name("x" * 400)), 120)

    def test_empty_name_gets_a_fallback(self):
        self.assertEqual(mx.safe_name("..."), "file")


class CsvHeaders(unittest.TestCase):
    """Two monday columns may share a title, and one may be titled like a fixed
    field. Either collision silently drops a column out of items.csv."""

    def test_duplicate_titles_are_disambiguated_by_column_id(self):
        fixed, names = mx.csv_headers({"a": "Date", "b": "Date"})
        self.assertEqual(names["a"], "Date")
        self.assertEqual(names["b"], "Date (b)")

    def test_a_column_titled_like_a_fixed_field_does_not_overwrite_it(self):
        fixed, names = mx.csv_headers({"c": "item_name"})
        self.assertIn("item_name", fixed)
        self.assertEqual(names["c"], "item_name (c)")

    def test_untitled_column_falls_back_to_its_id(self):
        _, names = mx.csv_headers({"d": ""})
        self.assertEqual(names["d"], "d")


class UpdateFlattening(unittest.TestCase):
    def test_a_reply_keeps_its_parent(self):
        items = [{
            "id": "1", "name": "Job",
            "updates": [{
                "id": "u1", "text_body": "called them", "body": "<p>called them</p>",
                "created_at": "2026-01-01T00:00:00Z", "creator": {"name": "A", "email": "a@x"},
                "replies": [{"id": "r1", "text_body": "no answer", "body": "<p>no answer</p>",
                             "created_at": "2026-01-02T00:00:00Z",
                             "creator": {"name": "B", "email": "b@x"}}],
            }],
        }]
        rows = mx.flatten_updates(items)
        self.assertEqual(len(rows), 2)
        self.assertFalse(rows[0]["is_reply"])
        self.assertTrue(rows[1]["is_reply"])
        self.assertEqual(rows[1]["parent_update_id"], "u1")
        self.assertEqual(rows[1]["author_email"], "b@x")

    def test_reply_assets_are_counted_not_hardcoded_to_zero(self):
        # The original wrote "asset_count": 0 for every reply, so an attachment
        # on a reply was invisible in the export even when the API returned it.
        items = [{
            "id": "1", "name": "Job",
            "updates": [{
                "id": "u1", "created_at": "", "creator": {},
                "replies": [{"id": "r1", "created_at": "", "creator": {},
                             "assets": [{"id": 9}, {"id": 10}]}],
            }],
        }]
        rows = mx.flatten_updates(items)
        self.assertEqual(rows[1]["asset_count"], 2)
        self.assertEqual(rows[1]["asset_ids"], "9;10")

    def test_every_row_fits_the_declared_csv_fields(self):
        items = [{"id": "1", "name": "J", "updates": [
            {"id": "u1", "created_at": "", "creator": {}, "replies": []}]}]
        for row in mx.flatten_updates(items):
            self.assertEqual(set(row), set(mx.UPDATE_CSV_FIELDS))


class QueryConstruction(unittest.TestCase):
    """The generated GraphQL has to be valid whatever the API exposes."""

    @staticmethod
    def balanced(fragment):
        depth = 0
        for char in fragment:
            depth += (char == "{") - (char == "}")
            if depth < 0:
                return False
        return depth == 0

    def test_reply_assets_are_requested_when_the_api_exposes_them(self):
        caps = json.loads(json.dumps(mx.FALLBACK_CAPS))
        caps["reply"]["assets"] = []
        selection = mx.update_selection(caps)
        self.assertIn("replies {", selection)
        self.assertEqual(selection.count("assets {"), 2)  # update's and the reply's
        self.assertTrue(self.balanced(selection))

    def test_reply_assets_are_not_requested_when_absent(self):
        selection = mx.update_selection(mx.FALLBACK_CAPS)
        self.assertEqual(selection.count("assets {"), 1)
        self.assertTrue(self.balanced(selection))

    def test_updates_are_never_requested_without_an_explicit_limit(self):
        # Item.updates defaults to 25. The whole point of fetch_updates is that
        # the limit is stated and paged past, so it must appear in the query.
        self.assertIn("limit", mx.FALLBACK_CAPS["item"]["updates"])

    def test_a_type_with_no_fields_produces_no_empty_selection_set(self):
        caps = json.loads(json.dumps(mx.FALLBACK_CAPS))
        caps["reply"] = {}
        selection = mx.update_selection(caps)
        self.assertNotIn("replies {", selection)
        self.assertTrue(self.balanced(selection))

    def test_item_selection_always_carries_the_id_it_dedupes_on(self):
        self.assertIn("id", mx.item_selection(mx.FALLBACK_CAPS).split())
        self.assertTrue(self.balanced(mx.item_selection(mx.FALLBACK_CAPS)))

    def test_asset_selection_skips_fields_this_version_lacks(self):
        caps = json.loads(json.dumps(mx.FALLBACK_CAPS))
        del caps["asset"]["uploaded_by"]
        self.assertNotIn("uploaded_by", mx.asset_selection(caps))
        self.assertIn("public_url", mx.asset_selection(caps))


class Throttling(unittest.TestCase):
    def test_named_reset_window_is_honoured(self):
        self.assertEqual(
            mx.retry_after_seconds('[{"message":"Complexity budget exhausted, '
                                   'reset in 41 seconds"}]'), 43)

    def test_unnamed_complexity_error_gets_a_default_wait(self):
        self.assertEqual(mx.retry_after_seconds('[{"message":"COMPLEXITY_EXCEPTION"}]'), 30)

    def test_an_ordinary_error_is_not_retried(self):
        self.assertIsNone(mx.retry_after_seconds('[{"message":"Board not found"}]'))


class ShortfallVersusSurplus(unittest.TestCase):
    """Missing items and extra items are not the same event.

    Board 1164003119 reports items_count=0 and serves one orphaned row, so a
    gate that only asks "did the numbers match" refuses a file run over an
    export that lost nothing at all.
    """

    @staticmethod
    def shortfall(live, exported):
        return (live or 0) - exported

    def test_a_missing_item_is_a_shortfall(self):
        self.assertGreater(self.shortfall(774, 770), 0)

    def test_an_extra_item_is_not_a_shortfall(self):
        self.assertLess(self.shortfall(0, 1), 0)

    def test_an_exact_match_is_neither(self):
        self.assertEqual(self.shortfall(774, 774), 0)

    def test_a_surplus_still_records_a_failure(self):
        # Nothing is missing, but monday's own counter disagreed with monday's
        # own item list, and that must not vanish into a green summary.
        mx.failures.clear()
        try:
            shortfall = self.shortfall(0, 1)
            if shortfall < 0:
                mx.note_failure("subitems", "board 1164003119", "items_count=0, served 1")
            self.assertEqual(len(mx.failures), 1)
            self.assertIn("1164003119", mx.failures[0]["identifier"])
        finally:
            mx.failures.clear()


class Manifest(unittest.TestCase):
    def test_manifest_records_everything_the_migration_gate_reads(self):
        for field in ("board", "item_id", "source", "column_id", "column_title",
                      "asset_id", "filename", "extension", "content_type",
                      "reported_size", "downloaded_size", "size_match", "sha256",
                      "path", "asset_created_at", "uploaded_by"):
            self.assertIn(field, mx.MANIFEST_FIELDS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
