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
            " WHERE m.status = 'ok' AND m.mod_id > 0 AND COALESCE(m.requirements_alert, 1) != 0"
            " AND COALESCE(s.requirements_checked, 0) = 0 GROUP BY m.mod_id"
        ).fetchall()]
    if not candidates:
        state["phase"] = "No mods need a requirements check"
        return 0

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
                            "INSERT OR IGNORE INTO mod_requirements (mod_id, requires_mod_id, notes)"
                            " VALUES (?, ?, ?)",
                            (mod_id, r["modId"], r["notes"]),
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
    return checked


def start_scan():
    """Async requirements sync. Returns error string or None (mirrors start_download)."""

    def work():
        n = scan()
        return f"Checked {n} mod(s)" if n else "Nothing new to check"

    return jobs.start(_lock, state, "a requirements sync is already running", work)


def missing():
    """Requirements pointing at a mod that isn't in the library at all --
    'X requires Y, which you don't have.'"""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.mod_id, m.mod_name, m.game, r.requires_mod_id, r.notes FROM mod_requirements r"
            " JOIN mods m ON m.mod_id = r.mod_id AND m.status = 'ok'"
            " WHERE r.requires_mod_id NOT IN (SELECT mod_id FROM mods WHERE status = 'ok')"
            " GROUP BY r.mod_id, r.requires_mod_id"
        ).fetchall()
    return [
        {
            "mod_id": r["mod_id"], "mod_name": r["mod_name"],
            "requires_mod_id": r["requires_mod_id"],
            # requires_mod_id isn't in `mods` (that's the whole point) so it has
            # no stored mod_url of its own -- build one from the requiring mod's
            # own game domain, which is virtually always the same game.
            "requires_url": nexus.mod_url(r["game"], r["requires_mod_id"]),
            "notes": r["notes"],
        }
        for r in rows
    ]
