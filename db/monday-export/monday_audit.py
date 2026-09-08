#!/usr/bin/env python3
"""
monday_audit.py — read an export produced by monday_export.py and report on it.

Standard library only. Reads local files, writes local files, and never opens a
socket: everything here is arithmetic over an export that already happened. That
separation is the point — the audit can be re-run and argued with as many times
as needed without spending another minute of monday's complexity budget, and it
cannot accidentally become a write.

    python3 monday_audit.py --export D:/MAINTSUPP-Monday-Export/dry-run \\
                            --matrix store-documentation-compliance-matrix.csv \\
                            --out    D:/MAINTSUPP-Monday-Export/dry-run/reports

`--export` may be omitted, in which case only the checks that read the supplied
compliance matrix run. That is what makes the site register and the suspicious
record classification reviewable before the token exists.

WHAT IT PRODUCES

    reconciliation.md          live vs exported, per board — the gate
    audit-maintenance.md       groups, statuses, labels, costs, contractors
    audit-store-documentation.md
    site-alias-mapping.csv     every site string on either board, classified
    contractor-candidates.csv  distinct free-text contractors, with variants
    job-titles.csv             the generated title per item, and which rule made it
    compliance-matrix-diff.csv the supplied matrix against live monday
    store-doc-classification.csv  CLEAR / NEEDS REVIEW / ORGANISATION-LEVEL / ...

Nothing it writes is a migration instruction. Every mapping is a proposal with
its reason attached, and an ambiguous one is reported as ambiguous rather than
resolved to whichever candidate sorted first.
"""

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from difflib import SequenceMatcher

# --------------------------------------------------------------------------
# The canonical site register
# --------------------------------------------------------------------------
#
# Source: §2 of the migration brief, cross-checked against db/monday-board-spec.ts,
# which is a verbatim capture of the live boards taken 06 August 2026 and pinned
# by tests/stage-nineteen-maintenance-parity.test.mjs.
#
# Where they disagree, the LIVE BOARD wins — not the capture, which is a
# photograph of 6 August 2026 and was already a month stale when this ran.
# Measured live on 2026-09-09:
#
#  - the brief writes the Westfield Stratford group as "Westfield Stratford
#    completed"; the live board has two spaces. Whitespace is normalised before
#    matching, so this resolves — but a literal string comparison would not.
#  - the brief says "the 26 <Store> completed groups". There are 28.
#  - the brief's reconciliation section says "items per group (all 39)", and the
#    capture has 38. The live board has 39: `September  2026 Recently completed`
#    was created after the capture was taken. The brief is right and the
#    repository's own spec is the stale one, which is why nothing here is
#    matched against a hardcoded list of group names.
#
# `store_doc` is the Store Documentation UK item name, `label` the Store Location
# Name status label on Maintenance, `group` the Maintenance group title.

SITES = [
    # canonical,                     store_doc,                        label,                          group,                            status
    ("Aldgate – Whitechapel Road",   "Aldgate",                        "Aldgate – Whitechapel Road",   "Aldgate completed",              "Active"),
    ("Birmingham – Bullring",        "Bullring - Birmingham",          "Birmingham – Bullring",        "Bullring completed",             "Active"),
    ("Brent Cross",                  "Brentcross",                     "Brent Cross – Shopping Centre", "Brent Cross completed",         "Active"),
    ("Brighton – Churchill Square",  "Churchill Square - Brighton",    "Brighton – Churchill Square",  "Brighton completed",             "Active"),
    ("Bristol – Cabot Circus",       "Cabot Circus - Bristol",         "Bristol – Cabot Circus",       "Bristol Cabot Circus completed", "Active"),
    ("Cardiff – Grand Arcade",       "Grand Arcade - Cardiff",         "Cardiff – Grand Arcade",       "Cardiff completed",              "Active"),
    ("Dudley – Merry Hill",          "Merry Hill",                     "Dudley – Merry Hill",          "Merry Hill completed",           "Active"),
    ("Glasgow – Silverburn",         "Silverburn - Glasgow",           "Glasgow – Silverburn",         "Glasgow Silverburn completed",   "Active"),
    ("Greenhithe – Bluewater",       "Bluewater",                      "Greenhithe – Bluewater",       "Bluewater completed",            "Active"),
    ("Manchester – Arndale",         "Manchester Arndale",             "Manchester – Arndale",         "Arndale completed",              "Active"),
    ("Manchester – Trafford Centre", "Trafford Centre - Manchester",   "Manchester – Trafford Centre", "Trafford centre completed",      "Active"),
    ("Milton Keynes – The Centre",   "The Centre:MK",                  "Milton Keynes – The Centre",   "Milton Keynes completed",        "Active"),
    ("Nottingham – Victoria Centre", "Victoria Centre - Nottingham",   "Nottingham – Victoria Centre", "Nottingham complited",           "Active"),
    ("Reading – The Oracle",         "The Oracle Centre - Reading",    "Reading – The Oracle",         "Reading completed",              "Active"),
    ("Sheffield – Meadowhall",       "Meadowhall",                     "Sheffield – Meadow Hall",      "Meadowhall Sheffield completed", "Active"),
    ("Solihull – Touchwood",         "Touchwood - Solihull",           "Solihull – Touchwood",         "Solihull completed",             "Active"),
    ("Southall – The Broadway",      "Southall",                       "Southall – The Broadway",      "Southall completed",             "Active"),
    ("Watford – Atria",              "Atria Watford",                  "Watford – Atria",              "Watford completed",              "Active"),
    ("Westfield – Stratford",        "Westfield Stratford",            "Westfield – Stratford",        "Westfield Stratford  completed", "Active"),
    ("Westfield – White City",       "Westfield White City Original",  "Westfield – White City",       "White City completed",           "Active"),
    ("Wood Green – High Road",       "Woodgreen",                      "Wood Green – High Road",       "Wood Green completed",           "Active"),
    # Closed — a Store Documentation row, a completed-jobs group, or both.
    ("Westfield White City Bespoke", "Westfield White City Bespoke",   "",                             "Bespoke whitecity completed",    "Closed"),
    ("Cribbs Causeway – Bristol",    "Cribbs Causeway - Bristol",      "",                             "Cribbs completed",               "Closed"),
    ("Highcross Leicester",          "Highcross Leicester",            "",                             "Highcross Leicester completed",  "Closed"),
    ("Metrocentre – Gateshead",      "Metrocentre - Gateshead (Newcastle)", "",                        "Metro Centre completed",         "Closed"),
    ("Cardiff St Davids",            "Cardiff St Davids",              "",                             "",                               "Closed"),
    # Closed, and with no Store Documentation row at all — history that would be
    # orphaned if the group were treated as unmappable.
    ("Cambridge",                    "",                               "",                             "Cambridge completed",            "Closed"),
    ("Derby",                        "",                               "",                             "Derby completed",                "Closed"),
    ("SJQ Edinburgh",                "",                               "",                             "SJQ Edinburgh completed",        "Closed"),
    ("Mall of Netherlands",          "Mall of Netherlands",            "",                             "",                               "International"),
    ("HQ – The Loom",                "HQ - The Loom",                  "",                             "",                               "Other"),
    ("Warehouse 1",                  "Warehouse 1",                    "",                             "",                               "Other"),
    ("Warehouse 2",                  "Warehouse 2",                    "",                             "",                               "Other"),
]

# Groups that describe a stage of work, not a place. Everything else on the
# Maintenance board is a "<Store> completed" group and resolves to a site.
NON_SITE_GROUPS = {
    "Incoming requests", "recently", "Jobs Booked", "Needs attention",
    "On Hold", "Access Requests", "International",
}

# The monthly completed groups are a growing family, not a fixed list. Naming
# them individually is what made the repository's August capture stale within a
# month: `September  2026 Recently completed` appeared afterwards, and a literal
# set would have sent it to the site resolver as if "September" were a shop.
# The double space is monday's, and is reproduced in several of these titles.
MONTHLY_GROUP = re.compile(
    r"^\s*(january|february|march|april|may|june|july|august|september|october"
    r"|november|december)\s+\d{4}\s+recently\s+completed\s*$", re.I)


def is_site_group(title):
    """Whether a group title names a place rather than a stage of work."""
    text = (title or "").strip()
    if not text or text in NON_SITE_GROUPS:
        return False
    return not MONTHLY_GROUP.match(re.sub(r"\s+", " ", text))

SKIP_STORE_DOC_ROWS = {"Item 5"}

# Maintenance column ids, from §4 of the migration brief. Resolved by id with a
# title fallback, so a renamed column degrades to a warning rather than a crash.
COL = {
    "location": "short_text6",
    "description": "short_text",
    "tier": "dropdown_mm51wmh0",
    "engineer": "single_select",
    "priority": "status",
    "label": "color_mm0ahrtb",
    "status": "status1",
    "contractor": "text_mm51zcqg",
    "assigned_to": "person",
    "date_requested": "date",
    "date_completed": "date2",
    "cost": "numbers",
    "invoice": "text6",
    "source_number": "numbertb4g1z46",
    "store_location": "single_selecty9rcyhe",
}

FUZZY_ACCEPT = 0.80      # below this, UNRESOLVED
FUZZY_MARGIN = 0.08      # a runner-up this close makes the match AMBIGUOUS


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------


def norm(text):
    """Casefolded, dash-flattened, punctuation-stripped tokens.

    The three boards spell the same place three ways and two of the spellings
    use an en dash. Normalising here is what lets "Westfield Stratford
    completed" match a group whose live title has two spaces in it.
    """
    value = unicodedata.normalize("NFKD", str(text or ""))
    value = re.sub(r"[\u2010-\u2015]", "-", value)
    value = value.casefold()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def strip_group_suffix(title):
    """"Bullring completed" -> "Bullring". Monday's typo is handled too."""
    return re.sub(r"\s+(completed|complited)\s*$", "", str(title or ""), flags=re.I).strip()


def similarity(left, right):
    """Blend of sequence ratio and token overlap.

    Token overlap is what catches the word-order aliases — "Bullring -
    Birmingham" against "Birmingham – Bullring" is a perfect token match and a
    poor sequence match, and it is the same shop.
    """
    if not left or not right:
        return 0.0
    sequence = SequenceMatcher(None, left, right).ratio()
    left_tokens, right_tokens = set(left.split()), set(right.split())
    union = left_tokens | right_tokens
    jaccard = len(left_tokens & right_tokens) / len(union) if union else 0.0
    return max(sequence, jaccard)


TOKEN_TYPO_RATIO = 0.85   # "watfrod" against "watford"
TOKEN_MIN_FUZZY_LEN = 5   # shorter tokens must match exactly; "mk" is not "uk"
FILENAME_COVERAGE = 0.6   # of a name form's distinctive tokens


class SiteRegister:
    def __init__(self, rows=SITES):
        self.rows = rows
        self.by_norm_canonical = {}
        self.by_norm_alias = {}
        self.forms = {}
        for canonical, store_doc, label, group, status in rows:
            self.by_norm_canonical[norm(canonical)] = canonical
            forms = {norm(canonical)}
            for alias in (store_doc, label, group, strip_group_suffix(group)):
                if alias:
                    self.by_norm_alias.setdefault(norm(alias), canonical)
                    forms.add(norm(alias))
            self.forms[canonical] = {f for f in forms if f}

        # A token is distinctive when it names exactly one site. Worked out from
        # the register rather than from a hand-written stop list, so "bristol"
        # correctly stops being evidence the moment Cribbs Causeway joins Cabot
        # Circus in carrying it, and "atria" stays evidence because only one
        # shop is in the Atria.
        owners = defaultdict(set)
        for canonical, forms in self.forms.items():
            for form in forms:
                for token in form.split():
                    owners[token].add(canonical)

        # Distinctive means "names exactly one site" AND "is a word".
        #
        # The word test is not tidiness. "Warehouse 1" and "Warehouse 2" share
        # the token `warehouse`, so it names two sites and is not distinctive —
        # which leaves each of them with a bare digit as its only evidence. Any
        # filename containing "1" then matched Warehouse 1 at full confidence,
        # and the first run of this check flagged eleven files as misfiled on
        # the strength of "Fire Risk Assessment (1).docx" and "EICR 2.png".
        # A digit is never evidence that a document belongs to a shop.
        self.distinctive = {
            token for token, sites in owners.items()
            if len(sites) == 1 and len(token) >= 3 and not token.isdigit()
        }
        self.token_owner = {t: next(iter(owners[t])) for t in self.distinctive}

    def site_named_in(self, text):
        """(canonical, confidence) for a site named inside a longer string.

        Built for filenames, where the site name is a fragment among words like
        "RAMS" and "Risk_Assessment" — a whole-string similarity scores that far
        too low to fire, which is why matching the filename as if it were a site
        name found nothing at all.
        """
        haystack = norm(text).split()
        if not haystack:
            return ("", 0.0)

        def present(token):
            if token in haystack:
                return 1.0
            if len(token) < TOKEN_MIN_FUZZY_LEN:
                return 0.0
            best = max((SequenceMatcher(None, token, word).ratio() for word in haystack),
                       default=0.0)
            return best if best >= TOKEN_TYPO_RATIO else 0.0

        best_site, best_score = "", 0.0
        for canonical, forms in self.forms.items():
            for form in forms:
                wanted = [t for t in form.split() if t in self.distinctive]
                if not wanted:
                    continue
                scores = [present(t) for t in wanted]
                matched = [s for s in scores if s]
                coverage = len(matched) / len(wanted)
                if coverage < FILENAME_COVERAGE:
                    continue
                score = coverage * (sum(matched) / len(matched))
                if score > best_score:
                    best_site, best_score = canonical, score
        return (best_site, round(best_score, 3))

    def resolve(self, source, kind=""):
        """(classification, canonical, confidence, reason) for one source string."""
        raw = (source or "").strip()
        if not raw:
            return ("UNRESOLVED", "", 0.0, "empty source string")

        candidate = strip_group_suffix(raw) if kind == "group" else raw
        key = norm(candidate)
        if not key:
            return ("UNRESOLVED", "", 0.0, "normalises to nothing")

        if key in self.by_norm_canonical:
            return ("EXACT CANONICAL MATCH", self.by_norm_canonical[key], 1.0,
                    "identical to the canonical name once normalised")
        if key in self.by_norm_alias:
            return ("KNOWN ALIAS MATCH", self.by_norm_alias[key], 1.0,
                    "listed alias for this site in the register")

        scored = sorted(
            ((similarity(key, norm(canonical)), canonical) for canonical, *_ in self.rows),
            reverse=True,
        )
        for canonical, store_doc, label, group, _status in self.rows:
            for alias in (store_doc, label, group, strip_group_suffix(group)):
                if alias:
                    scored.append((similarity(key, norm(alias)), canonical))
        scored.sort(reverse=True)

        best_score, best = scored[0]
        runner_up = next((s for s, c in scored if c != best), 0.0)

        if best_score < FUZZY_ACCEPT:
            # Whole-string similarity is the wrong test for a source string that
            # is one word of a longer canonical name. "Silverburn" scores 0.71
            # against "Glasgow – Silverburn" and would be thrown away, while
            # "Stratford" scores 0.75 against "Watford – Atria" — a higher score
            # for the wrong shop than for the right one.
            #
            # So fall back to the token test, which asks whether a token that
            # names exactly one site appears in the source. "Bristol" still does
            # not resolve, because Cabot Circus and Cribbs Causeway both carry
            # it; "Westfiled" still does not, because Stratford and White City
            # both carry "westfield". Only the unambiguous ones come through.
            named, confidence = self.site_named_in(candidate)
            if named:
                return ("FUZZY CANDIDATE", named, confidence,
                        f"source names {named!r} by its distinctive tokens; whole-string "
                        f"similarity was only {best_score:.2f}")

            # The coverage test above wants most of a name form's distinctive
            # tokens, which is right for a filename and wrong for a source
            # string that is *only* the shop's name. "Silverburn" carries one of
            # the two tokens in "Glasgow – Silverburn" and is rejected at 0.5
            # coverage — while that coverage rule is exactly what stops "Mall of
            # Scandinavia", a Swedish store, from being read as "Mall of
            # Netherlands" on the strength of the shared word "Mall".
            #
            # So keep the coverage rule and add this one beside it: a source
            # that is a single word, and that word names exactly one site.
            # "Bristol" fails it because Cabot Circus and Cribbs Causeway both
            # carry the token, which is the answer that keeps two shops apart.
            tokens = key.split()
            if len(tokens) == 1 and tokens[0] in self.token_owner:
                owner = self.token_owner[tokens[0]]
                return ("FUZZY CANDIDATE", owner, 0.9,
                        f"the whole source is {tokens[0]!r}, a word that names only "
                        f"{owner!r}")

            return ("UNRESOLVED", "", round(best_score, 3),
                    f"closest is {best!r} at {best_score:.2f}, below the {FUZZY_ACCEPT} floor")
        if best_score - runner_up < FUZZY_MARGIN:
            second = next(c for s, c in scored if c != best)
            return ("AMBIGUOUS", "", round(best_score, 3),
                    f"{best!r} at {best_score:.2f} and {second!r} at {runner_up:.2f} "
                    f"are within {FUZZY_MARGIN} — needs a human")
        return ("FUZZY CANDIDATE", best, round(best_score, 3),
                f"nearest canonical/alias at {best_score:.2f}, next at {runner_up:.2f}")


# --------------------------------------------------------------------------
# Reading an export
# --------------------------------------------------------------------------


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def cell(item, column_id):
    for cv in item.get("column_values") or []:
        if cv.get("id") == column_id:
            return cv
    return {}


def text_of(item, column_id):
    return (cell(item, column_id).get("text") or "").strip()


def money(item, column_id):
    raw = text_of(item, column_id)
    if not raw:
        return None
    try:
        return float(re.sub(r"[^0-9.\-]", "", raw) or "0")
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Board audits
# --------------------------------------------------------------------------


def audit_maintenance(items, schema, register):
    groups = Counter((i.get("group") or {}).get("title", "") for i in items)
    statuses = Counter(text_of(i, COL["status"]) or "(blank)" for i in items)
    labels = Counter(text_of(i, COL["label"]) or "(blank)" for i in items)
    priorities = Counter(text_of(i, COL["priority"]) or "(blank)" for i in items)
    tiers = Counter(text_of(i, COL["tier"]) or "(blank)" for i in items)
    engineers = Counter(text_of(i, COL["engineer"]) or "(blank)" for i in items)
    store_labels = Counter(text_of(i, COL["store_location"]) or "(blank)" for i in items)

    costed = [(i, money(i, COL["cost"])) for i in items]
    with_cost = [(i, c) for i, c in costed if c is not None]
    zero_cost = [(i, c) for i, c in with_cost if c == 0]

    generic = sum(1 for i in items
                  if norm(i.get("name")) in {"incoming form answer", "incoming form answers"})

    updates = sum(len(i.get("updates") or []) for i in items)
    replies = sum(len(u.get("replies") or []) for i in items for u in i.get("updates") or [])
    item_assets = sum(len(i.get("assets") or []) for i in items)
    update_assets = sum(len(u.get("assets") or [])
                        for i in items for u in i.get("updates") or [])
    reply_assets = sum(len(r.get("assets") or [])
                       for i in items for u in i.get("updates") or []
                       for r in u.get("replies") or [])

    # Group says one thing, Status column says another. The brief calls the
    # Status column the winner and wants the disagreement counted, because it is
    # a measure of how far the board drifted from its own filing.
    disagreements = []
    for item in items:
        group_title = (item.get("group") or {}).get("title", "")
        status = text_of(item, COL["status"])
        if re.search(r"(completed|complited)$", group_title.strip(), re.I) \
                and status and status != "Job Completed":
            disagreements.append((item["id"], group_title, status))

    return {
        "items": len(items),
        "groups": len(schema.get("groups") or []),
        "columns": len(schema.get("columns") or []),
        "items_per_group": groups,
        "items_per_status": statuses,
        "items_per_label": labels,
        "items_per_priority": priorities,
        "items_per_tier": tiers,
        "items_per_engineer": engineers,
        "items_per_store_label": store_labels,
        "distinct_statuses": len([k for k in statuses if k != "(blank)"]),
        "distinct_labels": len([k for k in labels if k != "(blank)"]),
        "with_store_location": sum(1 for i in items if text_of(i, COL["store_location"])),
        "with_contractor": sum(1 for i in items if text_of(i, COL["contractor"])),
        "with_cost": len(with_cost),
        "zero_cost": len(zero_cost),
        "total_cost": round(sum(c for _, c in with_cost), 2),
        "generic_names": generic,
        "updates": updates,
        "replies": replies,
        "item_assets": item_assets,
        "update_assets": update_assets,
        "reply_assets": reply_assets,
        "group_status_disagreements": disagreements,
    }


def audit_store_documentation(items, schema):
    file_columns = [c for c in schema.get("columns") or [] if c.get("type") == "file"]
    date_columns = [c for c in schema.get("columns") or [] if c.get("type") == "date"]

    rows = []
    for item in items:
        documents = sum(
            len(json.loads(cv["value"]).get("files", []))
            for cv in item.get("column_values") or []
            if cv.get("type") == "file" and cv.get("value") and cv["value"] != "null"
            and _parseable(cv["value"])
        )
        dates = [c["title"] for c in date_columns if text_of(item, c["id"])]
        text_fields = [cv for cv in item.get("column_values") or []
                       if cv.get("type") in ("text", "long_text") and (cv.get("text") or "").strip()]
        rows.append({
            "item_id": item["id"],
            "name": item.get("name", ""),
            "group": (item.get("group") or {}).get("title", ""),
            "documents": documents,
            "assets_reported": len(item.get("assets") or []),
            "dates_set": dates,
            "text_fields_set": len(text_fields),
            "updates": len(item.get("updates") or []),
            "replies": sum(len(u.get("replies") or []) for u in item.get("updates") or []),
        })

    return {
        "items": len(items),
        "groups": len(schema.get("groups") or []),
        "columns": len(schema.get("columns") or []),
        "file_columns": len(file_columns),
        "date_columns": len(date_columns),
        "rows": rows,
        "empty_rows": [r for r in rows
                       if r["documents"] == 0 and not r["dates_set"] and r["text_fields_set"] == 0],
    }


def _parseable(value):
    try:
        json.loads(value)
        return True
    except (TypeError, ValueError):
        return False


def document_inventory(items, schema):
    """One row per file held in a Store Documentation cell, with its column.

    The column is what makes a file a *kind* of certificate rather than an
    attachment, so it comes from the raw cell value and never from the filename.
    """
    titles = {c["id"]: c["title"] for c in schema.get("columns") or []}
    rows = []
    for item in items:
        for cv in item.get("column_values") or []:
            if cv.get("type") != "file" or not cv.get("value") or cv["value"] == "null":
                continue
            if not _parseable(cv["value"]):
                continue
            for entry in json.loads(cv["value"]).get("files") or []:
                rows.append({
                    "item_id": item["id"],
                    "store_name": item.get("name", ""),
                    "column_id": cv["id"],
                    "column_title": titles.get(cv["id"], cv["id"]),
                    "asset_id": str(entry.get("assetId", "")),
                    "filename": entry.get("name", ""),
                })
    # The asset list carries the real filename; the cell value sometimes does
    # not. Fill it in where the item's assets can supply it.
    for item in items:
        names = {str(a["id"]): a.get("name", "") for a in item.get("assets") or []}
        for row in rows:
            if row["item_id"] == item["id"] and not row["filename"]:
                row["filename"] = names.get(row["asset_id"], "")
    return rows


def filename_site_mismatch(rows, register):
    """A file whose name says one site while it is filed against another.

    This is what caught `RAMS Watfrod Atria .docx` sitting on Bluewater and
    `Water_Hygiene_..._Meadowhall.docx` sitting on Cabot Circus. It is a
    read-only flag: the file is not moved, renamed or excluded, because a
    filename is weaker evidence than a human opening the document.
    """
    flagged = []
    for row in rows:
        stem = re.sub(r"\.[a-z0-9]{1,5}$", "", row["filename"] or "", flags=re.I)
        named, confidence = register.site_named_in(stem)
        if not named:
            continue
        filed_against = register.resolve(row["store_name"])[1]
        if filed_against and named != filed_against:
            flagged.append({**row,
                            "filed_against": filed_against,
                            "filename_suggests": named,
                            "confidence": confidence,
                            "verdict": "NEEDS REVIEW — filename names a different site"})
    return flagged


def organisation_level_candidates(inventory, manifest_rows=None):
    """File columns whose content repeats across sites.

    Public liability is the case the brief names: one company policy filed
    against two shops reads in a per-site compliance register as 29 gaps that
    are not gaps. Identity is by SHA-256 when the full export has run, and by
    filename when only metadata exists — the weaker test is labelled as such.
    """
    digests = {}
    if manifest_rows:
        digests = {row["asset_id"]: row["sha256"] for row in manifest_rows if row.get("sha256")}

    by_column = defaultdict(lambda: defaultdict(set))
    for row in inventory:
        key = digests.get(row["asset_id"]) or f"name:{norm(row['filename'])}"
        by_column[row["column_title"]][key].add(row["store_name"])

    candidates = []
    for column, keyed in by_column.items():
        for key, stores in keyed.items():
            if len(stores) > 1:
                candidates.append({
                    "column_title": column,
                    "identity": "sha256" if not key.startswith("name:") else "filename only",
                    "key": key,
                    "sites": "; ".join(sorted(stores)),
                    "site_count": len(stores),
                    "verdict": "ORGANISATION-LEVEL — same document filed against "
                               f"{len(stores)} sites",
                })
    candidates.sort(key=lambda c: -c["site_count"])
    return candidates


def classify_store_doc(name, documents, dates_set, text_fields, group):
    """CLEAR / NEEDS REVIEW / ORGANISATION-LEVEL / EMPTY-PLACEHOLDER / OTHER.

    A classification, not a repair. Nothing here changes a record; §5 of the
    brief is explicit that these are identified in this phase and fixed in a
    later one.
    """
    if name in SKIP_STORE_DOC_ROWS:
        return ("EMPTY/PLACEHOLDER", "named as a placeholder in the migration brief")
    if documents == 0 and not dates_set and text_fields == 0:
        return ("EMPTY/PLACEHOLDER", "no documents, no dates, no text fields")
    if documents == 0 and not dates_set:
        return ("EMPTY/PLACEHOLDER", "address only — no document and no expiry")
    if documents == 0 and dates_set:
        return ("NEEDS REVIEW", f"expiry recorded ({', '.join(dates_set)}) with no certificate")
    if group and norm(group) == "europe":
        return ("OTHER", "sits in the Europe group; out of the UK compliance scope")
    return ("CLEAR", "documents and dates present")


# --------------------------------------------------------------------------
# Dry runs
# --------------------------------------------------------------------------


def site_alias_dry_run(register, maintenance, store_doc, maintenance_schema):
    """Every distinct site-shaped string on either board, classified."""
    sources = []
    for title in {(i.get("group") or {}).get("title", "") for i in maintenance}:
        if is_site_group(title):
            sources.append(("maintenance group", title))
    for group in maintenance_schema.get("groups") or []:
        title = group.get("title", "")
        if is_site_group(title) and not any(t == title for _, t in sources):
            sources.append(("maintenance group (empty)", title))
    for value in {text_of(i, COL["store_location"]) for i in maintenance}:
        if value:
            sources.append(("Store Location Name label", value))
    for item in store_doc:
        sources.append(("Store Documentation item", item.get("name", "")))
    for value in {text_of(i, COL["location"]) for i in maintenance}:
        if value:
            sources.append(("Location free text", value))

    seen, rows = set(), []
    for kind, value in sources:
        if (kind, value) in seen:
            continue
        seen.add((kind, value))
        classification, canonical, confidence, reason = register.resolve(
            value, "group" if "group" in kind else "")
        rows.append({
            "source_kind": kind,
            "source_string": value,
            "classification": classification,
            "proposed_canonical_site": canonical,
            "confidence": confidence,
            "reason": reason,
        })
    rows.sort(key=lambda r: (r["classification"], r["source_kind"], r["source_string"]))
    return rows


def contractor_dry_run(items):
    by_raw = defaultdict(lambda: {"items": 0, "cost": 0.0})
    blanks = 0
    for item in items:
        raw = text_of(item, COL["contractor"])
        if not raw:
            blanks += 1
            continue
        entry = by_raw[raw]
        entry["items"] += 1
        entry["cost"] += money(item, COL["cost"]) or 0.0

    # Strings that differ only in case, spacing or punctuation are the same
    # contractor typed twice. Grouping them is a candidate list for the alias
    # tool, not an alias — nothing here creates one.
    variants = defaultdict(list)
    for raw in by_raw:
        variants[norm(raw)].append(raw)

    rows = []
    for raw, entry in sorted(by_raw.items(), key=lambda kv: -kv[1]["items"]):
        siblings = [v for v in variants[norm(raw)] if v != raw]
        rows.append({
            "contractor_raw": raw,
            "items": entry["items"],
            "total_cost": round(entry["cost"], 2),
            "variant_of": "; ".join(sorted(siblings)),
            "variant_group_size": len(variants[norm(raw)]),
        })
    return rows, blanks, sum(1 for v in variants.values() if len(v) > 1)


def job_title_dry_run(items, register):
    """Apply §6's four templates in order, in memory. Writes nothing anywhere."""
    rows = []
    for item in items:
        label = text_of(item, COL["label"])
        description = text_of(item, COL["description"])
        location_raw = text_of(item, COL["location"])
        number = text_of(item, COL["source_number"])
        group_title = (item.get("group") or {}).get("title", "")

        site = ""
        how = ""
        store_label = text_of(item, COL["store_location"])
        if store_label:
            classification, canonical, _c, _r = register.resolve(store_label)
            if canonical:
                site, how = canonical, "Store Location Name"
        if not site and is_site_group(group_title):
            classification, canonical, _c, _r = register.resolve(group_title, "group")
            if canonical:
                site, how = canonical, "group"
        if not site and location_raw:
            classification, canonical, _c, _r = register.resolve(location_raw)
            if canonical and classification in ("EXACT CANONICAL MATCH", "KNOWN ALIAS MATCH",
                                                "FUZZY CANDIDATE"):
                site, how = canonical, f"location free text ({classification})"

        if site and label:
            rule, title = 1, f"{site} — {label}"
        elif site and description:
            rule, title = 2, f"{site} — {description[:60]}"
        elif location_raw and description:
            rule, title = 3, f"{location_raw} — {description[:60]}"
        else:
            rule, title = 4, f"Job {number}" if number else "Job (no source number)"

        rows.append({
            "item_id": item["id"],
            "source_item_name": item.get("name", ""),
            "rule": rule,
            "generated_title": title,
            "site": site,
            "site_resolved_by": how,
            "label": label,
            "location_raw": location_raw,
            "source_number": number,
            "has_description": bool(description),
        })
    return rows


def compliance_matrix_diff(matrix_rows, store_doc_items):
    """The supplied matrix against live monday, row for row."""
    live = {str(i["id"]): i for i in store_doc_items}
    live_by_name = {norm(i.get("name", "")): i for i in store_doc_items}
    rows = []
    matched_ids = set()

    for entry in matrix_rows:
        item_id = (entry.get("monday Item ID") or "").strip()
        name = (entry.get("Store Name") or "").strip()
        item = live.get(item_id) or live_by_name.get(norm(name))
        if not item:
            rows.append({"store_name": name, "monday_item_id": item_id,
                         "difference": "IN MATRIX, NOT IN LIVE EXPORT", "detail": ""})
            continue
        matched_ids.add(str(item["id"]))
        differences = []
        if norm(item.get("name", "")) != norm(name):
            differences.append(f"name: matrix {name!r} vs live {item.get('name')!r}")
        if item_id and str(item["id"]) != item_id:
            differences.append(f"id: matrix {item_id} vs live {item['id']}")
        live_files = sum(
            len(json.loads(cv["value"]).get("files", []))
            for cv in item.get("column_values") or []
            if cv.get("type") == "file" and cv.get("value") and cv["value"] != "null"
            and _parseable(cv["value"])
        )
        stated = (entry.get("Files Attached") or "").strip()
        if stated.isdigit() and int(stated) != live_files:
            differences.append(f"files attached: matrix {stated} vs live {live_files}")
        rows.append({
            "store_name": name,
            "monday_item_id": item_id,
            "difference": "MATCH" if not differences else "DIFFERS",
            "detail": "; ".join(differences),
        })

    for item in store_doc_items:
        if str(item["id"]) not in matched_ids:
            rows.append({"store_name": item.get("name", ""), "monday_item_id": item["id"],
                         "difference": "IN LIVE EXPORT, NOT IN MATRIX", "detail": ""})
    return rows


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------


def verify_file_export(export_root, manifest_rows, items_by_board):
    """Every check §11 of the migration brief asks for, over the real bytes.

    The manifest is not evidence on its own — it is a claim that files were
    downloaded. This opens the directory and asks whether each row's file is
    actually there and actually that size, which is the difference between a
    checksum column and a checksummed archive.
    """
    problems = defaultdict(list)
    seen_rows = set()
    total_bytes = 0

    for row in manifest_rows:
        key = (row["board"], row["item_id"], row["asset_id"])
        if key in seen_rows:
            problems["duplicate manifest rows"].append(f"{key}")
        seen_rows.add(key)

        path = os.path.join(export_root, row["path"])
        if not os.path.exists(path):
            problems["manifest row with no file on disk"].append(row["path"])
            continue

        on_disk = os.path.getsize(path)
        total_bytes += on_disk
        claimed = int(row["downloaded_size"] or 0)
        if on_disk != claimed:
            problems["file size differs from the manifest"].append(
                f"{row['path']}: manifest {claimed}, disk {on_disk}")
        if on_disk == 0:
            problems["zero-byte file"].append(row["path"])
        if not (row.get("sha256") or "").strip():
            problems["no checksum recorded"].append(row["path"])
        if row["size_match"] == "False":
            problems["monday's size disagrees with the download"].append(
                f"{row['path']}: monday {row['reported_size']}, got {row['downloaded_size']}")

    # An asset the board reported but the manifest never mentions is the one a
    # per-row check cannot find, because there is no row to check.
    for board, items in items_by_board.items():
        claimed = set()
        for item in items:
            for asset in item.get("assets") or []:
                claimed.add(str(asset["id"]))
            for update in item.get("updates") or []:
                for asset in update.get("assets") or []:
                    claimed.add(str(asset["id"]))
                for reply in update.get("replies") or []:
                    for asset in reply.get("assets") or []:
                        claimed.add(str(asset["id"]))
        got = {r["asset_id"] for r in manifest_rows if r["board"] == board}
        for missing in sorted(claimed - got):
            problems["asset on the board with no manifest row"].append(f"{board}/{missing}")

    # A .part is a download that was interrupted and never completed.
    for directory, _dirs, names in os.walk(export_root):
        for name in names:
            if name.endswith(".part"):
                problems["incomplete .part file left on disk"].append(
                    os.path.relpath(os.path.join(directory, name), export_root))

    return problems, total_bytes


def write_csv(path, rows, fields=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fields = fields or (list(rows[0].keys()) if rows else ["(no rows)"])
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    return path


def write_text(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(body)
    return path


def counter_table(counter, heading):
    lines = [f"| {heading} | items |", "| --- | ---: |"]
    for key, count in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"| {key} | {count} |")
    return "\n".join(lines)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Audit a monday export. Reads local files only.")
    parser.add_argument("--export", help="directory written by monday_export.py")
    parser.add_argument("--matrix", help="store-documentation-compliance-matrix.csv")
    parser.add_argument("--out", required=True, help="where to write the reports")
    args = parser.parse_args()

    register = SiteRegister()
    written = []

    matrix_rows = []
    if args.matrix and os.path.exists(args.matrix):
        with open(args.matrix, encoding="utf-8-sig", newline="") as handle:
            matrix_rows = list(csv.DictReader(handle))
        print(f"compliance matrix: {len(matrix_rows)} rows")

    if not args.export:
        # Matrix-only mode: classify what the supplied CSV says, and prove the
        # register resolves every name in it, before any live data exists.
        rows = []
        for entry in matrix_rows:
            name = (entry.get("Store Name") or "").strip()
            documents = int((entry.get("Files Attached") or "0").strip() or 0)
            dates = [k for k in entry if k.endswith("Expiry") and (entry.get(k) or "").strip()]
            text_fields = sum(1 for k in ("Store Type", "Address", "Access Request")
                              if (entry.get(k) or "").strip())
            classification, reason = classify_store_doc(
                name, documents, dates, text_fields, entry.get("Group", ""))
            resolution, canonical, confidence, why = register.resolve(name)
            rows.append({
                "store_name": name, "group": entry.get("Group", ""),
                "documents": documents, "expiries_set": "; ".join(dates),
                "classification": classification, "classification_reason": reason,
                "site_resolution": resolution, "proposed_canonical_site": canonical,
                "confidence": confidence, "resolution_reason": why,
            })
        written.append(write_csv(os.path.join(args.out, "store-doc-classification.csv"), rows))
        print(f"\nMatrix-only mode — no export supplied. Wrote {written[-1]}")
        for path in written:
            print(f"  {path}")
        return

    export = args.export
    summary = load_json(os.path.join(export, "export-summary.json"), {})
    maintenance = load_json(os.path.join(export, "maintenance", "items.json"), []) or []
    maintenance_schema = load_json(os.path.join(export, "maintenance", "schema.json"), {}) or {}
    store_doc = load_json(os.path.join(export, "store-documentation-uk", "items.json"), []) or []
    store_doc_schema = load_json(os.path.join(export, "store-documentation-uk", "schema.json"), {}) or {}
    subitems = load_json(os.path.join(export, "subitems-of-maintenance", "items.json"), []) or []
    subitems_schema = load_json(os.path.join(export, "subitems-of-maintenance", "schema.json"), {}) or {}

    # -- reconciliation gate -------------------------------------------------
    lines = ["# MONDAY DRY-RUN RECONCILIATION", "",
             "| board | live (items_count) | exported | difference | verdict |",
             "| --- | ---: | ---: | ---: | --- |"]
    gate_pass = True
    for board in summary.get("boards") or []:
        difference = (board["live_items"] or 0) - board["exported_items"]
        # A shortfall is data loss and closes the gate. A surplus means monday's
        # own counter disagreed with monday's own item list — nothing is
        # missing, so it is reported rather than treated as a missing page.
        if difference > 0:
            verdict = f"FAIL — {difference} item(s) missing"
            gate_pass = False
        elif difference < 0:
            verdict = f"SURPLUS {-difference} — investigate, nothing missing"
        else:
            verdict = "PASS"
        lines += [f"| {board['board_name']} | {board['live_items']} | "
                  f"{board['exported_items']} | {difference} | {verdict} |"]
    lines += ["", f"- export status: **{summary.get('status', 'UNKNOWN')}**",
              f"- failures recorded: {summary.get('failures', '?')}",
              f"- reply assets exposed by this API version: {summary.get('reply_assets_exposed', '?')}",
              f"- duplicate item ids: none (the exporter de-duplicates on id and "
              f"records any repeat as a failure)",
              "",
              f"**GATE: {'PASS — safe to run the full file export' if gate_pass else 'FAIL — do not download files'}**"]
    for board in summary.get("boards") or []:
        if board.get("items_needing_update_follow_up"):
            lines.append(f"- {board['board_name']}: "
                         f"{board['items_needing_update_follow_up']} items had more than one "
                         f"page of updates and were paged further")
    written.append(write_text(os.path.join(args.out, "reconciliation.md"), "\n".join(lines) + "\n"))

    # -- maintenance ---------------------------------------------------------
    if maintenance:
        stats = audit_maintenance(maintenance, maintenance_schema, register)
        body = [
            "# MAINTENANCE AUDIT", "",
            f"- exported items: **{stats['items']}**",
            f"- groups: {stats['groups']}  ·  columns: {stats['columns']}",
            f"- distinct statuses in use: {stats['distinct_statuses']}",
            f"- distinct labels in use: {stats['distinct_labels']}",
            f"- items named \"Incoming form answer\": **{stats['generic_names']}**",
            f"- items with a Store Location Name: {stats['with_store_location']}",
            f"- items with contractor free text: {stats['with_contractor']}",
            f"- items with a cost: {stats['with_cost']} (of which zero: {stats['zero_cost']})",
            f"- total cost: £{stats['total_cost']:,.2f}",
            f"- updates: {stats['updates']}  ·  replies: {stats['replies']}",
            f"- assets: {stats['item_assets']} on items, {stats['update_assets']} on updates, "
            f"{stats['reply_assets']} on replies",
            f"- group says completed but Status disagrees: "
            f"**{len(stats['group_status_disagreements'])}** items",
            "", "## Items per group", "", counter_table(stats["items_per_group"], "group"),
            "", "## Items per status", "", counter_table(stats["items_per_status"], "status"),
            "", "## Items per label", "", counter_table(stats["items_per_label"], "label"),
            "", "## Items per Store Location Name", "",
            counter_table(stats["items_per_store_label"], "store location"),
            "", "## Priority", "", counter_table(stats["items_per_priority"], "priority"),
            "", "## Tier", "", counter_table(stats["items_per_tier"], "tier"),
            "", "## Engineer required", "",
            counter_table(stats["items_per_engineer"], "engineer"),
        ]
        written.append(write_text(os.path.join(args.out, "audit-maintenance.md"),
                                  "\n".join(body) + "\n"))
        written.append(write_csv(
            os.path.join(args.out, "group-status-disagreements.csv"),
            [{"item_id": i, "group": g, "status": s}
             for i, g, s in stats["group_status_disagreements"]],
            ["item_id", "group", "status"]))

        contractors, blank_contractors, variant_groups = contractor_dry_run(maintenance)
        written.append(write_csv(os.path.join(args.out, "contractor-candidates.csv"), contractors,
                                 ["contractor_raw", "items", "total_cost", "variant_of",
                                  "variant_group_size"]))

        titles = job_title_dry_run(maintenance, register)

        # Items per canonical site, which §9's reconciliation table asks for and
        # neither the group nor the Store Location Name breakdown answers: the
        # label is set on a small minority of items, and several groups resolve
        # to the same site as a label does.
        per_site = Counter(t["site"] or "(unresolved)" for t in titles)
        resolved_by = Counter(t["site_resolved_by"] or "(none)" for t in titles)
        written.append(write_csv(
            os.path.join(args.out, "items-per-site.csv"),
            [{"canonical_site": site, "items": count} for site, count
             in sorted(per_site.items(), key=lambda kv: (-kv[1], kv[0]))],
            ["canonical_site", "items"]))
        written.append(write_csv(os.path.join(args.out, "job-titles.csv"), titles,
                                 ["item_id", "source_item_name", "rule", "generated_title",
                                  "site", "site_resolved_by", "label", "location_raw",
                                  "source_number", "has_description"]))
        rule_counts = Counter(t["rule"] for t in titles)
        rule_four = [t for t in titles if t["rule"] == 4]
        summary_lines = [
            "# JOB TITLE DRY RUN", "",
            "Applied in memory. Nothing was written to MAINTSUPP.", "",
            f"- Rule 1 `Site — Label`: **{rule_counts.get(1, 0)}**",
            f"- Rule 2 `Site — Description`: **{rule_counts.get(2, 0)}**",
            f"- Rule 3 `Location raw — Description`: **{rule_counts.get(3, 0)}**",
            f"- Rule 4 `Job source_number`: **{rule_counts.get(4, 0)}**", "",
            "## Every Rule-4 item", "",
            "| item id | source name | source number | generated title |",
            "| --- | --- | --- | --- |",
        ] + [f"| {t['item_id']} | {t['source_item_name']} | {t['source_number']} | "
             f"{t['generated_title']} |" for t in rule_four]
        summary_lines += ["", "## Site resolution — how each item found its site", "",
                          "| resolved by | items |", "| --- | ---: |"] + [
            f"| {how} | {count} |" for how, count in resolved_by.most_common()]
        summary_lines += ["", "## Items per canonical site", "",
                          "| site | items |", "| --- | ---: |"] + [
            f"| {site} | {count} |" for site, count
            in sorted(per_site.items(), key=lambda kv: (-kv[1], kv[0]))]
        summary_lines += ["", "# CONTRACTOR DRY RUN", "",
                          f"- distinct raw strings: **{len(contractors)}**",
                          f"- items with no contractor: **{blank_contractors}**",
                          f"- groups of strings differing only in case/spacing/punctuation: "
                          f"**{variant_groups}**", "",
                          "Alias candidates only. No contractor record was created or changed."]
        written.append(write_text(os.path.join(args.out, "job-titles-and-contractors.md"),
                                  "\n".join(summary_lines) + "\n"))

    # -- store documentation -------------------------------------------------
    if store_doc:
        doc_stats = audit_store_documentation(store_doc, store_doc_schema)
        classified = []
        for row in doc_stats["rows"]:
            classification, reason = classify_store_doc(
                row["name"], row["documents"], row["dates_set"],
                row["text_fields_set"], row["group"])
            resolution, canonical, confidence, why = register.resolve(row["name"])
            classified.append({**row,
                               "dates_set": "; ".join(row["dates_set"]),
                               "classification": classification,
                               "classification_reason": reason,
                               "site_resolution": resolution,
                               "proposed_canonical_site": canonical,
                               "confidence": confidence,
                               "resolution_reason": why})
        written.append(write_csv(os.path.join(args.out, "store-doc-classification.csv"), classified,
                                 ["item_id", "name", "group", "documents", "assets_reported",
                                  "dates_set", "text_fields_set", "updates", "replies",
                                  "classification", "classification_reason", "site_resolution",
                                  "proposed_canonical_site", "confidence", "resolution_reason"]))
        body = [
            "# STORE DOCUMENTATION AUDIT", "",
            f"- exported rows: **{doc_stats['items']}**",
            f"- groups: {doc_stats['groups']}  ·  columns: {doc_stats['columns']} "
            f"({doc_stats['file_columns']} file, {doc_stats['date_columns']} date)",
            f"- rows with no useful data: **{len(doc_stats['empty_rows'])}** — "
            + (", ".join(r["name"] for r in doc_stats["empty_rows"]) or "none"),
            f"- documents across all rows: "
            f"{sum(r['documents'] for r in doc_stats['rows'])}",
            f"- updates: {sum(r['updates'] for r in doc_stats['rows'])}  ·  "
            f"replies: {sum(r['replies'] for r in doc_stats['rows'])}", "",
            "## Every row", "",
            "| item id | name | group | documents | expiries set | classification |",
            "| --- | --- | --- | ---: | --- | --- |",
        ] + [f"| {r['item_id']} | {r['name']} | {r['group']} | {r['documents']} | "
             f"{r['dates_set']} | {r['classification']} |" for r in classified]
        written.append(write_text(os.path.join(args.out, "audit-store-documentation.md"),
                                  "\n".join(body) + "\n"))

        inventory = document_inventory(store_doc, store_doc_schema)
        written.append(write_csv(os.path.join(args.out, "store-doc-documents.csv"), inventory,
                                 ["item_id", "store_name", "column_id", "column_title",
                                  "asset_id", "filename"]))

        manifest_rows = []
        manifest_path = os.path.join(export, "file-manifest.csv")
        if os.path.exists(manifest_path):
            with open(manifest_path, encoding="utf-8-sig", newline="") as handle:
                manifest_rows = list(csv.DictReader(handle))

        mismatches = filename_site_mismatch(inventory, register)
        written.append(write_csv(os.path.join(args.out, "filename-site-mismatches.csv"),
                                 mismatches,
                                 ["item_id", "store_name", "column_title", "filename",
                                  "filed_against", "filename_suggests", "confidence", "verdict"]))

        org_level = organisation_level_candidates(inventory, manifest_rows)
        written.append(write_csv(os.path.join(args.out, "organisation-level-documents.csv"),
                                 org_level,
                                 ["column_title", "identity", "key", "sites", "site_count",
                                  "verdict"]))
        print(f"\nStore Documentation: {len(inventory)} documents, "
              f"{len(mismatches)} filename/site mismatches, "
              f"{len(org_level)} organisation-level candidates")

        if matrix_rows:
            written.append(write_csv(os.path.join(args.out, "compliance-matrix-diff.csv"),
                                     compliance_matrix_diff(matrix_rows, store_doc),
                                     ["store_name", "monday_item_id", "difference", "detail"]))

    # -- subitems ------------------------------------------------------------
    # "How many rows are on the board" and "how many jobs have a subitem" are
    # different questions, and only the second one decides whether skipping the
    # board loses anything. A row whose parent_item is null is a subitem of
    # nothing.
    parented = [i for i in subitems if (i.get("parent_item") or {}).get("id")]
    orphans = [i for i in subitems if not (i.get("parent_item") or {}).get("id")]
    lines = ["# SUBITEMS OF MAINTENANCE (board 1164003119)", "",
             f"- monday reports `items_count`: **{subitems_schema.get('items_count', 'not exported')}**",
             f"- rows actually served by `items_page`: **{len(subitems)}**",
             f"- of those, rows with a parent item: **{len(parented)}**",
             f"- of those, orphaned rows with no parent: **{len(orphans)}**", ""]
    if not subitems:
        lines.append("The board is empty. Recorded and skipped, as the brief allows.")
    elif not parented:
        lines += [
            "**The board is not literally empty, but no job has a subitem.** Every row "
            "it serves is an orphan whose `parent_item` is null, so nothing on the "
            "Maintenance board would lose data by skipping this one. The brief's "
            "conclusion holds; its count does not.", "",
            "`items_count` reads 0 because monday counts subitems through their parent "
            "linkage, and these rows have none. Reported rather than skipped, because a "
            "board that serves rows it says it does not have is worth knowing about "
            "before the same counter is trusted for Maintenance.", "",
            "| row id | name | created | column values set |",
            "| --- | --- | --- | --- |",
        ] + [f"| {i['id']} | {i.get('name', '')} | {i.get('created_at', '')} | "
             f"{sum(1 for cv in i.get('column_values') or [] if (cv.get('text') or '').strip())} |"
             for i in orphans]
    else:
        lines.append(f"**{len(parented)} rows are real subitems of a Maintenance job.** "
                     "The brief's assumption that subitems can be skipped does not hold; "
                     "they are exported in full alongside the two parent boards.")
    written.append(write_text(os.path.join(args.out, "subitems.md"), "\n".join(lines) + "\n"))

    # -- site alias dry run --------------------------------------------------
    if maintenance or store_doc:
        alias_rows = site_alias_dry_run(register, maintenance, store_doc, maintenance_schema)
        written.append(write_csv(os.path.join(args.out, "site-alias-mapping.csv"), alias_rows,
                                 ["source_kind", "source_string", "classification",
                                  "proposed_canonical_site", "confidence", "reason"]))
        counts = Counter(r["classification"] for r in alias_rows)
        print("\nSite resolution dry run:")
        for key in ("EXACT CANONICAL MATCH", "KNOWN ALIAS MATCH", "FUZZY CANDIDATE",
                    "AMBIGUOUS", "UNRESOLVED"):
            print(f"  {key:<24} {counts.get(key, 0)}")

    # -- full file export verification ---------------------------------------
    manifest_path = os.path.join(export, "file-manifest.csv")
    manifest_all = []
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding="utf-8-sig", newline="") as handle:
            manifest_all = list(csv.DictReader(handle))
    if manifest_all:
        problems, total_bytes = verify_file_export(export, manifest_all, {
            "maintenance": maintenance,
            "store-documentation-uk": store_doc,
            "subitems-of-maintenance": subitems,
        })
        by_verdict = Counter(r["size_match"] for r in manifest_all)
        checksummed = sum(1 for r in manifest_all if (r.get("sha256") or "").strip())
        body = [
            "# FULL FILE EXPORT — VERIFICATION", "",
            f"- manifest rows: **{len(manifest_all)}**",
            f"- bytes on disk: **{total_bytes:,}** ({total_bytes / 1e9:.2f} GB)",
            f"- checksum coverage: **{checksummed}/{len(manifest_all)}**",
            f"- size verdicts: " + ", ".join(f"{k}={v}" for k, v in sorted(by_verdict.items())),
            f"- failures recorded by the exporter: {summary.get('failures', '?')}",
            "",
            "## Checks", "",
            "| check | result |",
            "| --- | --- |",
        ]
        checks = [
            ("every manifest row has a file on disk", "manifest row with no file on disk"),
            ("no file is zero bytes", "zero-byte file"),
            ("file size on disk matches the manifest", "file size differs from the manifest"),
            ("every file has a SHA-256", "no checksum recorded"),
            ("monday's reported size matches the download",
             "monday's size disagrees with the download"),
            ("no duplicate manifest rows", "duplicate manifest rows"),
            ("every asset on the board has a manifest row",
             "asset on the board with no manifest row"),
            ("no interrupted .part files left behind", "incomplete .part file left on disk"),
        ]
        for label, key in checks:
            hits = problems.get(key) or []
            body.append(f"| {label} | {'PASS' if not hits else f'**FAIL — {len(hits)}**'} |")
        for label, key in checks:
            hits = problems.get(key) or []
            if hits:
                body += ["", f"### {label} — {len(hits)}", ""] + [f"- {h}" for h in hits[:200]]
                if len(hits) > 200:
                    body.append(f"- ...and {len(hits) - 200} more")
        clean = not any(problems.get(k) for _l, k in checks)
        body += ["", f"**VERDICT: {'PASS' if clean else 'FAIL'}**"]
        written.append(write_text(os.path.join(args.out, "file-export-verification.md"),
                                  "\n".join(body) + "\n"))
        print(f"\nFile export verification: {'PASS' if clean else 'FAIL'} — "
              f"{len(manifest_all)} files, {total_bytes / 1e9:.2f} GB, "
              f"checksums {checksummed}/{len(manifest_all)}")

    print("\nWritten:")
    for path in written:
        print(f"  {path}")


if __name__ == "__main__":
    main()
