"""The mod_sort table: bucket/rank/flags/lock CRUD and the deterministic
heuristic pass. This is what both the heuristic sort and the LLM refine
(llm_refine.py) read and write for persistence -- LOOT handles plugin load
order separately; this is the MO2 left-panel *install* order (file
conflicts)."""

import json

from . import buckets, db, mo2

BUCKETS = buckets.BUCKETS


def _write_ranks(conn, unlocked_ids):
    """Assign global ranks: locked mods stay pinned at their saved rank,
    unlocked mods (already ordered) fill the remaining slots around them."""
    locked = conn.execute(
        "SELECT mod_id, rank FROM mod_sort WHERE locked = 1"
        " AND mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok') ORDER BY rank"
    ).fetchall()
    total = len(unlocked_ids) + len(locked)
    slots = [None] * total
    for r in locked:
        i = min(r["rank"] or 0, total - 1)
        while slots[i] is not None:  # collision: next free slot downward
            i = (i + 1) % total
        slots[i] = r["mod_id"]
    it = iter(unlocked_ids)
    for i in range(total):
        if slots[i] is None:
            slots[i] = next(it)
    for rank, mod_id in enumerate(slots):
        conn.execute(
            "INSERT INTO mod_sort (mod_id, rank) VALUES (?, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank",
            (mod_id, rank),
        )


def _upsert_sort(conn, mod_id, bucket=None, flags=None, expected=True):
    conn.execute(
        "INSERT INTO mod_sort (mod_id, bucket, flags, expected_bucket) VALUES (?, ?, ?, ?)"
        " ON CONFLICT(mod_id) DO UPDATE SET bucket = excluded.bucket, flags = excluded.flags"
        + (", expected_bucket = excluded.expected_bucket" if expected else ""),
        (mod_id, bucket, flags, bucket if expected else None),
    )


def heuristic_sort():
    """Bucket every unlocked ok mod and rank alphabetically within buckets;
    locked mods keep their bucket and pinned position."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, m.category FROM mods m"
            " LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' AND COALESCE(s.locked, 0) = 0 GROUP BY m.mod_id"
        ).fetchall()
        results = []
        for r in rows:
            bucket, flags = buckets.classify(r["mod_name"], r["category"])
            results.append((bucket, (r["mod_name"] or "").lower(), r["mod_id"], flags))
        results.sort()
        for bucket, _, mod_id, flags in results:
            _upsert_sort(conn, mod_id, bucket, ",".join(flags))
        # a full heuristic re-sort discards any earlier bucket opinion, so
        # give the description pass a fresh shot at these mods too
        conn.execute(
            "UPDATE mod_sort SET desc_checked = 0"
            " WHERE mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok')"
            " AND COALESCE(locked, 0) = 0"
        )
        _write_ranks(conn, [mod_id for _, _, mod_id, _ in results])
    return len(results)


def _place_in_bucket(conn, mod_id, bucket):
    """Reposition a single already-tracked mod so its rank matches a new
    bucket assignment, without disturbing anyone else's order -- used when a
    later pass corrects an earlier bucket guess. Reuses _write_ranks so
    locked mods keep their pinned slots."""
    rows = conn.execute(
        "SELECT m.mod_id, s.bucket FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
        " WHERE m.status = 'ok' AND m.mod_id != ? AND COALESCE(s.locked, 0) = 0"
        " GROUP BY m.mod_id ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE",
        (mod_id,),
    ).fetchall()
    ids = [r["mod_id"] for r in rows]
    pos = sum(1 for r in rows if (r["bucket"] if r["bucket"] is not None else 999) <= bucket)
    ids.insert(pos, mod_id)
    _write_ranks(conn, ids)


def apply_corrections(conn, corrections):
    """Apply a sparse list of bucket corrections -- {'id', 'b', 'f'} dicts,
    same shape as a parsed LLM reply line. Only mods named here ever get
    their rank/bucket touched; everything else is left exactly where it
    was. Shared by the bulk refine and the description-refine passes so
    both are "apply a sparse correction list," not two divergent appliers.
    Ignores a repeated mod_id after its first occurrence."""
    seen = set()
    for item in corrections:
        mod_id = item["id"]
        if mod_id in seen:
            continue
        seen.add(mod_id)
        bucket = item.get("b")
        if bucket is None:
            continue
        flags = item.get("f") or []
        cur = conn.execute("SELECT bucket FROM mod_sort WHERE mod_id = ?", (mod_id,)).fetchone()
        if cur is None or cur["bucket"] != bucket:
            _place_in_bucket(conn, mod_id, bucket)
        _upsert_sort(conn, mod_id, bucket, ",".join(flags))


def set_lock(mod_id, locked):
    """Pin/unpin a mod at its current position. Returns error string or None."""
    with db.connect() as conn:
        known = conn.execute("SELECT 1 FROM mods WHERE mod_id = ?", (mod_id,)).fetchone()
        if not known:
            return "unknown mod"
        conn.execute(
            "INSERT INTO mod_sort (mod_id, locked) VALUES (?, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET locked = excluded.locked",
            (mod_id, 1 if locked else 0),
        )
    return None


def load_order():
    """Ordered library for the Load Order tab. One row per mod; a mod counts
    as installed when any of its archives is installed in MO2."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, m.category, m.mod_url, s.bucket AS sort_bucket,"
            " s.rank AS sort_rank, s.flags AS sort_flags, s.locked AS sort_locked,"
            " s.file_type AS sort_file_type,"
            " json_group_array(m.filename) AS fns"
            " FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' GROUP BY m.mod_id"
            " ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE"
        ).fetchall()
        note_row = conn.execute("SELECT value FROM meta WHERE key = 'conflict_notes'").fetchone()
    mods = [
        {
            "mod_id": r["mod_id"],
            "mod_name": r["mod_name"],
            "category": r["category"],
            "mod_url": r["mod_url"],
            "bucket": r["sort_bucket"],
            "flags": [f for f in (r["sort_flags"] or "").split(",") if f],
            "locked": bool(r["sort_locked"]),
            "file_type": r["sort_file_type"],
            "installed": any(mo2.is_installed(f) for f in json.loads(r["fns"]) if f),
        }
        for r in rows
    ]
    notes = json.loads(note_row["value"]) if note_row else []
    return {"buckets": BUCKETS, "mods": mods, "notes": notes}


def move(mod_ids, position):
    """Move one or several mods (as a block, keeping their relative order) to
    a 1-based position in the global order, shifting the rest. Moved mods
    adopt the bucket of their new neighbor above (below when moved to the
    top) so the grouped view stays coherent; expected_bucket is untouched,
    which is what check_order compares against."""
    if isinstance(mod_ids, int):
        mod_ids = [mod_ids]
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, s.bucket FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' GROUP BY m.mod_id"
            " ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE"
        ).fetchall()
        ids = [r["mod_id"] for r in rows]
        moving = [i for i in ids if i in set(mod_ids)]  # keep current relative order
        if len(moving) != len(set(mod_ids)):
            return "unknown mod"
        bucket_of = {r["mod_id"]: r["bucket"] for r in rows}
        ids = [i for i in ids if i not in set(moving)]
        pos = max(0, min(len(ids), int(position) - 1))
        ids[pos:pos] = moving
        neighbor = ids[pos - 1] if pos > 0 else (ids[pos + len(moving)] if len(ids) > len(moving) else moving[0])
        for mid in moving:
            bucket_of[mid] = bucket_of[neighbor]
        for rank, mid in enumerate(ids):
            conn.execute(
                "INSERT INTO mod_sort (mod_id, rank, bucket) VALUES (?, ?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank, bucket = excluded.bucket",
                (mid, rank, bucket_of[mid]),
            )
    return None


def check_order():
    """Mods whose current bucket disagrees with the last sorter opinion
    (heuristic or LLM) — i.e. likely misplaced after manual moves."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT s.mod_id, s.bucket, s.expected_bucket FROM mod_sort s"
            " WHERE s.expected_bucket IS NOT NULL AND s.locked = 0"
            " AND s.mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok')"
        ).fetchall()
    return {
        "mismatches": [
            {"mod_id": r["mod_id"], "actual": r["bucket"], "expected": r["expected_bucket"]}
            for r in rows
            if r["bucket"] != r["expected_bucket"]
        ]
    }
