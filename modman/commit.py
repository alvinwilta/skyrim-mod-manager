"""Commit the install order to disk: physically rename every downloaded
archive with a zero-padded install-order prefix (e.g. `0001__<filename>`) so
the downloads sort in install order for MO2. Uncommit renames them back.

The prefix is *prepended* to the existing sanitized filename, so the
`name-modId-fileId-ver-fileVer` tail stays intact and record_downloads can
still re-derive/reconcile the base on a future download.

Committed state has two reconciled markers:
- `meta.install_committed = "1"` -- canonical UI/blocking flag, set BEFORE the
  first rename so a crash mid-commit still leaves the UI frozen (won't silently
  reorder over half-prefixed files).
- `mods.orig_filename IS NOT NULL` -- per-row disk truth. Drives resume,
  rollback and uncommit, and makes commit() idempotent (already-prefixed rows
  are skipped, so a re-run just finishes the remainder).

Renaming an archive always renames its MO2 `.meta` sidecar (mo2.meta_path) in
lockstep, and updates the DB `filename` per row right after the disk rename, so
every row stays self-consistent even if the pass dies partway.
"""

import logging
import os
import threading

from . import db, engine, importlocal, jobs, mo2, order_store
from .config import DOWNLOADS_DIR

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None, "committed": False}
_lock = threading.Lock()

FLAG_KEY = "install_committed"


def _set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))


def is_committed(conn=None):
    """Canonical committed flag (meta table)."""
    own = conn is None
    if own:
        conn = db.connect()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (FLAG_KEY,)).fetchone()
        return bool(row and row["value"] == "1")
    finally:
        if own:
            conn.close()


def _any_committed_rows(conn):
    return conn.execute("SELECT 1 FROM mods WHERE orig_filename IS NOT NULL LIMIT 1").fetchone() is not None


def _prefix(index, total):
    """Zero-padded install-order prefix for the mod at 0-based `index` of `total`
    (e.g. index 0 of 100 -> '001__'). Width tracks the count so names sort right."""
    width = max(1, len(str(total)))
    return f"{index + 1:0{width}d}__"


def _plan(conn):
    """(file_id, old_name, new_name) for every ok archive still un-prefixed,
    numbered by its mod's 1-based position in the current install order.

    Skips rows whose file isn't actually on disk: a `status='ok'` row can name
    a file that was deleted outside the app / never fully downloaded, and one
    missing file must not abort the whole commit. There's nothing to prefix if
    the archive isn't there."""
    mods = order_store.load_order()["mods"]
    plan = []
    skipped = 0
    for i, m in enumerate(mods):
        prefix = _prefix(i, len(mods))
        rows = conn.execute(
            "SELECT file_id, filename FROM mods"
            " WHERE mod_id = ? AND status = 'ok' AND filename IS NOT NULL AND orig_filename IS NULL",
            (m["mod_id"],),
        ).fetchall()
        for r in rows:
            if not os.path.isfile(os.path.join(DOWNLOADS_DIR, r["filename"])):
                skipped += 1
                continue
            plan.append((r["file_id"], r["filename"], prefix + r["filename"]))
    if skipped:
        log.warning("commit: skipped %d db row(s) with no file on disk", skipped)
    return plan


def _rename(old, new):
    """Rename an archive and its MO2 .meta sidecar (if any) together."""
    os.rename(os.path.join(DOWNLOADS_DIR, old), os.path.join(DOWNLOADS_DIR, new))
    old_meta, new_meta = mo2.meta_path(old), mo2.meta_path(new)
    if os.path.exists(old_meta):
        os.rename(old_meta, new_meta)


def commit():
    """Prefix every un-prefixed ok archive on disk. Idempotent. Rolls back all
    renames done in this pass on any failure. Returns the number renamed."""
    with db.connect() as conn:
        plan = _plan(conn)
        # collision pre-check -- abort before touching disk if a target exists
        for _fid, _old, new in plan:
            if os.path.exists(os.path.join(DOWNLOADS_DIR, new)):
                raise RuntimeError(f"cannot commit: target name already exists: {new}")
        _set_meta(conn, FLAG_KEY, "1")  # freeze UI first, before any rename
        conn.commit()
        done = []
        try:
            for fid, old, new in plan:
                _rename(old, new)
                conn.execute(
                    "UPDATE mods SET filename = ?, orig_filename = ? WHERE file_id = ?", (new, old, fid)
                )
                conn.commit()
                done.append((fid, old, new))
        except Exception:
            log.exception("commit failed after %d rename(s); rolling back", len(done))
            for fid, old, new in reversed(done):
                try:
                    _rename(new, old)
                    conn.execute(
                        "UPDATE mods SET filename = ?, orig_filename = NULL WHERE file_id = ?", (old, fid)
                    )
                    conn.commit()
                except Exception:
                    log.exception("rollback failed for file_id=%s (%s -> %s)", fid, new, old)
            # only lift the freeze if nothing stayed committed (fresh commit fully undone)
            if not _any_committed_rows(conn):
                _set_meta(conn, FLAG_KEY, "0")
                conn.commit()
            raise
        return len(done)


def uncommit():
    """Rename every prefixed archive back to its orig_filename. Rolls back on
    any failure. Clears the flag on full success. Returns the number restored."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT file_id, filename, orig_filename FROM mods WHERE orig_filename IS NOT NULL"
        ).fetchall()
        done = []
        try:
            for r in rows:
                new, old = r["filename"], r["orig_filename"]
                _rename(new, old)
                conn.execute(
                    "UPDATE mods SET filename = ?, orig_filename = NULL WHERE file_id = ?", (old, r["file_id"])
                )
                conn.commit()
                done.append((r["file_id"], new, old))
            _set_meta(conn, FLAG_KEY, "0")
            conn.commit()
        except Exception:
            log.exception("uncommit failed after %d rename(s); rolling back", len(done))
            for fid, new, old in reversed(done):
                try:
                    _rename(old, new)
                    conn.execute(
                        "UPDATE mods SET filename = ?, orig_filename = ? WHERE file_id = ?", (new, old, fid)
                    )
                    conn.commit()
                except Exception:
                    log.exception("rollback failed for file_id=%s (%s -> %s)", fid, old, new)
            raise
        return len(done)


def _run(fn, busy, done):
    # renaming under a live downloads-dir writer corrupts both sides: the
    # writer's open fd keeps filling the renamed file while the db row is
    # repointed, so refuse to start while either job runs (they in turn
    # refuse to start while committed/renaming — see webapp's guards)
    if engine.state.get("running"):
        return "a download job is running — wait for it to finish first"
    if importlocal.state.get("running"):
        return "an import is running — wait for it to finish first"

    def work():
        n = fn()
        return f"{done} {n} file(s)" if n else "Nothing to rename"

    return jobs.start(
        _lock, state, "a rename job is already running", work,
        init={"phase": busy},
        finalize=lambda: state.update(committed=is_committed()),
    )


def start_commit():
    """Async commit. Returns an error string or None (mirrors conflicts.start_scan)."""
    return _run(commit, "Renaming files…", "Committed")


def start_uncommit():
    """Async uncommit. Returns an error string or None."""
    return _run(uncommit, "Restoring names…", "Restored")
