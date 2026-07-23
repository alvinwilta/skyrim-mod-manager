"""Pull MO2's live install order + state INTO the tool (read-only w.r.t. MO2).

Phase 1a of the MO2-sync rework: MO2's current left-panel order is the
*validation seed*. This reads the active profile's modlist.txt + each installed
folder's meta.ini (via mo2_order.py), maps every managed MO2 mod back to a db
mod, and writes:
  - `mod_sort.rank` -- the tool's install order set to MO2's (matched mods in
    MO2 order, then any ok db mod MO2 no longer has appended at the end).
  - `mod_sort.mo2_state` -- 'enabled'/'disabled' for mods MO2 has,
    'removed' for ok db mods absent from MO2.

Matching is Nexus-modid first (meta.ini `modid=`), then an exact
folder-name == mod_name fallback for manual/non-Nexus mods. MO2 folders that
match nothing in the db are counted as `unmatched` (they get adopted as new
rows in Phase 1b, not here). Nothing is created or deleted; only rank/state
change. Runs as an exclusive background job (rewrites ranks)."""

import logging
import threading

from . import db, jobs, mo2_order, order_store

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None,
         "matched": 0, "removed": 0, "unmatched": 0}
_lock = threading.Lock()
jobs.register("mo2 pull", state)


def _name_index(conn):
    """lowercased mod_name -> mod_id for ok mods, for the folder-name fallback
    when a folder carries no Nexus modid. First occurrence wins on duplicate
    names (rare; the ambiguity is inherent and a pull can't resolve it)."""
    idx = {}
    for r in conn.execute("SELECT mod_id, mod_name FROM mods WHERE status = 'ok'"):
        key = (r["mod_name"] or "").strip().lower()
        if key:
            idx.setdefault(key, r["mod_id"])
    return idx


def pull():
    """Read MO2, write ranks + mo2_state. Returns a summary phase string."""
    entries = mo2_order.read_modlist()  # file order (top = highest priority)
    if not entries:
        raise RuntimeError(
            "MO2 modlist is empty or unreadable — check the profiles path in Config"
        )
    fmap = mo2_order.folder_to_modid()  # folder -> Nexus modid

    with db.connect() as conn:
        name_idx = _name_index(conn)
        ok_ids = {r["mod_id"] for r in conn.execute("SELECT mod_id FROM mods WHERE status = 'ok'")}

    # app rank order (0..N, panel top->bottom) is the reverse of the file
    app_entries = list(reversed(entries))
    seq, state_by_id, seen = [], {}, set()
    unmatched = 0
    for e in app_entries:
        folder = e["folder"]
        mid = fmap.get(folder)
        if mid is None:
            mid = name_idx.get(folder.strip().lower())
        if mid is None or mid not in ok_ids:
            unmatched += 1  # MO2-only mod (adopted in Phase 1b) — skip for now
            continue
        if mid in seen:  # a mod with several folders/files: first (highest) wins
            continue
        seen.add(mid)
        seq.append(mid)
        state_by_id[mid] = "enabled" if e["enabled"] else "disabled"

    removed = [i for i in ok_ids if i not in seen]  # ok in db, absent from MO2
    order_store.persist_pull(seq + removed, state_by_id, removed)

    state["matched"], state["removed"], state["unmatched"] = len(seq), len(removed), unmatched
    return f"Pulled {len(seq)} mod(s) from MO2 · {len(removed)} not in MO2 · {unmatched} MO2-only (not yet imported)"


def start_pull():
    """Async pull. Returns an error string or None. Exclusive: it rewrites every
    rank, so it can't overlap a sort/refine/enforce/download/import/commit."""
    return jobs.start(
        _lock, state, "a pull is already running", pull,
        init={"matched": 0, "removed": 0, "unmatched": 0},
        exclusive_as="mo2 pull",
    )
