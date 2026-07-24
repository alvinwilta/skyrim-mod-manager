"""Real (not guessed) install-order conflicts: two mods whose archives both
contain the same Data-relative file path, so one silently overwrites the
other depending on left-panel install order. This is a fact lookup from
actual archive contents (via `7z l`), independent of llm_refine.py's
LLM-guessed conflict notes -- nothing here is inferred from a mod's name
or category.

Known limits, both inherent to the approach (MO2's own Conflicts tab shares
them):
- BSA/BA2 internals aren't inspected -- 7z can't open Bethesda archives, so
  a BSA-only mod's contents are invisible here, same as in MO2.
- Multi-option FOMOD archives can list several alternate payload folders
  side by side (which one an install would pick isn't simulated), so those
  can show up as extra paths that never actually collide with anything.
"""

import logging
import os
import subprocess
import threading

from . import db, jobs
from .buckets import STRUCTURAL_BUCKETS
from .config import DOWNLOADS_DIR

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None}
_lock = threading.Lock()

# Top-level Data folder names -- a path starting with one of these is
# already Data-relative. Anything else is assumed wrapped in an extra
# top folder and gets stripped down to the first one of these found.
DATA_DIRS = {
    "meshes", "textures", "scripts", "interface", "sound", "music", "strings",
    "video", "seq", "skse", "grass", "shadersfx", "facegendata", "facegeom",
    "distantlod", "lodsettings", "source", "calientetools", "mcm",
    "tools", "dyndolod", "actors", "materials",
}
WRAPPER = "data"  # an explicit top-level "Data" folder just means "start here"

# a path shared by more mods than this is almost always a redistributed
# common utility script (PapyrusUtil, MCM helper stubs, ...), not a real
# per-mod conflict -- skip it instead of emitting a combinatorial pile of
# pairs for it
_MAX_SHARERS = 8

# Paths that are NOT real Data-asset overrides: FOMOD installer metadata (every
# fomod archive ships identical fomod/*.xml + wizard scripts), MCM settings and
# localization strings (many unrelated mods ship them). Counting these invents
# conflicts between totally unrelated mods, which then get glued/pinned together.
# Both the conflicts view and the ordering engine exclude them. Applied as a SQL
# fragment on `mf.path` (stored lowercased by _normalize).
INCIDENTAL_PATH_SQL = (
    " AND mf.path NOT LIKE 'fomod/%'"
    " AND mf.path NOT LIKE '%/fomod/%'"
    " AND mf.path NOT LIKE 'mcm/config/%'"
    " AND mf.path NOT LIKE '%/mcm/config/%'"
    " AND mf.path NOT LIKE 'interface/translations/%'"
    " AND mf.path NOT LIKE '%wizard.txt'"
    " AND mf.path NOT LIKE '%readme%'"
)


def _normalize(path):
    parts = path.replace("\\", "/").split("/")
    lower = [p.lower() for p in parts]
    if lower[0] == WRAPPER and len(parts) > 1:
        return "/".join(parts[1:]).lower()
    if len(parts) > 1 and lower[0] not in DATA_DIRS and not lower[0].endswith((".esp", ".esl", ".esm")):
        for i in range(1, len(parts)):
            if lower[i] == WRAPPER:
                return "/".join(parts[i + 1:]).lower() if i + 1 < len(parts) else parts[i - 1].lower()
            if lower[i] in DATA_DIRS:
                return "/".join(parts[i:]).lower()
    return "/".join(parts).lower()


def _list_paths(filepath):
    """Data-relative loose-file paths inside an archive (7z/zip/rar) via
    `7z l -slt`. Directory entries mark themselves with an empty Folder
    field and an Attributes value starting with 'D' -- not Folder = '+'
    as you'd expect from the docs -- so both are checked."""
    proc = subprocess.run(
        ["7z", "l", "-slt", filepath], capture_output=True, text=True, timeout=120,
    )
    if proc.returncode > 1:  # 0 = ok, 1 = warnings; >1 = fatal / unreadable archive
        raise RuntimeError(f"7z exited {proc.returncode}: {(proc.stderr or '').strip()[:200]}")
    out = proc.stdout
    paths, cur, folder, attrs, past_header = [], None, "", "", False

    def flush():
        if cur is not None and folder != "+" and not attrs.startswith("D"):
            paths.append(_normalize(cur))

    for line in out.splitlines():
        if line.startswith("----------"):
            past_header = True
            continue
        if not past_header:
            continue
        if line.startswith("Path = "):
            flush()
            cur, folder, attrs = line[len("Path = "):], "", ""
        elif line.startswith("Folder = "):
            folder = line[len("Folder = "):].strip()
        elif line.startswith("Attributes = "):
            attrs = line[len("Attributes = "):].strip()
    flush()
    return paths


def scan():
    """Extract every not-yet-scanned ok archive's file listing and persist
    it. Idempotent per file_id -- a given Nexus file's bytes never change,
    so this is a one-time cost per download, not per run."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT file_id, filename FROM mods WHERE status = 'ok' AND COALESCE(files_scanned, 0) = 0"
        ).fetchall()
    for i, r in enumerate(rows):
        state["phase"] = f"Scanning archive {i + 1}/{len(rows)}"
        filepath = os.path.join(DOWNLOADS_DIR, r["filename"])
        if not os.path.isfile(filepath):
            # same rule as the except below: a missing file (deleted
            # out-of-band, or mid-rename during a commit) marked "scanned,
            # no files" would permanently read as conflict-free — skip it
            log.warning("archive scan: file not on disk, skipping: %s", r["filename"])
            continue
        try:
            entries = _list_paths(filepath)
        except Exception as e:
            # do NOT mark files_scanned: a transient failure (7z missing from
            # PATH, timeout, half-written archive) recorded as "scanned, no
            # files" would permanently read as conflict-free -- leave the row
            # unscanned so the next run retries it
            log.warning("archive scan failed for %s: %s", r["filename"], e)
            continue
        with db.connect() as conn:
            conn.executemany(
                "INSERT OR IGNORE INTO mod_files (file_id, path) VALUES (?, ?)",
                [(r["file_id"], p) for p in entries],
            )
            conn.execute("UPDATE mods SET files_scanned = 1 WHERE file_id = ?", (r["file_id"],))
    return len(rows)


def classify_file_types():
    """Derive bsa/loose/mixed per mod_id from already-scanned mod_files --
    no new 7z calls, pure re-derivation from data already on disk. Safe to
    call every scan run: overwrites any stale value, including clearing it
    back to NULL if a mod's file set ends up with no evidence either way.

    'bsa' = archive(s) contain only packed .bsa/.ba2 (+ plugin files) --
    left-panel position barely matters, nothing here can lose a real file
    overwrite. 'loose' = real Data-relative assets present. 'mixed' = both
    (loose still wins over any bsa per the engine's fixed asset-load
    priority, so still position-sensitive)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id,"
            " SUM(CASE WHEN mf.path IS NOT NULL AND ("
            "   lower(mf.path) LIKE '%.bsa' OR lower(mf.path) LIKE '%.ba2'"
            " ) THEN 1 ELSE 0 END) AS packed,"
            " SUM(CASE WHEN mf.path IS NOT NULL"
            "   AND lower(mf.path) NOT LIKE '%.bsa' AND lower(mf.path) NOT LIKE '%.ba2'"
            "   AND lower(mf.path) NOT LIKE '%.esp' AND lower(mf.path) NOT LIKE '%.esl'"
            "   AND lower(mf.path) NOT LIKE '%.esm'"
            " THEN 1 ELSE 0 END) AS loose"
            " FROM mods m LEFT JOIN mod_files mf ON mf.file_id = m.file_id"
            " WHERE m.status = 'ok' AND m.files_scanned = 1"
            " GROUP BY m.mod_id"
        ).fetchall()
        for r in rows:
            file_type = (
                "mixed" if r["packed"] and r["loose"]
                else "bsa" if r["packed"]
                else "loose" if r["loose"]
                else None
            )
            conn.execute(
                "INSERT INTO mod_sort (mod_id, file_type) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET file_type = excluded.file_type",
                (r["mod_id"], file_type),
            )
    return len(rows)


def scan_progress():
    """(scanned, total) archive-scan coverage over ok rows, for the UI's n/m line."""
    with db.connect() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM mods WHERE status = 'ok'").fetchone()["c"]
        scanned = conn.execute(
            "SELECT COUNT(*) c FROM mods WHERE status = 'ok' AND COALESCE(files_scanned, 0) = 1"
        ).fetchone()["c"]
    return scanned, total


def start_scan():
    """Async archive scan. Returns error string or None (mirrors start_download)."""

    def work():
        n = scan()
        classify_file_types()
        return f"Scanned {n} new archive(s)" if n else "Nothing new to scan"

    return jobs.start(_lock, state, "a scan is already running", work)


def pairs():
    """Mod pairs that share at least one real Data-relative file path,
    sorted unexpected-first then by how many files they share. Each pair
    lists the actual paths, so the UI/prompt can say 'A vs B: 14 files' with
    the receipts, not a prose guess.

    'expected' marks a pair where either side is in a bucket designed to be
    broadly overwritten (Foundation) or to broadly overwrite (Patches) --
    structurally intended, not a real collision to worry about. Derived
    live from the current bucket every call, never persisted, so it can't
    go stale if a mod's bucket changes later."""
    # the sharer filter runs in SQL (idx_mod_files_path) so python only ever
    # sees actually-colliding paths — mod_files holds 10^5-10^6 rows on a real
    # library and this runs on every /api/conflicts hit and inside bulk refine
    with db.connect() as conn:
        rows = conn.execute(
            "WITH shared AS ("
            "  SELECT mf.path FROM mod_files mf"
            "  JOIN mods m ON m.file_id = mf.file_id AND m.status = 'ok'"
            "  WHERE 1 = 1" + INCIDENTAL_PATH_SQL +
            "  GROUP BY mf.path HAVING COUNT(DISTINCT m.mod_id) BETWEEN 2 AND ?)"
            " SELECT mf.path, m.mod_id, m.mod_name, s.bucket FROM mod_files mf"
            " JOIN shared ON shared.path = mf.path"
            " JOIN mods m ON m.file_id = mf.file_id AND m.status = 'ok'"
            " LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " GROUP BY mf.path, m.mod_id",
            (_MAX_SHARERS,),
        ).fetchall()
    by_path = {}
    for r in rows:
        by_path.setdefault(r["path"], {})[r["mod_id"]] = (r["mod_name"], r["bucket"])

    found = {}
    for path, mods in by_path.items():
        if len(mods) < 2 or len(mods) > _MAX_SHARERS:
            continue
        ids = sorted(mods)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                entry = found.setdefault((a, b), {
                    "a": {"mod_id": a, "mod_name": mods[a][0], "bucket": mods[a][1]},
                    "b": {"mod_id": b, "mod_name": mods[b][0], "bucket": mods[b][1]},
                    "paths": [],
                })
                entry["paths"].append(path)
    for p in found.values():
        p["expected"] = p["a"]["bucket"] in STRUCTURAL_BUCKETS or p["b"]["bucket"] in STRUCTURAL_BUCKETS
    return sorted(found.values(), key=lambda p: (p["expected"], -len(p["paths"])))


def summary_for(mod_ids, limit=40):
    """Compact 'ModA vs ModB: N shared files' lines for a set of mod ids --
    meant to be injected into the sorter's LLM prompt as ground truth,
    replacing a guess with a fact. Excludes 'expected' (Foundation/Patches)
    pairs so the model's conflict context stays on genuinely uncertain
    collisions instead of restating the structurally-obvious. Returns ''
    if nothing scanned/overlapping."""
    ids = set(mod_ids)
    relevant = [
        p for p in pairs()
        if not p["expected"] and p["a"]["mod_id"] in ids and p["b"]["mod_id"] in ids
    ]
    lines = [
        f"{p['a']['mod_name']} ({p['a']['mod_id']}) vs {p['b']['mod_name']} ({p['b']['mod_id']}):"
        f" {len(p['paths'])} shared file(s)"
        for p in relevant[:limit]
    ]
    if len(relevant) > limit:
        lines.append(f"...and {len(relevant) - limit} more overlapping pair(s)")
    return "\n".join(lines)
