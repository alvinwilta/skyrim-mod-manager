"""Real per-mod "requires" edges from Nexus's own GraphQL data (each mod's
own 'Requirements' section, e.g. "Windhelm fix requires Base Object Swapper").

This is deliberately kept separate from install-order concerns: a Nexus
"requires" relationship is a functional dependency ("you need this to work"),
not curator-asserted left-panel ordering intent -- unlike a collection's own
before/after/requires rules (see modman/collection_rules.py), which exist
specifically to solve install order. So this module only surfaces a
missing-requirement warning; it does not feed the ordering pass."""

import logging
import threading
import time

from . import db, jobs, nexus

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None}
_lock = threading.Lock()


def scan():
    """For every ok mod not yet checked -- skipping only mods a *previous*
    check already confirmed have zero requirements (requirements_alert = 0)
    -- fetch and store its real requirements -- ALL of them, whether or not
    the required mod happens to be in the library, since the point of this
    table is to say "X requires Y, and you don't have Y" (see missing()
    below). requirements_alert is NULL for every mod downloaded before this
    feature existed (it comes from Nexus metadata captured at download time,
    not derivable from the archive), so NULL is treated the same as 1 --
    "unknown, go check" -- and gets backfilled from the fetch result as a
    byproduct. Every candidate is marked requirements_checked regardless of
    outcome, so it's never re-fetched."""
    with db.connect() as conn:
        candidates = [dict(r) for r in conn.execute(
            "SELECT m.mod_id, m.game FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            # GROUP BY includes m.game: collections mix games, and a numeric
            # mod_id colliding across two domains must be checked in BOTH —
            # a bare mod_id group picks one domain arbitrarily
            " WHERE m.status = 'ok' AND m.mod_id > 0 AND COALESCE(m.requirements_alert, 1) != 0"
            " AND COALESCE(s.requirements_checked, 0) = 0 GROUP BY m.mod_id, m.game"
        ).fetchall()]

    by_domain = {}
    for c in candidates:
        by_domain.setdefault(c["game"], []).append(c["mod_id"])

    checked = 0
    for domain, all_ids in by_domain.items():
        if not domain:
            continue
        # chunked fetch-then-write: a failure mid-scan keeps every chunk
        # already written (those rows are marked checked and never re-fetched),
        # instead of one giant all-or-nothing request for a 500-mod library
        for start in range(0, len(all_ids), nexus.LEGACY_CHUNK):
            mod_ids = all_ids[start:start + nexus.LEGACY_CHUNK]
            state["phase"] = (
                f"Fetching requirements {min(start + len(mod_ids), len(all_ids))}/{len(all_ids)} ({domain})"
            )
            # fetch OUTSIDE the write transaction: holding sqlite's write lock
            # across a 30s GraphQL call starves any concurrent writer
            reqs = nexus.fetch_requirements(domain, mod_ids)
            with db.connect() as conn:
                for mod_id in mod_ids:
                    found = reqs.get(mod_id, [])
                    for r in found:
                        conn.execute(
                            "INSERT INTO mod_requirements (mod_id, requires_mod_id, notes, requires_mod_name)"
                            " VALUES (?, ?, ?, ?)"
                            " ON CONFLICT(mod_id, requires_mod_id) DO UPDATE SET"
                            " notes = excluded.notes, requires_mod_name = excluded.requires_mod_name",
                            (mod_id, r["modId"], r["notes"], r.get("modName") or ""),
                        )
                    conn.execute(
                        "UPDATE mods SET requirements_alert = ? WHERE mod_id = ?",
                        (1 if found else 0, mod_id),
                    )
                    conn.execute(
                        "INSERT INTO mod_sort (mod_id, requirements_checked) VALUES (?, 1)"
                        " ON CONFLICT(mod_id) DO UPDATE SET requirements_checked = 1",
                        (mod_id,),
                    )
                    checked += 1

    named = backfill_required_names()
    return checked, named


def backfill_required_names():
    """Fill `requires_mod_name` for any requirement row that still lacks one, by
    fetching the required mod's own name DIRECTLY (nexus.fetch_mod_names), not the
    `modName` carried in the requiring mod's node (which Nexus often leaves blank
    — that's why some names were missing). Grouped by the requiring mod's game
    domain (the required mod is virtually always the same game). Deleted/hidden
    required mods have no name and stay id-only. Returns count filled."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT DISTINCT r.requires_mod_id, m.game FROM mod_requirements r"
            " JOIN mods m ON m.mod_id = r.mod_id AND m.status = 'ok'"
            " WHERE r.requires_mod_id > 0 AND (r.requires_mod_name IS NULL OR r.requires_mod_name = '')"
        ).fetchall()
    by_domain = {}
    for r in rows:
        if r["game"]:
            by_domain.setdefault(r["game"], set()).add(r["requires_mod_id"])
    filled = 0
    for domain, ids in by_domain.items():
        state["phase"] = f"Naming {len(ids)} required mod(s) ({domain})"
        try:
            names = nexus.fetch_mod_names(domain, list(ids))
        except Exception as e:
            log.warning("requirement name backfill failed for %s: %s", domain, e)
            continue
        if not names:
            continue
        with db.connect() as conn:
            for mid, name in names.items():
                conn.execute(
                    "UPDATE mod_requirements SET requires_mod_name = ? WHERE requires_mod_id = ?"
                    " AND (requires_mod_name IS NULL OR requires_mod_name = '')",
                    (name, mid),
                )
                filled += 1
    return filled


def start_scan():
    """Async requirements sync. Returns error string or None (mirrors start_download)."""

    def work():
        n, named = scan()
        parts = []
        if n:
            parts.append(f"Checked {n} mod(s)")
        if named:
            parts.append(f"named {named} required mod(s)")
        return " · ".join(parts) if parts else "Nothing new to check"

    return jobs.start(_lock, state, "a requirements sync is already running", work)


def missing():
    """Requirements pointing at a mod that isn't in the library at all --
    'X requires Y, which you don't have.' Excludes any required mod the user has
    marked as satisfied by an owned substitute (requirement_subs)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.mod_id, m.mod_name, m.game, r.requires_mod_id, r.requires_mod_name, r.notes"
            " FROM mod_requirements r"
            " JOIN mods m ON m.mod_id = r.mod_id AND m.status = 'ok'"
            " WHERE r.requires_mod_id NOT IN (SELECT mod_id FROM mods WHERE status = 'ok')"
            " AND r.requires_mod_id NOT IN (SELECT requires_mod_id FROM requirement_subs)"
            " GROUP BY r.mod_id, r.requires_mod_id"
        ).fetchall()
    return [
        {
            "mod_id": r["mod_id"], "mod_name": r["mod_name"],
            "requires_mod_id": r["requires_mod_id"],
            "requires_mod_name": r["requires_mod_name"] or "",
            # requires_mod_id isn't in `mods` (that's the whole point) so it has
            # no stored mod_url of its own -- build one from the requiring mod's
            # own game domain, which is virtually always the same game.
            "requires_url": nexus.mod_url(r["game"], r["requires_mod_id"]),
            "notes": r["notes"],
        }
        for r in rows
    ]


def substitutions():
    """Every distinct MISSING required mod (one that isn't an ok library mod),
    grouped, with the mods that require it and the current user-asserted
    substitute (if any). Plus a deduped library list for the picker.

    This backs the Requirements tab: the user maps 'missing mod Y is actually
    covered by owned mod Z', which drops Y off the missing-requirements list."""
    # name any still-unnamed required mod directly from Nexus first (cheap: a
    # handful of ids, one batched query), so the picker list never shows a bare
    # id when Nexus actually knows the name. Best-effort — offline just leaves
    # the blanks, and a genuinely deleted/hidden mod stays id-only.
    backfill_required_names()
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.requires_mod_id, r.requires_mod_name, r.notes, m.mod_id, m.mod_name, m.game"
            " FROM mod_requirements r"
            " JOIN mods m ON m.mod_id = r.mod_id AND m.status = 'ok'"
            " WHERE r.requires_mod_id NOT IN (SELECT mod_id FROM mods WHERE status = 'ok')"
            " ORDER BY r.requires_mod_id"
        ).fetchall()
        subs = {s["requires_mod_id"]: s["sub_mod_id"] for s in conn.execute(
            "SELECT requires_mod_id, sub_mod_id FROM requirement_subs"
        )}
        libnames = {r["mod_id"]: r["mod_name"] for r in conn.execute(
            "SELECT DISTINCT mod_id, mod_name FROM mods WHERE status = 'ok'"
        )}

    grouped = {}
    for r in rows:
        g = grouped.setdefault(r["requires_mod_id"], {
            "requires_mod_id": r["requires_mod_id"],
            "requires_mod_name": r["requires_mod_name"] or "",
            "requires_url": nexus.mod_url(r["game"], r["requires_mod_id"]),
            "notes": r["notes"],
            "requiring": [],
        })
        g["requiring"].append({"mod_id": r["mod_id"], "mod_name": r["mod_name"]})

    items = []
    for rid, g in grouped.items():
        sub = subs.get(rid)
        g["sub_mod_id"] = sub
        g["sub_mod_name"] = libnames.get(sub) if sub else None
        items.append(g)
    # unresolved first, then alphabetical by the missing mod's name
    items.sort(key=lambda g: (g["sub_mod_id"] is not None, (g["requires_mod_name"] or "").lower()))

    library = sorted(
        ({"mod_id": mid, "mod_name": nm} for mid, nm in libnames.items()),
        key=lambda x: (x["mod_name"] or "").lower(),
    )
    return {"items": items, "library": library}


def set_substitute(requires_mod_id, sub_mod_id):
    """Map a missing required mod to an owned library mod (sub_mod_id), or clear
    it (sub_mod_id None). Validates the substitute is an ok mod. Raises
    ValueError on a bad substitute."""
    with db.connect() as conn:
        if sub_mod_id is None:
            conn.execute("DELETE FROM requirement_subs WHERE requires_mod_id = ?", (requires_mod_id,))
            return
        ok = conn.execute(
            "SELECT 1 FROM mods WHERE mod_id = ? AND status = 'ok' LIMIT 1", (sub_mod_id,)
        ).fetchone()
        if not ok:
            raise ValueError(f"mod {sub_mod_id} isn't an ok mod in your library")
        conn.execute(
            "INSERT INTO requirement_subs (requires_mod_id, sub_mod_id, created_at)"
            " VALUES (?, ?, ?) ON CONFLICT(requires_mod_id) DO UPDATE SET"
            " sub_mod_id = excluded.sub_mod_id, created_at = excluded.created_at",
            (requires_mod_id, sub_mod_id, time.strftime("%Y-%m-%d %H:%M:%S")),
        )
