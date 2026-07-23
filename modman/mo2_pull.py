"""Pull MO2's live install order + state INTO the tool (read-only w.r.t. MO2).

Phase 1 of the MO2-sync rework: MO2's current left-panel order is the
*validation seed*. This reads the active profile's modlist.txt + each installed
folder's meta.ini (via mo2_order.py), maps every managed MO2 mod back to a db
mod, and writes:
  - `mod_sort.rank` -- the tool's install order set to MO2's (matched mods in
    MO2 order, then any ok db mod MO2 no longer has appended at the end).
  - `mod_sort.mo2_state` -- 'enabled'/'disabled' for mods MO2 has,
    'removed' for ok db mods absent from MO2.

Matching precedence (strongest first), all from the folder's meta.ini:
  1. `[installedFiles] fileid` -> db file_id (the primary key: exact).
  2. `installationFile` -> db filename / orig_filename (the source archive; the
     tool's own commit prefix `NNNN__` is stripped before comparing).
  3. `modid` (General or installedFiles) -> db mod_id.
  4. folder name -> db mod_name (case-insensitive; last resort).

MO2 folders that still match nothing are genuinely MO2-only (installed through
MO2, never through the tool). Phase 1b **adopts** them as rows (source='mo2',
no managed archive) so the tool's order is complete -- generated tool outputs
(Bodyslide/Pandora/DynDOLOD ...) are skipped. Nothing in MO2 is modified.
Runs as an exclusive background job (rewrites ranks)."""

import logging
import os
import re
import threading
import time

from . import db, jobs, mo2_order, nexus, order_store
from .config import GAME, MODS_DIR
from .importlocal import _synthetic_id

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None,
         "matched": 0, "adopted": 0, "removed": 0, "skipped": 0}
_lock = threading.Lock()
jobs.register("mo2 pull", state)

# Regenerated MO2 tool outputs, not real mods -- never adopted as library rows
# (Phase 2 gives them their own TOOL OUTPUTS separator). Matched by substring.
_OUTPUT_RE = re.compile(r"\b(output|outputs)\b", re.I)


def _norm_archive(name):
    """Comparable form of an archive name: basename, tool commit prefix
    (`0001__`) stripped, lowercased. None for a blank/None input."""
    if not name:
        return None
    base = re.sub(r"^\d{3,4}__", "", os.path.basename(name))
    return base.lower() or None


def _db_indexes(conn):
    """Four lookup dicts over ok mods, one per matching signal, each mapping to
    a mod_id. First occurrence wins on any collision (inherent, rare)."""
    by_fid, by_mid, by_fn, by_name = {}, {}, {}, {}
    for r in conn.execute(
        "SELECT mod_id, file_id, mod_name, filename, orig_filename FROM mods WHERE status = 'ok'"
    ):
        by_fid.setdefault(r["file_id"], r["mod_id"])
        by_mid.setdefault(r["mod_id"], r["mod_id"])
        for fn in (r["filename"], r["orig_filename"]):
            k = _norm_archive(fn)
            if k:
                by_fn.setdefault(k, r["mod_id"])
        nk = (r["mod_name"] or "").strip().lower()
        if nk:
            by_name.setdefault(nk, r["mod_id"])
    return by_fid, by_mid, by_fn, by_name


def _match(folder, sig, idx):
    """Resolve one MO2 folder to a db mod_id by the precedence above, or None."""
    by_fid, by_mid, by_fn, by_name = idx
    if sig:
        if sig["fileid"] and sig["fileid"] in by_fid:
            return by_fid[sig["fileid"]]
        k = _norm_archive(sig["installfile"])
        if k and k in by_fn:
            return by_fn[k]
        if sig["modid"] and sig["modid"] in by_mid:
            return by_mid[sig["modid"]]
    return by_name.get(folder.strip().lower())


def _adopt(conn, folder, sig):
    """Create an ok mods row for an MO2-only mod (no managed archive). Real
    Nexus ids when meta.ini has both modid+fileid, else a stable JS-safe
    synthetic id from the source archive/folder name (idempotent across pulls).
    Returns the new mod_id, or None if it was skipped/failed."""
    modid = sig["modid"] if sig and sig["modid"] > 0 else None
    fileid = sig["fileid"] if sig and sig["fileid"] > 0 else None
    installfile = sig["installfile"] if sig else None
    if modid and fileid:
        url = nexus.mod_url(GAME, modid)
    else:
        # non-Nexus, or MO2 didn't record the pair -> synthetic id from the
        # most stable identifier available (the archive, else the folder name)
        sid = _synthetic_id(installfile or folder)
        modid, fileid, url = modid or sid, fileid or sid, ""
    try:
        mtime = os.path.getmtime(os.path.join(MODS_DIR, folder))
        now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(mtime))
    except OSError:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
    # filename NULL: there is no archive in the downloads dir. INSERT OR IGNORE
    # guards a re-pull (idempotent) and any id collision.
    cur = conn.execute(
        "INSERT OR IGNORE INTO mods (file_id, mod_id, mod_name, filename, game,"
        " downloaded_at, status, mod_url, source)"
        " VALUES (?, ?, ?, NULL, ?, ?, 'ok', ?, 'mo2')",
        (fileid, modid, folder, GAME, now, url),
    )
    return modid if cur.rowcount else None


def pull():
    """Read MO2, adopt MO2-only mods, write ranks + mo2_state. Returns a
    summary phase string."""
    entries = mo2_order.read_modlist()  # file order (top = highest priority)
    if not entries:
        raise RuntimeError(
            "MO2 modlist is empty or unreadable — check the profiles path in Config"
        )
    signals = mo2_order.folder_signals()

    with db.connect() as conn:
        idx = _db_indexes(conn)
        ok_ids = {r["mod_id"] for r in conn.execute("SELECT mod_id FROM mods WHERE status = 'ok'")}

        # app rank order (0..N, panel top->bottom) is the reverse of the file
        app_entries = list(reversed(entries))
        seq, state_by_id, seen = [], {}, set()
        adopted = skipped = 0
        for e in app_entries:
            folder = e["folder"]
            sig = signals.get(folder)
            mid = _match(folder, sig, idx)
            if mid is None:
                if _OUTPUT_RE.search(folder) or sig is None:
                    skipped += 1  # generated tool output / unmanaged folder
                    continue
                mid = _adopt(conn, folder, sig)
                if mid is None:
                    skipped += 1
                    continue
                adopted += 1
            if mid in seen:  # a mod with several folders/files: first (highest) wins
                continue
            seen.add(mid)
            seq.append(mid)
            state_by_id[mid] = "enabled" if e["enabled"] else "disabled"

    removed = [i for i in ok_ids if i not in seen]  # ok in db, absent from MO2
    order_store.persist_pull(seq + removed, state_by_id, removed)

    state["matched"] = len(seq) - adopted
    state["adopted"], state["removed"], state["skipped"] = adopted, len(removed), skipped
    return (f"Pulled {len(seq)} mod(s) from MO2 · {adopted} newly adopted · "
            f"{len(removed)} not in MO2 · {skipped} skipped (tool outputs)")


def start_pull():
    """Async pull. Returns an error string or None. Exclusive: it rewrites every
    rank, so it can't overlap a sort/refine/enforce/download/import/commit."""
    return jobs.start(
        _lock, state, "a pull is already running", pull,
        init={"matched": 0, "adopted": 0, "removed": 0, "skipped": 0},
        exclusive_as="mo2 pull",
    )
