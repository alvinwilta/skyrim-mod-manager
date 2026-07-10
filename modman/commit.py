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

Hide-installed is the second, orthogonal disk operation: it MOVES archives whose
`.meta` says installed=true into DOWNLOADS_DIR/installed/ (and back), never
touching the name itself, while commit/uncommit only prefix/unprefix the
basename, never touching the folder. So the two compose in any order and an
install-order prefix survives hiding. Location is tracked in the `filename`
column as a relative path (`installed/0001__x.7z`) — every consumer already
joins DOWNLOADS_DIR + filename. `orig_filename` moves folders with the file, so
uncommit always restores in place (a hidden file stays hidden, just unprefixed).
Canonical flag: `meta.hide_installed`, set before the first move (crash keeps
the toggle truthful). MO2's Downloads tab only reads the flat dir, so hidden
archives disappear from its list.
"""

import logging
import os
import threading

from . import db, jobs, mo2, order_store
from .config import DOWNLOADS_DIR

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None, "committed": False, "hidden": False}
_lock = threading.Lock()
jobs.register("file-rename", state)

FLAG_KEY = "install_committed"
HIDE_KEY = "hide_installed"
INSTALLED_SUBDIR = "installed"


def _set_meta(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))


def _meta_flag(key, conn=None):
    own = conn is None
    if own:
        conn = db.connect()
    try:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return bool(row and row["value"] == "1")
    finally:
        if own:
            conn.close()


def is_committed(conn=None):
    """Canonical committed flag (meta table)."""
    return _meta_flag(FLAG_KEY, conn)


def is_hidden(conn=None):
    """Canonical hide-installed flag (meta table)."""
    return _meta_flag(HIDE_KEY, conn)


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
            # prefix the basename only: a hidden file (installed/x.7z) keeps its folder
            d, base = os.path.split(r["filename"])
            plan.append((r["file_id"], r["filename"], os.path.join(d, prefix + base)))
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
    any failure. Clears the flag on full success. Returns the number restored.

    A prefixed file missing on disk (deleted out-of-band while committed) is
    skipped like commit skips them: the row's name is restored db-side so the
    revert can finish instead of wedging the whole app in committed state —
    the file is gone either way, and validate will flag the row missing."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT file_id, filename, orig_filename FROM mods WHERE orig_filename IS NOT NULL"
        ).fetchall()
        done = []
        skipped = 0
        try:
            for r in rows:
                new, old = r["filename"], r["orig_filename"]
                if not os.path.isfile(os.path.join(DOWNLOADS_DIR, new)):
                    conn.execute(
                        "UPDATE mods SET filename = ?, orig_filename = NULL WHERE file_id = ?", (old, r["file_id"])
                    )
                    conn.commit()
                    skipped += 1
                    continue
                _rename(new, old)
                conn.execute(
                    "UPDATE mods SET filename = ?, orig_filename = NULL WHERE file_id = ?", (old, r["file_id"])
                )
                conn.commit()
                done.append((r["file_id"], new, old))
            _set_meta(conn, FLAG_KEY, "0")
            conn.commit()
            if skipped:
                log.warning("uncommit: %d file(s) missing on disk — db rows restored, nothing to rename", skipped)
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


def _hide_plan(conn, enable):
    """(file_id, old, new, old_orig, new_orig) for every ok archive that needs
    to move. Hiding moves archives whose .meta says installed=true into
    installed/; unhiding moves everything back out. Names never change here —
    only the folder. orig_filename (commit's restore name) moves folders with
    the file so uncommit keeps restoring in place. Skips rows whose file isn't
    on disk, same rationale as _plan."""
    rows = conn.execute(
        "SELECT file_id, filename, orig_filename FROM mods WHERE status = 'ok' AND filename IS NOT NULL"
    ).fetchall()
    plan = []
    skipped = 0
    for r in rows:
        d, base = os.path.split(r["filename"])
        if enable:
            if d or not mo2.is_installed(r["filename"]):
                continue  # already hidden, or not installed
            new = os.path.join(INSTALLED_SUBDIR, base)
        else:
            if d != INSTALLED_SUBDIR:
                continue
            new = base
        if not os.path.isfile(os.path.join(DOWNLOADS_DIR, r["filename"])):
            skipped += 1
            continue
        orig = r["orig_filename"]
        new_orig = os.path.join(os.path.dirname(new), os.path.basename(orig)) if orig else None
        plan.append((r["file_id"], r["filename"], new, orig, new_orig))
    if skipped:
        log.warning("hide-installed: skipped %d db row(s) with no file on disk", skipped)
    return plan


def set_hidden(enable):
    """Move installed archives into (enable=True) or back out of installed/.
    Filenames — including any NNNN__ commit prefix — are untouched, so this
    composes with commit/uncommit in any order. Idempotent (already-moved rows
    are skipped). Rolls back this pass's moves on failure and restores the
    previous flag. Returns the number moved."""
    with db.connect() as conn:
        plan = _hide_plan(conn, enable)
        for _fid, _old, new, _orig, _new_orig in plan:
            if os.path.exists(os.path.join(DOWNLOADS_DIR, new)):
                raise RuntimeError(f"cannot move: target name already exists: {new}")
        if enable:
            os.makedirs(os.path.join(DOWNLOADS_DIR, INSTALLED_SUBDIR), exist_ok=True)
        # flag first (same crash rule as commit): a crash mid-move leaves the
        # toggle reflecting the direction we were moving toward
        _set_meta(conn, HIDE_KEY, "1" if enable else "0")
        conn.commit()
        done = []
        try:
            for fid, old, new, orig, new_orig in plan:
                _rename(old, new)
                conn.execute(
                    "UPDATE mods SET filename = ?, orig_filename = ? WHERE file_id = ?", (new, new_orig, fid)
                )
                conn.commit()
                done.append((fid, old, new, orig))
        except Exception:
            log.exception("hide-installed(%s) failed after %d move(s); rolling back", enable, len(done))
            for fid, old, new, orig in reversed(done):
                try:
                    _rename(new, old)
                    conn.execute(
                        "UPDATE mods SET filename = ?, orig_filename = ? WHERE file_id = ?", (old, orig, fid)
                    )
                    conn.commit()
                except Exception:
                    log.exception("rollback failed for file_id=%s (%s -> %s)", fid, new, old)
            _set_meta(conn, HIDE_KEY, "0" if enable else "1")
            conn.commit()
            raise
        return len(done)


def _run(fn, busy, done):
    # renaming under a live downloads-dir writer corrupts both sides: the
    # writer's open fd keeps filling the renamed file while the db row is
    # repointed — and renaming under a live refine desyncs the frozen prefix
    # order from the still-moving ranks. exclusive_as covers every registered
    # job (download, import, sort refine, rule enforcement) under one guard.
    def work():
        n = fn()
        return f"{done} {n} file(s)" if n else "Nothing to rename"

    return jobs.start(
        _lock, state, "a rename job is already running", work,
        init={"phase": busy},
        finalize=lambda: state.update(committed=is_committed(), hidden=is_hidden()),
        exclusive_as="file-rename",
    )


def start_commit():
    """Async commit. Returns an error string or None (mirrors conflicts.start_scan)."""
    return _run(commit, "Renaming files…", "Committed")


def start_uncommit():
    """Async uncommit. Returns an error string or None."""
    return _run(uncommit, "Restoring names…", "Restored")


def start_hide(enabled):
    """Async hide/unhide of installed archives. Returns an error string or None."""
    if enabled:
        return _run(lambda: set_hidden(True), "Moving installed archives…", "Moved")
    return _run(lambda: set_hidden(False), "Moving archives back…", "Moved back")
