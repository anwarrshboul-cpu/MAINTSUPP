#!/usr/bin/env python3
"""
monday_export.py — read-only export of the MAINTSUPP source boards from monday.com.

Standard library only. Nothing is written anywhere but the output directory, and
nothing is written to monday at all: every query in this file is a read.

  Maintenance             board 1139774521  -> Jobs
  Store Documentation UK  board 1398027719  -> Store Documentation + Compliance
  Subitems of Maintenance board 1164003119  -> verified, and exported if non-empty

USAGE
-----
    export MONDAY_API_TOKEN="..."            # never passed on the command line
    python3 monday_export.py --no-files --out /path/dry-run     # metadata only
    python3 monday_export.py --out /path/full                   # metadata + bytes
    python3 monday_export.py --board 1398027719                 # one board

Exit status is 0 only when every board reconciled and no failure was recorded.
A non-zero status, or `"status": "INCOMPLETE"` in export-summary.json, means the
export must not be treated as a source for migration.

OUTPUT
------
    <out>/
      api-capabilities.json   what this API version actually exposes (see below)
      <board-slug>/
        schema.json           columns, groups, item count as monday reports it
        items.json            every item: raw + display column values, assets
        items.csv             flat table for spreadsheet review
        updates.json          every update and reply, threaded
        updates.csv
        files/<item_id>/<asset_id>_<filename>
      file-manifest.csv       one row per downloaded asset, with checksum
      failures.csv            everything that did not export, with the reason
      export-summary.json     counts for reconciliation, and the COMPLETE verdict

WHY THIS DIFFERS FROM THE SCRIPT IT REPLACES

Six corrections, each one a silent data loss in the original:

1. `Item.updates` defaults to 25 per item. Asking for `updates` with no limit
   therefore truncates every conversation longer than that, without an error.
   This pages updates explicitly and follows up per item when a page comes back
   full, and reports how many items needed the follow-up.

2. Paging continued through `items_page(cursor:)`. The documented continuation
   is the top-level `next_items_page`, which is what `pull-monday-api.mjs` in
   this directory has always used against this account. A cursor the server
   ignores re-serves page one forever, so there is also a duplicate-id guard.

3. Assets were mapped back to their column by regex over the cell's *display
   text*. The raw cell value carries `{"files":[{"assetId":...}]}` — an id, not
   a rendering. Without it a PAT certificate is indistinguishable from a fire
   door report, which is the whole of the compliance import.

4. `size_match` compared monday's `file_size` (a string on this API version)
   against an int, so it read False for every file ever downloaded and the
   integrity check meant nothing. Sizes are coerced, and "unknown" is a distinct
   verdict from "False".

5. A download that failed all its retries left a truncated file on disk with no
   manifest row. Bytes land in `.part` and are renamed only once complete.

6. Asset URLs expire in about an hour, and a full run is longer than that. A
   download that fails on an expired URL now re-reads `public_url` for that
   asset and retries, rather than recording a failure that is really a clock.

Plus two things the original could not answer: whether this API version exposes
assets on *replies* (introspected at runtime, recorded in api-capabilities.json,
and included in the query when it does), and whether an interrupted run has to
start again (it does not — see --resume).
"""

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API_URL = "https://api.monday.com/v2"

# 2025-07, not the 2024-10 the .mjs pullers use.
#
# `Reply.assets` does not exist before 2025-07. Introspected against this
# account on 2026-09-09: 2024-10, 2025-01 and 2025-04 expose twelve Reply
# fields and none of them is `assets`; 2025-07 and every version after it expose
# thirteen, including it. On the older versions an attachment on a reply is not
# merely unrequested, it is unreachable — which is why the supplied exporter
# could not have captured one however it was written.
#
# The oldest version that answers, rather than the newest available: it is the
# smallest step away from the shape the rest of this directory is proven
# against. Verified on 2025-07 before the bump — items_page, next_items_page,
# column_values{id type text value}, Item.state, Item.assets and the updates
# block all behave as they do on 2024-10.
API_VERSION = "2025-07"

BOARDS = {
    "1139774521": "maintenance",
    "1398027719": "store-documentation-uk",
    "1164003119": "subitems-of-maintenance",
}

# 50 for plain items, 25 once updates are attached. Monday bills a query by
# complexity and refuses the whole page when the budget is spent, so a smaller
# page is not slower in practice — it is the difference between finishing and
# not. These are the sizes pull-monday-api.mjs and pull-monday-comments.mjs
# have used against this account.
ITEM_PAGE_SIZE = 50
UPDATE_PAGE_SIZE = 25
UPDATES_PER_ITEM = 25

MAX_RETRIES = 5
RETRY_BASE_SECONDS = 3
DOWNLOAD_ATTEMPTS = 3

# Monday signs an asset URL for about an hour. Re-read any URL older than this
# before spending a download attempt on it.
URL_STALE_SECONDS = 45 * 60

failures = []  # dicts: scope, identifier, reason


def note_failure(scope, identifier, reason):
    failures.append({"scope": scope, "identifier": str(identifier), "reason": str(reason)[:400]})


# --------------------------------------------------------------------------
# API plumbing
# --------------------------------------------------------------------------


def api(token, query, variables=None):
    """POST a GraphQL read, waiting out rate limits and complexity exhaustion.

    The token is placed in the Authorization header and nowhere else. It is
    never printed, never returned, and never written to any output file.
    """
    payload = json.dumps({"query": query, "variables": variables or {}}).encode()

    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(
            API_URL,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": token,
                "API-Version": API_VERSION,
                "User-Agent": "maintsupp-export/2.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            # 429 carries Retry-After; the 5xx family is worth waiting out.
            if exc.code == 429 and attempt < MAX_RETRIES:
                wait = int(exc.headers.get("Retry-After") or 30)
                print(f"    rate limited, waiting {wait}s (attempt {attempt})")
                time.sleep(wait)
                continue
            if exc.code in (500, 502, 503, 504) and attempt < MAX_RETRIES:
                wait = RETRY_BASE_SECONDS * (2**attempt)
                print(f"    HTTP {exc.code}, waiting {wait}s (attempt {attempt})")
                time.sleep(wait)
                continue
            # Deliberately does not include the request headers.
            raise RuntimeError(f"monday API HTTP {exc.code}: {exc.reason}") from None
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BASE_SECONDS * attempt)
                continue
            raise RuntimeError(f"monday API unreachable: {exc}") from None

        if body.get("errors"):
            message = json.dumps(body["errors"])
            wait = retry_after_seconds(message)
            if wait is not None and attempt < MAX_RETRIES:
                print(f"    complexity budget spent, waiting {wait}s (attempt {attempt})")
                time.sleep(wait)
                continue
            raise RuntimeError(f"monday API: {message[:600]}")

        if "data" not in body:
            raise RuntimeError(f"monday API returned no data: {json.dumps(body)[:400]}")
        return body["data"]

    raise RuntimeError("exhausted retries")


def retry_after_seconds(message):
    """Seconds to wait for a throttling error, or None if it is not one.

    Monday reports complexity exhaustion as an HTTP 200 with an error body that
    names the reset window, so the wait comes from the message rather than from
    a header.
    """
    named = re.search(r"reset in (\d+) seconds", message)
    if named:
        return int(named.group(1)) + 2
    lowered = message.lower()
    if "complexity" in lowered or "rate limit" in lowered or "budget exhausted" in lowered:
        return 30
    return None


CAPABILITY_QUERY = """
query {
  item:   __type(name: "Item")   { fields { name args { name } } }
  update: __type(name: "Update") { fields { name args { name } } }
  reply:  __type(name: "Reply")  { fields { name args { name } } }
  asset:  __type(name: "Asset")  { fields { name args { name } } }
}
"""


# What to ask for when introspection is unavailable. Every field here is one
# `pull-monday-api.mjs` and `pull-monday-comments.mjs` have read from this
# account on API 2024-10, so the fallback is known to work — it simply cannot
# know whether a newer field such as Reply.assets exists.
FALLBACK_CAPS = {
    "item": {"id": [], "name": [], "url": [], "created_at": [], "updated_at": [],
             "state": [], "creator": [], "group": [], "column_values": [],
             "assets": [], "updates": ["limit", "page"]},
    "update": {"id": [], "body": [], "text_body": [], "created_at": [],
               "updated_at": [], "creator": [], "assets": [], "replies": []},
    "reply": {"id": [], "body": [], "text_body": [], "created_at": [],
              "updated_at": [], "creator": []},
    "asset": {"id": [], "name": [], "file_extension": [], "file_size": [],
              "public_url": [], "created_at": [], "uploaded_by": []},
}


def read_capabilities(token):
    """Ask the API what it exposes, rather than assuming a shape.

    Reply assets are the reason this exists. Whether `Reply.assets` is a field
    depends on the API version, and guessing either drops attachments silently
    or fails the whole query. Introspection settles it, and the answer lands in
    api-capabilities.json as evidence for the export report.

    A server with introspection disabled falls back to the fields this account
    is known to serve — loudly, because the fallback cannot answer the reply
    question and the report must not claim that it did.
    """
    try:
        data = api(token, CAPABILITY_QUERY)
    except RuntimeError as exc:
        note_failure("api", "introspection", f"{exc} — fell back to known 2024-10 fields")
        print(f"  introspection unavailable ({exc}); using known-good field set")
        return dict(FALLBACK_CAPS), False

    caps = {}
    for key in ("item", "update", "reply", "asset"):
        type_info = data.get(key) or {}
        fields = {}
        for field in type_info.get("fields") or []:
            fields[field["name"]] = sorted(a["name"] for a in field.get("args") or [])
        # A type that introspects to nothing would build invalid GraphQL, or
        # worse, a valid query that silently selects no updates at all.
        caps[key] = fields or dict(FALLBACK_CAPS[key])
        if not fields:
            note_failure("api", f"__type({key})", "introspected to no fields; used fallback")
    return caps, True


def asset_selection(caps):
    """The Asset fields this API version actually has, in a stable order."""
    available = caps.get("asset", {})
    wanted = [
        "id",
        "name",
        "file_extension",
        "file_size",
        "public_url",
        "created_at",
        "uploaded_by { id name email }",
    ]
    return "\n          ".join(f for f in wanted if f.split(" ")[0].split("{")[0].strip() in available)


def update_selection(caps):
    """The updates block, built from what Update and Reply expose here.

    `updates(limit:, page:)` is always explicit: the field defaults to 25 and a
    silently truncated conversation is indistinguishable from a short one.
    """
    assets = asset_selection(caps)
    update_fields = caps.get("update", {})
    reply_fields = caps.get("reply", {})

    reply_wanted = ["id", "body", "text_body", "created_at", "updated_at"]
    reply_block = [f for f in reply_wanted if f in reply_fields]
    if "creator" in reply_fields:
        reply_block.append("creator { id name email }")
    if "assets" in reply_fields and assets:
        reply_block.append("assets {\n            " + assets + "\n          }")

    update_wanted = ["id", "body", "text_body", "created_at", "updated_at"]
    update_block = [f for f in update_wanted if f in update_fields]
    if "creator" in update_fields:
        update_block.append("creator { id name email }")
    if "assets" in update_fields and assets:
        update_block.append("assets {\n          " + assets + "\n        }")
    if "replies" in update_fields and reply_block:
        update_block.append("replies {\n          " + "\n          ".join(reply_block) + "\n        }")

    return "\n        ".join(update_block)


def item_selection(caps):
    """The item block for the metadata pass — no updates, which page separately."""
    fields = caps.get("item", {})
    wanted = ["id", "name", "url", "created_at", "updated_at", "state"]
    block = [f for f in wanted if f in fields]
    if "creator" in fields:
        block.append("creator { id name email }")
    if "group" in fields:
        block.append("group { id title }")
    if "parent_item" in fields:
        # Null on a normal board, and the whole answer on a subitem board: a
        # row whose parent_item is null is not a subitem of anything. Board
        # 1164003119 serves exactly one such row while reporting items_count=0,
        # and without this the export cannot tell an orphaned template stub
        # from a real subitem carrying job data.
        block.append("parent_item { id name board { id name } }")
    block.append("column_values { id type text value }")
    assets = asset_selection(caps)
    if assets:
        block.append("assets {\n        " + assets + "\n      }")
    return "\n      ".join(block)


SCHEMA_QUERY = """
query ($board: ID!) {
  boards(ids: [$board]) {
    id
    name
    state
    items_count
    groups { id title }
    columns { id title type settings_str }
  }
}
"""


def fetch_schema(token, board_id):
    boards = api(token, SCHEMA_QUERY, {"board": board_id}).get("boards") or []
    if not boards:
        raise RuntimeError(
            f"board {board_id} returned nothing — wrong id, or the token cannot read it"
        )
    return boards[0]


def paged_board_read(token, board_id, selection, page_size, label):
    """Every item on a board, following the cursor to the end.

    The first page comes from `boards { items_page }` and every page after it
    from the top-level `next_items_page`, which is monday's documented
    continuation. Two guards sit on the loop: a cursor a server ignores would
    otherwise re-serve page one forever, and a page that adds no new id means
    the cursor has stopped moving.
    """
    first = f"""
query ($board: ID!, $limit: Int!) {{
  boards(ids: [$board]) {{
    items_page(limit: $limit) {{ cursor items {{ {selection} }} }}
  }}
}}
"""
    following = f"""
query ($limit: Int!, $cursor: String!) {{
  next_items_page(limit: $limit, cursor: $cursor) {{ cursor items {{ {selection} }} }}
}}
"""

    items, seen, cursor, page = [], set(), None, 0
    while True:
        page += 1
        if cursor is None:
            data = api(token, first, {"board": board_id, "limit": page_size})
            block = (data.get("boards") or [{}])[0].get("items_page") or {}
        else:
            data = api(token, following, {"limit": page_size, "cursor": cursor})
            block = data.get("next_items_page") or {}

        fresh = [i for i in block.get("items") or [] if i["id"] not in seen]
        duplicates = len(block.get("items") or []) - len(fresh)
        if duplicates:
            note_failure(label, f"page {page}", f"{duplicates} duplicate item ids re-served")
        for item in fresh:
            seen.add(item["id"])
        items.extend(fresh)

        next_cursor = block.get("cursor")
        print(f"  {label} page {page}: {len(items)} items")
        if not next_cursor:
            break
        if not fresh:
            note_failure(label, f"page {page}", "cursor advanced but returned no new items")
            break
        cursor = next_cursor
    return items


def fetch_updates(token, board_id, caps, label):
    """Every update and reply, with the per-item cap paged past rather than hit.

    Returns (updates_by_item_id, follow_up_count). The second value is evidence
    for the report: it is the number of items whose conversation was longer than
    one page, which is exactly the data the previous exporter dropped.
    """
    selection = update_selection(caps)
    if not selection:
        return {}, 0

    board_selection = f"""id
      updates(limit: {UPDATES_PER_ITEM}, page: 1) {{
        {selection}
      }}"""
    rows = paged_board_read(token, board_id, board_selection, UPDATE_PAGE_SIZE, f"{label} updates")

    by_item, follow_ups = {}, 0
    for row in rows:
        by_item[row["id"]] = list(row.get("updates") or [])

    per_item = f"""
query ($ids: [ID!], $limit: Int!, $page: Int!) {{
  items(ids: $ids) {{
    id
    updates(limit: $limit, page: $page) {{
      {selection}
    }}
  }}
}}
"""
    for item_id, collected in by_item.items():
        if len(collected) < UPDATES_PER_ITEM:
            continue
        follow_ups += 1
        page = 2
        while True:
            data = api(token, per_item, {"ids": [item_id], "limit": UPDATES_PER_ITEM, "page": page})
            more = ((data.get("items") or [{}])[0] or {}).get("updates") or []
            known = {u["id"] for u in collected}
            fresh = [u for u in more if u["id"] not in known]
            collected.extend(fresh)
            print(f"    item {item_id}: update page {page} -> {len(collected)} updates")
            if len(more) < UPDATES_PER_ITEM or not fresh:
                break
            page += 1

    return by_item, follow_ups


ASSET_URL_QUERY = """
query ($ids: [ID!]) { assets(ids: $ids) { id public_url } }
"""


def refresh_public_url(token, asset_id):
    """Re-read one asset's signed URL. Expiry is a clock, not a failure."""
    try:
        assets = api(token, ASSET_URL_QUERY, {"ids": [str(asset_id)]}).get("assets") or []
    except RuntimeError:
        return None
    for asset in assets:
        if str(asset.get("id")) == str(asset_id):
            return asset.get("public_url")
    return None


# --------------------------------------------------------------------------
# Local helpers
# --------------------------------------------------------------------------


def safe_name(text, fallback="file"):
    """A filename Windows will accept, short enough to survive MAX_PATH.

    120 rather than 150: the deepest path this writes is
    <out>\\<board>\\files\\<item id>\\<asset id>_<name>, and the export root is a
    dated directory the operator chooses. 120 leaves headroom under 260.
    """
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(text)).strip().strip(".")
    return cleaned[:120] or fallback


def coerce_int(value):
    """Monday reports file_size as a string on some API versions and an int on
    others. Both mean bytes."""
    if value is None or value == "":
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def size_verdict(reported, downloaded):
    """True / False / unknown — three answers, not two.

    The exporter this replaces asked `file_size in (None, "", size)`, which is
    False whenever monday sends the size as a string. Every row read False, so
    the check that was supposed to catch a truncated download caught nothing.
    """
    expected = coerce_int(reported)
    if expected is None:
        return "unknown"
    return "True" if expected == downloaded else "False"


def hash_file(path):
    sha = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 256)
            if not chunk:
                break
            sha.update(chunk)
            size += len(chunk)
    return size, sha.hexdigest()


def download(url, dest_path):
    """Stream an asset to disk, and only name it once it is whole.

    Bytes land in `<dest>.part`. A run interrupted mid-file leaves a `.part`
    that the next run overwrites, never a truncated file that looks complete.
    """
    os.makedirs(os.path.dirname(dest_path), exist_ok=True)
    part = dest_path + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": "maintsupp-export/2.0"})
    sha = hashlib.sha256()
    size = 0
    try:
        with urllib.request.urlopen(req, timeout=300) as resp, open(part, "wb") as out:
            content_type = resp.headers.get("Content-Type", "")
            while True:
                chunk = resp.read(1024 * 256)
                if not chunk:
                    break
                out.write(chunk)
                sha.update(chunk)
                size += len(chunk)
        os.replace(part, dest_path)
    except BaseException:
        if os.path.exists(part):
            os.remove(part)
        raise
    return size, sha.hexdigest(), content_type


def asset_column_index(item):
    """Which file column an asset came from.

    `item.assets` is flat and carries no column, so the mapping comes from the
    file column's own raw value — `{"files":[{"assetId":123,...}]}`. That is an
    id the API gave us. Parsing the cell's *display text* for `/resources/<n>/`,
    which is what the supplied exporter did, depends on how monday chose to
    render a link that day; it is kept only as a fallback for a cell whose raw
    value will not parse.
    """
    index = {}
    for cv in item.get("column_values") or []:
        if cv.get("type") != "file":
            continue
        raw = cv.get("value")
        parsed = None
        if raw and raw != "null":
            try:
                parsed = json.loads(raw)
            except (TypeError, ValueError):
                parsed = None
        if isinstance(parsed, dict):
            for entry in parsed.get("files") or []:
                if entry.get("assetId") is not None:
                    index[str(entry["assetId"])] = cv["id"]
            continue
        for resource_id in re.findall(r"/resources/(\d+)/", cv.get("text") or ""):
            index.setdefault(resource_id, cv["id"])
    return index


def csv_headers(column_titles):
    """Column titles for the flat CSV, with collisions made distinct.

    Two monday columns may share a title, and a column may be titled the same as
    one of the fixed item fields. Either would drop a column out of the CSV
    without saying so.
    """
    fixed = ["item_id", "item_name", "group", "state", "created_at", "updated_at",
             "creator", "url", "update_count", "asset_count"]
    used = set(fixed)
    names = {}
    for column_id, title in column_titles.items():
        candidate = title or column_id
        if candidate in used:
            candidate = f"{candidate} ({column_id})"
        used.add(candidate)
        names[column_id] = candidate
    return fixed, names


def flatten_item(item, header_names):
    row = {
        "item_id": item["id"],
        "item_name": item.get("name", ""),
        "group": (item.get("group") or {}).get("title", ""),
        "state": item.get("state", ""),
        "created_at": item.get("created_at", ""),
        "updated_at": item.get("updated_at", ""),
        "creator": (item.get("creator") or {}).get("name", ""),
        "url": item.get("url", ""),
        "update_count": len(item.get("updates") or []),
        "asset_count": len(item.get("assets") or []),
    }
    for cv in item.get("column_values") or []:
        row[header_names.get(cv["id"], cv["id"])] = cv.get("text") or ""
    return row


def flatten_updates(items):
    """Updates and replies as one threaded, flat list."""
    rows = []
    for item in items:
        for update in item.get("updates") or []:
            rows.append(update_row(item, update, parent=None))
            for reply in update.get("replies") or []:
                rows.append(update_row(item, reply, parent=update))
    return rows


def update_row(item, entry, parent):
    creator = entry.get("creator") or {}
    return {
        "item_id": item["id"],
        "item_name": item.get("name", ""),
        "update_id": entry["id"],
        "is_reply": bool(parent),
        "parent_update_id": parent["id"] if parent else "",
        "author": creator.get("name", ""),
        "author_email": creator.get("email", "") or "",
        "created_at": entry.get("created_at", ""),
        "updated_at": entry.get("updated_at", "") or "",
        "text": entry.get("text_body", "") or "",
        "html": entry.get("body", "") or "",
        "asset_count": len(entry.get("assets") or []),
        "asset_ids": ";".join(str(a["id"]) for a in entry.get("assets") or []),
    }


UPDATE_CSV_FIELDS = [
    "item_id", "item_name", "update_id", "is_reply", "parent_update_id",
    "author", "author_email", "created_at", "updated_at", "text", "html",
    "asset_count", "asset_ids",
]

MANIFEST_FIELDS = [
    "board", "item_id", "item_name", "source", "column_id", "column_title",
    "asset_id", "filename", "extension", "content_type", "reported_size",
    "downloaded_size", "size_match", "sha256", "path", "asset_created_at",
    "uploaded_by", "reused_existing",
]


def write_csv(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------


def export_metadata(token, board_id, out_root, caps):
    """Everything but the bytes. Runs for every board before any file is read."""
    slug = BOARDS.get(board_id, f"board-{board_id}")
    out_dir = os.path.join(out_root, slug)
    os.makedirs(out_dir, exist_ok=True)

    schema = fetch_schema(token, board_id)
    expected = schema.get("items_count")
    column_titles = {c["id"]: c["title"] for c in schema["columns"]}
    print(f"\n=== {schema['name']} (board {board_id}) — monday reports {expected} items")

    with open(os.path.join(out_dir, "schema.json"), "w", encoding="utf-8") as handle:
        json.dump(schema, handle, indent=2, ensure_ascii=False)

    items = paged_board_read(token, board_id, item_selection(caps), ITEM_PAGE_SIZE, slug)

    updates_by_item, follow_ups = ({}, 0)
    if items:
        updates_by_item, follow_ups = fetch_updates(token, board_id, caps, slug)
        # The updates pass walks the board a second time. An item the first pass
        # saw and the second did not would silently record zero updates, which
        # reads exactly like an item nobody ever commented on.
        missed = [i["id"] for i in items if i["id"] not in updates_by_item]
        if missed:
            note_failure(slug, f"{len(missed)} items",
                         "present in the item pass but absent from the updates pass: "
                         + ",".join(missed[:20]))
        for item in items:
            item["updates"] = updates_by_item.get(item["id"], [])

    with open(os.path.join(out_dir, "items.json"), "w", encoding="utf-8") as handle:
        json.dump(items, handle, indent=2, ensure_ascii=False)

    fixed, header_names = csv_headers(column_titles)
    headers = fixed + [header_names[c["id"]] for c in schema["columns"]]
    write_csv(os.path.join(out_dir, "items.csv"), headers,
              [flatten_item(i, header_names) for i in items])

    update_rows = flatten_updates(items)
    with open(os.path.join(out_dir, "updates.json"), "w", encoding="utf-8") as handle:
        json.dump(update_rows, handle, indent=2, ensure_ascii=False)
    write_csv(os.path.join(out_dir, "updates.csv"), UPDATE_CSV_FIELDS, update_rows)

    reported_assets = sum(len(i.get("assets") or []) for i in items)
    reported_assets += sum(len(u.get("assets") or [])
                           for i in items for u in i.get("updates") or [])
    reported_assets += sum(len(r.get("assets") or [])
                           for i in items for u in i.get("updates") or []
                           for r in u.get("replies") or [])

    # A shortfall and a surplus are not the same event, and treating them alike
    # is how a gate ends up refusing an export that lost nothing.
    #
    # exported < live means items are MISSING — a page was dropped, and no
    # amount of downloading photographs afterwards makes that recoverable.
    # exported > live means monday's own counter disagreed with monday's own
    # item list. Nothing is missing; something is unexplained. Board 1164003119
    # does exactly this: items_count reads 0 while items_page serves one
    # orphaned row whose parent_item is null.
    #
    # So the shortfall blocks the file run and the surplus is recorded as a
    # failure — visible in failures.csv, and enough to keep the export out of
    # COMPLETE until a human has said what it is.
    shortfall = (expected or 0) - len(items)
    if shortfall < 0:
        note_failure(slug, f"board {board_id}",
                     f"monday reports items_count={expected} but items_page served "
                     f"{len(items)}; {-shortfall} more item(s) exist than the board "
                     f"counter claims. Nothing is missing — investigate what the "
                     f"extra row(s) are before trusting the counter elsewhere.")

    summary = {
        "board_id": board_id,
        "board_slug": slug,
        "board_name": schema["name"],
        "live_items": expected,
        "exported_items": len(items),
        "reconciled": expected == len(items),
        "shortfall": shortfall,
        "groups": len(schema["groups"]),
        "columns": len(schema["columns"]),
        "updates": len([r for r in update_rows if not r["is_reply"]]),
        "replies": len([r for r in update_rows if r["is_reply"]]),
        "items_needing_update_follow_up": follow_ups,
        "assets_reported": reported_assets,
    }
    return summary, items, slug, column_titles


def export_files(token, boards, out_root, resume):
    """Download every asset on every item, update and reply."""
    manifest = []
    for board in boards:
        slug = board["slug"]
        out_dir = os.path.join(out_root, slug)
        print(f"\n--- files: {slug}")
        for item in board["items"]:
            item_dir = os.path.join(out_dir, "files", str(item["id"]))
            columns = asset_column_index(item)
            seen = {}

            def grab(asset, source, column_id=""):
                asset_id = str(asset["id"])
                if asset_id in seen:
                    seen[asset_id]["source"] += f";{source}"
                    return
                name = safe_name(asset.get("name") or f"asset_{asset_id}")
                dest = os.path.join(item_dir, f"{asset_id}_{name}")
                row = download_asset(token, asset, dest, out_root, slug, item,
                                     source, column_id, board["column_titles"], resume)
                if row:
                    seen[asset_id] = row
                    manifest.append(row)

            for asset in item.get("assets") or []:
                grab(asset, "item", columns.get(str(asset["id"]), ""))
            for update in item.get("updates") or []:
                for asset in update.get("assets") or []:
                    grab(asset, f"update:{update['id']}")
                for reply in update.get("replies") or []:
                    for asset in reply.get("assets") or []:
                        grab(asset, f"reply:{reply['id']}")
    return manifest


def download_asset(token, asset, dest, out_root, slug, item, source, column_id,
                   column_titles, resume):
    asset_id = str(asset["id"])
    reported = coerce_int(asset.get("file_size"))

    def row(size, digest, content_type, reused):
        return {
            "board": slug,
            "item_id": item["id"],
            "item_name": item.get("name", ""),
            "source": source,
            "column_id": column_id,
            "column_title": column_titles.get(column_id, ""),
            "asset_id": asset_id,
            "filename": asset.get("name", ""),
            "extension": asset.get("file_extension", "") or "",
            "content_type": content_type,
            "reported_size": "" if reported is None else reported,
            "downloaded_size": size,
            "size_match": size_verdict(asset.get("file_size"), size),
            "sha256": digest,
            "path": os.path.relpath(dest, out_root),
            "asset_created_at": asset.get("created_at", "") or "",
            "uploaded_by": (asset.get("uploaded_by") or {}).get("name", "") or "",
            "reused_existing": reused,
        }

    # Resume: a file already on disk is re-hashed locally, never trusted on its
    # name alone. Hashing local bytes is cheap; re-downloading them is not.
    if resume and os.path.exists(dest):
        size, digest = hash_file(dest)
        if size > 0 and (reported is None or reported == size):
            return row(size, digest, "", "yes")
        print(f"    {asset_id}: on disk at {size}B, monday says {reported}B — re-downloading")

    url = asset.get("public_url")
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        if not url:
            url = refresh_public_url(token, asset_id)
        if not url:
            note_failure(slug, f"asset {asset_id} on item {item['id']}",
                         "no public_url available, before or after refresh")
            return None
        try:
            size, digest, content_type = download(url, dest)
            if size == 0:
                raise RuntimeError("downloaded 0 bytes")
            return row(size, digest, content_type, "no")
        except Exception as exc:  # noqa: BLE001 — every failure is recorded, none is raised
            if attempt == DOWNLOAD_ATTEMPTS:
                note_failure(slug, f"asset {asset_id} {asset.get('name', '')} "
                                   f"on item {item['id']}", exc)
                return None
            # An expired signature is the common failure on a long run, and it
            # looks like a 403. Re-read the URL rather than retrying a dead one.
            url = refresh_public_url(token, asset_id)
            time.sleep(RETRY_BASE_SECONDS * attempt)
    return None


def main():
    global API_VERSION

    if hasattr(sys.stdout, "reconfigure"):
        # Board and site names carry en dashes; a Windows console defaults to a
        # codepage that cannot encode them and would abort the run on a print.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Read-only export of the MAINTSUPP monday boards.")
    parser.add_argument("--out", default="export", help="output directory (keep it outside the repo)")
    parser.add_argument("--board", action="append", help="board id; repeatable. Default: all three")
    parser.add_argument("--no-files", action="store_true", help="metadata only, skip downloads")
    parser.add_argument("--no-resume", action="store_true",
                        help="re-download files that are already on disk and verified")
    parser.add_argument("--force-files", action="store_true",
                        help="download files even if a board did not reconcile")
    parser.add_argument("--api-version", default=API_VERSION,
                        help=f"monday API version (default {API_VERSION}; "
                             "anything before 2025-07 cannot see reply assets)")
    args = parser.parse_args()
    API_VERSION = args.api_version

    token = os.environ.get("MONDAY_API_TOKEN")
    if not token:
        sys.exit(
            "MONDAY_API_TOKEN_REQUIRED\n"
            "  bash:       export MONDAY_API_TOKEN='...'\n"
            "  PowerShell: $env:MONDAY_API_TOKEN = '...'\n"
            "The token is read from the environment only — never pass it as an argument."
        )

    board_ids = [str(b) for b in (args.board or list(BOARDS.keys()))]
    os.makedirs(args.out, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()

    caps, introspected = read_capabilities(token)
    reply_assets = ("yes" if "assets" in caps.get("reply", {})
                    else "no") if introspected else "unknown (introspection unavailable)"
    with open(os.path.join(args.out, "api-capabilities.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "api_version": API_VERSION,
            "introspected": introspected,
            "reply_assets_exposed": reply_assets,
            "item_updates_args": caps.get("item", {}).get("updates", []),
            "types": caps,
        }, handle, indent=2)
    print(f"API {API_VERSION}: reply assets exposed = {reply_assets}")

    boards, summaries = [], []
    for board_id in board_ids:
        summary, items, slug, column_titles = export_metadata(token, board_id, args.out, caps)
        summaries.append(summary)
        boards.append({"slug": slug, "items": items, "column_titles": column_titles})

    reconciled = all(s["reconciled"] for s in summaries)
    short = [s for s in summaries if s["shortfall"] > 0]
    manifest = []
    files_run = False
    if not args.no_files:
        if not short or args.force_files:
            files_run = True
            manifest = export_files(token, boards, args.out, not args.no_resume)
        else:
            for s in short:
                print(f"\n{s['board_name']}: {s['shortfall']} item(s) MISSING "
                      f"({s['exported_items']} of {s['live_items']}).")
            print("Refusing to download files onto an incomplete item list. "
                  "Fix the metadata pass first, or pass --force-files deliberately.")

    write_csv(os.path.join(args.out, "file-manifest.csv"), MANIFEST_FIELDS, manifest)
    write_csv(os.path.join(args.out, "failures.csv"),
              ["scope", "identifier", "reason"], failures)

    mismatches = [m for m in manifest if m["size_match"] == "False"]
    complete = reconciled and not failures and not mismatches and (files_run or args.no_files)
    result = {
        "started_utc": started,
        "finished_utc": datetime.now(timezone.utc).isoformat(),
        "api_version": API_VERSION,
        "reply_assets_exposed": reply_assets,
        "files_requested": not args.no_files,
        "files_downloaded": files_run,
        "boards": summaries,
        "total_files": len(manifest),
        "total_bytes": sum(m["downloaded_size"] for m in manifest),
        "size_mismatches": len(mismatches),
        "checksum_coverage": f"{len([m for m in manifest if m['sha256']])}/{len(manifest)}",
        "failures": len(failures),
        "status": "COMPLETE" if complete else "INCOMPLETE",
    }
    with open(os.path.join(args.out, "export-summary.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)

    print("\n" + "=" * 64)
    for s in summaries:
        verdict = ("OK" if s["reconciled"]
                   else f"MISSING {s['shortfall']}" if s["shortfall"] > 0
                   else f"SURPLUS {-s['shortfall']}")
        print(f"{s['board_name']}: {s['exported_items']}/{s['live_items']} items  [{verdict}]")
        print(f"   groups {s['groups']}  columns {s['columns']}  "
              f"updates {s['updates']}  replies {s['replies']}  "
              f"assets reported {s['assets_reported']}")
        if s["items_needing_update_follow_up"]:
            print(f"   {s['items_needing_update_follow_up']} items had more than "
                  f"{UPDATES_PER_ITEM} updates and were paged further")
    if files_run:
        print(f"\nFiles: {len(manifest)}  {result['total_bytes'] / 1e6:.1f} MB  "
              f"checksums {result['checksum_coverage']}  size mismatches {len(mismatches)}")
    print(f"Failures: {len(failures)}" + ("  <-- see failures.csv" if failures else ""))
    print(f"\nSTATUS: {result['status']}")
    print(f"Output: {os.path.abspath(args.out)}")

    sys.exit(0 if complete else 1)


if __name__ == "__main__":
    main()
