"""Real (not guessed) install-order conflicts: two mods whose archives both
contain the same Data-relative file path, so one silently overwrites the
other depending on left-panel install order. This is a fact lookup from
actual archive contents (via `7z l`), independent of sorter.py's LLM-guessed
conflict notes -- nothing here is inferred from a mod's name or category.

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

from . import db
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
    out = subprocess.run(
        ["7z", "l", "-slt", filepath], capture_output=True, text=True, timeout=120,
    ).stdout
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
        try:
            entries = _list_paths(filepath) if os.path.isfile(filepath) else []
        except Exception as e:
            log.warning("archive scan failed for %s: %s", r["filename"], e)
            entries = []
        with db.connect() as conn:
            conn.executemany(
                "INSERT OR IGNORE INTO mod_files (file_id, path) VALUES (?, ?)",
                [(r["file_id"], p) for p in entries],
            )
            conn.execute("UPDATE mods SET files_scanned = 1 WHERE file_id = ?", (r["file_id"],))
    return len(rows)


def start_scan():
    """Async archive scan. Returns error string or None (mirrors start_download)."""
    if not _lock.acquire(blocking=False):
        return "a scan is already running"

    def runner():
        try:
            state.update({"error": None, "running": True})
            n = scan()
            state["phase"] = f"Scanned {n} new archive(s)" if n else "Nothing new to scan"
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None


def pairs():
    """Mod pairs that share at least one real Data-relative file path,
    sorted by how many files they share. Each pair lists the actual paths,
    so the UI/prompt can say 'A vs B: 14 files' with the receipts, not a
    prose guess."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT mf.path, m.mod_id, m.mod_name, s.bucket FROM mod_files mf"
            " JOIN mods m ON m.file_id = mf.file_id AND m.status = 'ok'"
            " LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " GROUP BY mf.path, m.mod_id"
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
    return sorted(found.values(), key=lambda p: -len(p["paths"]))


def summary_for(mod_ids, limit=40):
    """Compact 'ModA vs ModB: N shared files' lines for a set of mod ids --
    meant to be injected into the sorter's LLM prompt as ground truth,
    replacing a guess with a fact. Returns '' if nothing scanned/overlapping."""
    ids = set(mod_ids)
    relevant = [p for p in pairs() if p["a"]["mod_id"] in ids and p["b"]["mod_id"] in ids]
    lines = [
        f"{p['a']['mod_name']} ({p['a']['mod_id']}) vs {p['b']['mod_name']} ({p['b']['mod_id']}):"
        f" {len(p['paths'])} shared file(s)"
        for p in relevant[:limit]
    ]
    if len(relevant) > limit:
        lines.append(f"...and {len(relevant) - limit} more overlapping pair(s)")
    return "\n".join(lines)
