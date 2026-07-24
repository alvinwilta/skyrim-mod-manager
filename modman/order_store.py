"""The mod_sort table: bucket/rank/flags/lock CRUD and the deterministic
heuristic pass. This is what both the heuristic sort and the LLM refine
(llm_refine.py) read and write for persistence -- LOOT handles plugin load
order separately; this is the MO2 left-panel *install* order (file
conflicts)."""

import json
import re
import threading

from . import buckets, db, mo2

BUCKETS = buckets.BUCKETS

# Within-bucket family clustering for heuristic_sort: purely cosmetic
# adjacency (never crosses a bucket, never asserts overwrite priority) so it
# doesn't touch the "requirements don't feed ordering" boundary in
# requirements.py -- it only nudges the mod_id tie-break so obviously
# related mods land next to each other instead of scattered by upload date.
_LINKING_WORDS = {"a", "an", "the", "of", "and", "or", "for", "in", "on", "to"}
_GENERIC_WORDS = {
    "se", "sse", "ae", "special", "edition", "ng", "mod", "mods", "fix", "fixes",
    "fixed", "patch", "patches", "overhaul", "redux", "remastered", "revised",
    "update", "updated", "addon", "plugin", "pack", "official", "project",
    "complete", "enhanced", "improved", "better", "new", "version",
}


def _words(name):
    return re.findall(r"[A-Za-z0-9]+", name or "")


def _first_sig_word(name):
    for w in _words(name):
        lw = w.lower()
        if len(lw) > 2 and lw not in _GENERIC_WORDS:
            return lw
    return None


def _contains_whole_name(name_a, name_b):
    """True if the shorter of the two names appears verbatim, at a word
    boundary, inside the longer one -- e.g. "SkyUI" inside "Quest Journal Fix
    for SkyUI". Requires the shorter name to be at least 4 chars so a short
    generic name can't wedge into everything containing it."""
    short, long_ = sorted((name_a or "", name_b or ""), key=len)
    short = short.strip()
    if len(short) < 4:
        return False
    return re.search(r"(?<![A-Za-z0-9])" + re.escape(short.lower()) + r"(?![A-Za-z0-9])", long_.lower()) is not None


def _leading_acronym(name):
    m = re.match(r"^([A-Z]{2,6})\s*[-:]\s+\S", name or "")
    return m.group(1) if m else None


def _initials(name):
    return "".join(w[0] for w in _words(name) if w.lower() not in _LINKING_WORDS).upper()


class _DSU:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def _family_member_key(mod_id, name):
    """Within-family order: Nexus mods by upload order (mod_id ascending --
    the base usually predates the addons built on it), then local/non-Nexus
    adoptions (negative synthetic ids carry no upload order) alphabetically."""
    return (0, mod_id, "") if mod_id > 0 else (1, 0, (name or "").lower())


def _cluster_families(conn, rows):
    """rows: [(bucket, mod_id, name), ...] for the mods being (re)sorted.
    Returns {mod_id: anchor_key} where mods in the same bucket that look like
    the same family (name overlap, a Nexus requirement between them, or an
    acronym-prefix match) share the same anchor_key -- the _family_member_key
    of the member that orders FIRST within the family (the base mod, i.e. the
    lowest positive mod_id) -- so the family sorts where its base's upload
    order would place it, members pulled adjacent to the base."""
    dsu = _DSU()
    by_bucket = {}
    for bucket, mod_id, name in rows:
        by_bucket.setdefault(bucket, []).append((mod_id, name))

    id_set = {mod_id for _, mod_id, _ in rows}
    bucket_of = {mod_id: bucket for bucket, mod_id, _ in rows}
    if id_set:
        # reads the whole (small) table; the Python filter below restricts to
        # the sorted set. Filtering in SQL would take two IN clauses = 2×N
        # bound variables, past the 999-variable limit of older SQLite builds
        req_edges = conn.execute("SELECT mod_id, requires_mod_id FROM mod_requirements").fetchall()
        for r in req_edges:
            a, b = r["mod_id"], r["requires_mod_id"]
            # same-bucket only -- a cross-bucket requirement is real but says
            # nothing about *adjacency*, and letting it union here would let
            # an unrelated bucket's cluster corrupt this one's anchor name
            if a in id_set and b in id_set and bucket_of[a] == bucket_of[b]:
                dsu.union(a, b)

    for members in by_bucket.values():
        if len(members) < 2:
            continue
        acronyms = {mid: _leading_acronym(name) for mid, name in members}
        initials = {mid: _initials(name) for mid, name in members}
        first_words = {mid: _first_sig_word(name) for mid, name in members}
        for i, (mid_a, name_a) in enumerate(members):
            for mid_b, name_b in members[i + 1:]:
                # acronym prefix ("DF - ...") matching another mod's initials
                if acronyms[mid_a] and not acronyms[mid_b] and acronyms[mid_a] == initials[mid_b]:
                    dsu.union(mid_a, mid_b)
                    continue
                if acronyms[mid_b] and not acronyms[mid_a] and acronyms[mid_b] == initials[mid_a]:
                    dsu.union(mid_a, mid_b)
                    continue
                # same leading word ("SkyUI" / "SkyUI - Ghost Item Bug Fix")
                if first_words[mid_a] and first_words[mid_a] == first_words[mid_b]:
                    dsu.union(mid_a, mid_b)
                    continue
                # one mod's FULL name appears verbatim in the other's
                # ("Quest Journal Fix for SkyUI" contains "SkyUI"). Deliberately
                # NOT "any shared word" -- that transitively chains unrelated
                # mods through a common generic word (two mods both named
                # "Better ..." bridging into the same cluster via "better"
                # alone) and was caught turning a 685-mod library's whole
                # Interface bucket into one blob during testing.
                if _contains_whole_name(name_a, name_b):
                    dsu.union(mid_a, mid_b)

    clusters = {}
    for _, mod_id, name in rows:
        clusters.setdefault(dsu.find(mod_id), []).append((mod_id, name))
    anchor_key = {}
    for members in clusters.values():
        key = min(_family_member_key(*m) for m in members)
        for mod_id, _ in members:
            anchor_key[mod_id] = key
    return anchor_key

# Serializes every multi-statement rank rewrite (sort, corrections, move,
# park). Sqlite serializes single statements, not whole rewrites — a refine
# applying corrections while a finished download parks its new mods would
# otherwise interleave rank UPDATEs into a garbled order.
_rank_lock = threading.Lock()


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
        # NULL rank (locked before ever being ranked) pins to the END, not
        # slot 0: last installed = overwrites, the safe default — and it
        # matches where load_order displays a rankless mod (bottom)
        want = r["rank"] if r["rank"] is not None else total - 1
        i = min(want, total - 1)
        while i < total and slots[i] is not None:  # collision: next free slot downward
            i += 1
        if i == total:  # nothing free below: take the nearest free slot upward
            # (never wrap to 0 — a mod locked at the bottom must not jump to the top)
            i = min(want, total - 1)
            while slots[i] is not None:
                i -= 1
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
    """Bucket every unlocked ok mod and rank within buckets by upload order
    (mod_id ascending: older mods place lower, newer overwrite),
    family-clustered (see _cluster_families) so related mods stay adjacent at
    the base member's position; local negative-id adoptions (no upload order)
    go after all Nexus mods, alphabetically. Locked mods keep their bucket and
    pinned position."""
    with _rank_lock, db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, m.category FROM mods m"
            " LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' AND COALESCE(s.locked, 0) = 0 GROUP BY m.mod_id"
        ).fetchall()
        classified = []
        for r in rows:
            bucket, flags = buckets.classify(r["mod_name"], r["category"])
            classified.append((bucket, r["mod_id"], r["mod_name"] or "", flags))
        family_of = _cluster_families(conn, [(b, mid, name) for b, mid, name, _ in classified])
        # families/singletons order by the anchor key (family_of -- the base
        # member's _family_member_key, so a family sits where its base's
        # upload order would place it); members WITHIN a family order by
        # _family_member_key: base first (mod_id ascending = upload order),
        # local negative-id adoptions last
        results = [
            (bucket, family_of[mod_id], _family_member_key(mod_id, name),
             mod_id, flags)
            for bucket, mod_id, name, flags in classified
        ]
        results.sort()
        for bucket, _, _, mod_id, flags in results:
            _upsert_sort(conn, mod_id, bucket, ",".join(flags))
        # a full heuristic re-sort discards any earlier bucket opinion, so
        # give the description pass a fresh shot at these mods too
        conn.execute(
            "UPDATE mod_sort SET desc_checked = 0"
            " WHERE mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok')"
            " AND COALESCE(locked, 0) = 0"
        )
        _write_ranks(conn, [mod_id for _, _, _, mod_id, _ in results])
    return len(results)


def _place_in_bucket(conn, mod_id, bucket):
    """Reposition a single already-tracked mod so its rank matches a new
    bucket assignment, without disturbing anyone else's order -- used when a
    later pass corrects an earlier bucket guess. Reuses _write_ranks so
    locked mods keep their pinned slots.

    The list may NOT be bucket-sorted (manual moves scramble it; parked
    unsorted arrivals sit at the end with no bucket), so the insertion point
    is found by scanning actual positions, never by counting bucket sizes:
    join the end of the target bucket's own run wherever it actually is;
    else after the last smaller-bucket mod; else before the first
    larger-bucket mod. Bucket-less mods are invisible to all three rules, so
    a correction can never land inside the parked block."""
    rows = conn.execute(
        "SELECT m.mod_id, s.bucket FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
        " WHERE m.status = 'ok' AND m.mod_id != ? AND COALESCE(s.locked, 0) = 0"
        " GROUP BY m.mod_id ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE",
        (mod_id,),
    ).fetchall()
    ids = [r["mod_id"] for r in rows]
    pos = None
    for i, r in enumerate(rows):  # end of the target bucket's own run
        if r["bucket"] == bucket:
            pos = i + 1
    if pos is None:
        for i, r in enumerate(rows):  # after the last smaller bucket
            if r["bucket"] is not None and r["bucket"] < bucket:
                pos = i + 1
    if pos is None:
        for i, r in enumerate(rows):  # before the first larger bucket
            if r["bucket"] is not None and r["bucket"] > bucket:
                pos = i
                break
    if pos is None:
        pos = len(ids)
    ids.insert(pos, mod_id)
    _write_ranks(conn, ids)


def apply_corrections(conn, corrections):
    """Apply a sparse list of bucket corrections -- {'id', 'b', 'f'} dicts,
    same shape as a parsed LLM reply line. Only mods named here ever get
    their rank/bucket touched; everything else is left exactly where it
    was. Shared by the bulk refine and the description-refine passes so
    both are "apply a sparse correction list," not two divergent appliers.
    Ignores a repeated mod_id after its first occurrence."""
    with _rank_lock:
        _apply_corrections_locked(conn, corrections)


def _apply_corrections_locked(conn, corrections):
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
        cur = conn.execute("SELECT bucket, locked FROM mod_sort WHERE mod_id = ?", (mod_id,)).fetchone()
        # re-check the lock at APPLY time: refine/desc jobs filter locked mods
        # only when they snapshot, and a lock set during the minutes-long LLM
        # call must win — applying anyway would both move a pinned mod and
        # double-place it in _write_ranks (it lands in the unlocked id list
        # AND the locked-pin query)
        if cur is not None and cur["locked"]:
            continue
        if cur is None or cur["bucket"] != bucket:
            _place_in_bucket(conn, mod_id, bucket)
        _upsert_sort(conn, mod_id, bucket, ",".join(flags))


def set_lock(mod_ids, locked):
    """Pin/unpin one mod or a list of mods at their current positions.
    All-or-nothing: any unknown mod_id fails the whole call.
    Returns error string or None."""
    if isinstance(mod_ids, int):
        mod_ids = [mod_ids]
    with db.connect() as conn:
        placeholders = ",".join("?" * len(mod_ids))
        known = {
            r["mod_id"]
            for r in conn.execute(f"SELECT mod_id FROM mods WHERE mod_id IN ({placeholders})", mod_ids)
        }
        unknown = [i for i in mod_ids if i not in known]
        if unknown:
            return f"unknown mod(s): {unknown}"
        conn.executemany(
            "INSERT INTO mod_sort (mod_id, locked) VALUES (?, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET locked = excluded.locked",
            [(i, 1 if locked else 0) for i in mod_ids],
        )
    return None


# Flag kinds stored in mod_sort.flags that a user may clear from the UI.
# WRONG SPOT / MO2 ORDER are not here: those are computed live by the drift
# and MO2 checks, never persisted as flags.
CLEARABLE_FLAG_KINDS = ("CONFLICT", "DUPLICATE", "MOVED", "UNCERTAIN")


def clear_flags(kinds):
    """Strip all flags of the given kinds (prefixes from CLEARABLE_FLAG_KINDS)
    from every mod_sort row. Returns (cleared_mod_count, error-or-None)."""
    bad = [k for k in kinds if k not in CLEARABLE_FLAG_KINDS]
    if bad or not kinds:
        return 0, f"kinds must be a non-empty subset of {list(CLEARABLE_FLAG_KINDS)}"
    prefixes = tuple(kinds)
    cleared = 0
    with db.connect() as conn:
        rows = conn.execute("SELECT mod_id, flags FROM mod_sort WHERE flags IS NOT NULL AND flags != ''").fetchall()
        for r in rows:
            flags = [f for f in r["flags"].split(",") if f]
            kept = [f for f in flags if not f.startswith(prefixes)]
            if len(kept) != len(flags):
                conn.execute("UPDATE mod_sort SET flags = ? WHERE mod_id = ?", (",".join(kept), r["mod_id"]))
                cleared += 1
    return cleared, None


def load_order():
    """Ordered library for the Load Order tab. One row per mod; a mod counts
    as installed when any of its archives is installed in MO2."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, m.category, m.mod_url, m.source AS mod_source,"
            " s.bucket AS sort_bucket,"
            " s.rank AS sort_rank, s.flags AS sort_flags, s.locked AS sort_locked,"
            " s.file_type AS sort_file_type, s.mo2_state AS sort_mo2_state,"
            " s.separator_id AS sort_separator_id,"
            " s.conflict_pin AS sort_conflict_pin, s.pin_reason AS sort_pin_reason,"
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
            "mo2_state": r["sort_mo2_state"],
            "source": r["mod_source"],
            "separator_id": r["sort_separator_id"],
            "conflict_pin": bool(r["sort_conflict_pin"]),
            "pin_reason": r["sort_pin_reason"],
            # MO2 is the truth once pulled (a mod installed in MO2 whose download
            # archive was cleaned still counts as installed); fall back to the
            # download .meta sidecar only before the first pull.
            "installed": r["sort_mo2_state"] in ("enabled", "disabled")
            if r["sort_mo2_state"]
            else any(mo2.is_installed(f) for f in json.loads(r["fns"]) if f),
        }
        for r in rows
    ]
    notes = json.loads(note_row["value"]) if note_row else []
    return {"buckets": BUCKETS, "mods": mods, "notes": notes}


def order_positions():
    """Minimal ordered view for precedence.enforce()'s move loop: id, name,
    locked only. Deliberately skips load_order()'s per-mod .meta reads
    (`installed`), which enforce never uses — it reloads after every move."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, s.locked AS sort_locked"
            " FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' GROUP BY m.mod_id"
            " ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE"
        ).fetchall()
    return [
        {"mod_id": r["mod_id"], "mod_name": r["mod_name"], "locked": bool(r["sort_locked"])}
        for r in rows
    ]


def park_new_at_end(mod_ids):
    """Append brand-new mods (no ranked mod_sort row yet — redownloads keep
    their place) at the very END of the install order: installed last =
    overwrites everything above ("top of the stack"). Appending shifts
    nothing — locked pins and every other rank stay exactly where they are,
    which is what makes this safe to run while a refine is mid-flight (the
    refine's corrections only touch mods from its own snapshot anyway).
    No bucket is assigned — the arrivals show as Unsorted at the bottom
    until the next Sort/Refine buckets them. Returns count parked."""
    if not mod_ids:
        return 0
    with _rank_lock, db.connect() as conn:
        placeholders = ",".join("?" * len(mod_ids))
        ranked = {
            r["mod_id"]
            for r in conn.execute(
                f"SELECT mod_id FROM mod_sort WHERE rank IS NOT NULL AND mod_id IN ({placeholders})", mod_ids
            )
        }
        new, seen = [], set()
        for mid in mod_ids:
            if mid not in ranked and mid not in seen:
                seen.add(mid)
                new.append(mid)
        if not new:
            return 0
        top = conn.execute(
            "SELECT MAX(rank) AS r FROM mod_sort WHERE rank IS NOT NULL"
            " AND mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok')"
        ).fetchone()["r"]
        at = (top + 1) if top is not None else 0
        for i, mid in enumerate(new):
            conn.execute(
                "INSERT INTO mod_sort (mod_id, rank) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank",
                (mid, at + i),
            )
        return len(new)


def rerank_by_separator():
    """Reorder ranks so mods group by separator band (band sort key ascending =
    separator.id ascending), preserving each band's current internal order.
    Unassigned mods (no separator_id) sink to the end. Deliberately ignores
    locks: this is an explicit "organise into bands" reorganise. Returns count."""
    with _rank_lock, db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok'"
            " ORDER BY s.separator_id IS NULL, s.separator_id,"
            "          s.rank IS NULL, s.rank, m.mod_name COLLATE NOCASE"
        ).fetchall()
        for rank, r in enumerate(rows):
            conn.execute(
                "INSERT INTO mod_sort (mod_id, rank) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank",
                (r["mod_id"], rank),
            )
    return len(rows)


def persist_states(state_by_id, removed_ids):
    """Stamp mo2_state on mods from an MO2 *state-only* sync, WITHOUT rewriting
    any rank (unlike persist_pull). The tool's curated install order is left
    exactly as it is — this only refreshes which mods MO2 currently has
    enabled/disabled, and flags the ones it no longer has as 'removed'."""
    with _rank_lock, db.connect() as conn:
        for mid, st in state_by_id.items():
            conn.execute(
                "INSERT INTO mod_sort (mod_id, mo2_state) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET mo2_state = excluded.mo2_state",
                (mid, st),
            )
        for mid in removed_ids:
            conn.execute(
                "INSERT INTO mod_sort (mod_id, mo2_state) VALUES (?, 'removed')"
                " ON CONFLICT(mod_id) DO UPDATE SET mo2_state = 'removed'",
                (mid,),
            )


def persist_pull(ordered_ids, state_by_id, removed_ids):
    """Persist an MO2 pull (modman/mo2_pull.py): rank every ok mod to
    `ordered_ids` (MO2's install order — matched mods in order, then the
    removed ones), and stamp mo2_state on each. Deliberately ignores locks:
    a pull is an explicit "adopt MO2's current order" action, and MO2 is the
    seed. Runs under _rank_lock like every other multi-statement rank rewrite."""
    with _rank_lock, db.connect() as conn:
        for rank, mid in enumerate(ordered_ids):
            conn.execute(
                "INSERT INTO mod_sort (mod_id, rank) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank",
                (mid, rank),
            )
        for mid, st in state_by_id.items():
            conn.execute(
                "INSERT INTO mod_sort (mod_id, mo2_state) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET mo2_state = excluded.mo2_state",
                (mid, st),
            )
        for mid in removed_ids:
            conn.execute(
                "INSERT INTO mod_sort (mod_id, mo2_state) VALUES (?, 'removed')"
                " ON CONFLICT(mod_id) DO UPDATE SET mo2_state = 'removed'",
                (mid,),
            )


# Bands sort last-when-unassigned: a mod with no separator_id sinks below every
# real band (which are all < this). Keeps the null group at the bottom.
_NO_BAND = 10 ** 12


def move(mod_ids, position, separator_id=None):
    """Move one or several mods (as a block, keeping their relative order) to a
    1-based position in the global order, then RE-GROUP so ranks stay band-
    grouped. This is the invariant the whole order tab relies on: the rank order
    always equals (band ascending, within-band manual order), so grouping is
    never something the display has to reconstruct from a fragile rank-scan.

    A cross-band drag passes `separator_id` (the band the mods were dropped
    under); the moved mods adopt it, then the stable band regroup drops them into
    that band at the spot the drop implied. Same-band moves (`separator_id=None`)
    just reorder within the band. Moved mods adopt the bucket of their new
    neighbour (cosmetic legacy grouping); expected_bucket is untouched."""
    if isinstance(mod_ids, int):
        mod_ids = [mod_ids]
    with _rank_lock, db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, s.bucket, s.separator_id FROM mods m"
            " LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' GROUP BY m.mod_id"
            " ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE"
        ).fetchall()
        ids = [r["mod_id"] for r in rows]
        bucket_of = {r["mod_id"]: r["bucket"] for r in rows}
        band_of = {r["mod_id"]: r["separator_id"] for r in rows}
        moving_set = set(mod_ids)
        moving = [i for i in ids if i in moving_set]  # keep current relative order
        if len(moving) != len(moving_set):
            return "unknown mod"
        # 1. splice the block out and back in at the requested linear position
        rest = [i for i in ids if i not in moving_set]
        pos = max(0, min(len(rest), int(position) - 1))
        linear = rest[:pos] + moving + rest[pos:]
        # 2. re-band the moved mods (cross-band drag) + adopt neighbour bucket
        if separator_id is not None:
            for mid in moving:
                band_of[mid] = separator_id
        neighbor = linear[pos - 1] if pos > 0 else (linear[pos + len(moving)] if len(linear) > len(moving) else moving[0])
        for mid in moving:
            bucket_of[mid] = bucket_of.get(neighbor)
        # 3. STABLE regroup by band (ascending; unassigned last), preserving the
        #    linear order within each band -> ranks are band-grouped again
        order_of = {mid: i for i, mid in enumerate(linear)}
        grouped = sorted(linear, key=lambda mid: (band_of[mid] if band_of[mid] is not None else _NO_BAND, order_of[mid]))
        # 4. renumber
        for rank, mid in enumerate(grouped):
            conn.execute(
                "INSERT INTO mod_sort (mod_id, rank, bucket, separator_id) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank,"
                " bucket = excluded.bucket, separator_id = excluded.separator_id",
                (mid, rank, bucket_of[mid], band_of[mid]),
            )
    return None
