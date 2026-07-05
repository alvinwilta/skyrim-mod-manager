"""Download engine: modlist parsing, DB diff, and the download job.

The job runs in two phases: link generation (sequential, through the browser
session) and file transfer (thread pool, plain HTTP). Progress is exposed via
the module-level `state` dict, polled by the web frontend."""

import logging
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import requests

from . import conflicts, db, mo2, nexus
from .config import DOWNLOADS_DIR, MAX_WORKERS

log = logging.getLogger(__name__)

state = {"phase": "idle", "files": [], "error": None, "running": False}
_job_lock = threading.Lock()


def sanitize(name):
    return re.sub(r"[\\/:*?\"<>|.]", "", name).strip()


def parse_modlist(payload):
    modfiles = payload["data"]["collectionRevision"]["modFiles"]
    # coerce ids at the trust boundary: modlist json is pasted/fetched from the
    # internet and these values end up in html attributes and the db
    for m in modfiles:
        f = m["file"]
        m["fileId"] = int(m["fileId"])
        f["fileId"] = int(f["fileId"])
        f["mod"]["modId"] = int(f["mod"]["modId"])
    return modfiles


def base_for(modfile):
    f, mod = modfile["file"], modfile["file"]["mod"]
    return sanitize(f"{f['name']}-{mod['modId']}-{f['fileId']}-{mod['version']}-{f['version']}")


def diff_modlist(modfiles):
    """Compare a modlist against the local DB.

    new: mod not in DB at all. updated: mod present but with a different file.
    unchanged: exact file already recorded."""
    with db.connect() as conn:
        have_files = {r["file_id"] for r in conn.execute("SELECT file_id FROM mods WHERE status = 'ok'")}
        by_mod = {r["mod_id"]: dict(r) for r in conn.execute("SELECT * FROM mods WHERE status = 'ok' ORDER BY downloaded_at")}

    out = {"new": [], "updated": [], "unchanged": []}
    for m in modfiles:
        f, mod = m["file"], m["file"]["mod"]
        item = {
            "file_id": f["fileId"],
            "mod_id": mod["modId"],
            "name": f["name"],
            "mod_name": mod["name"],
            "version": f["version"],
            "mod_version": mod["version"],
            "author": mod.get("author"),
            "size": int(f.get("sizeInBytes") or 0),
        }
        if f["fileId"] in have_files:
            out["unchanged"].append(item)
        elif mod["modId"] in by_mod:
            old = by_mod[mod["modId"]]
            item["old_version"] = old["file_version"]
            item["old_name"] = old["file_name"]
            out["updated"].append(item)
        else:
            out["new"].append(item)
    return out


def _progress_entry(modfile):
    f, mod = modfile["file"], modfile["file"]["mod"]
    return {
        "name": base_for(modfile),
        "size": int(f.get("sizeInBytes") or 0),
        "got": 0,
        "status": "pending",
        "meta": {
            "mod_id": mod["modId"],
            "file_id": f["fileId"],
            "mod_name": mod["name"],
            "file_name": f["name"],
            "mod_version": mod["version"],
            "file_version": f["version"],
            "category": mod.get("category"),
            "author": mod.get("author"),
            "game": (mod.get("game") or {}).get("domainName"),
            "game_id": (mod.get("game") or {}).get("id"),
            "requirements_alert": f.get("requirementsAlert"),
        },
    }


def run_job(modfiles, file_ids, collection_id=None):
    """Synchronous download pipeline. Returns {'done': n, 'failed': n}."""
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)

    selected = [m for m in modfiles if m["file"]["fileId"] in set(file_ids)]
    progress = {e["name"]: e for e in (_progress_entry(m) for m in selected)}
    state["files"] = list(progress.values())

    state["phase"] = "Generating download links"
    tasks = []
    if not selected:
        state["phase"] = "Finished"
        return {"done": 0, "failed": 0}

    first = selected[0]["file"]["mod"]
    anchor_domain = (first.get("game") or {}).get("domainName") or "skyrimspecialedition"
    with nexus.LinkGenerator(anchor_domain, first["modId"]) as links:
        for m in selected:
            entry = progress[base_for(m)]
            meta = entry["meta"]
            entry["status"] = "url"
            url = nexus.retry(
                links.generate, meta["file_id"],
                game_id=meta["game_id"] or nexus.GAME_ID,
                mod_id=meta["mod_id"],
                domain=meta["game"] or anchor_domain,
            )
            if not url:
                entry["status"] = "failed"
                log.warning("no download url for %s", entry["name"])
                continue
            entry["status"] = "queued"
            tasks.append((url, nexus.filename_for(url, entry["name"]), entry))

    state["phase"] = "Downloading"
    session = requests.Session()

    def work(task):
        url, filename, entry = task
        entry["status"] = "downloading"
        ok = nexus.retry(nexus.fetch_file, session, url, filename, entry)
        entry["status"] = "done" if ok else "failed"
        if ok:
            mo2.write_meta(filename, entry["meta"])
        log.info("%s: %s", entry["status"], filename)

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        list(ex.map(work, tasks))

    db.record_downloads(progress.values())

    if collection_id is not None:
        done_ids = [e["meta"]["file_id"] for e in progress.values() if e["status"] == "done"]
        db.link_collection_files(collection_id, done_ids)

    # scan the freshly-recorded archives immediately (idempotent, cheap --
    # only touches files_scanned=0 rows) so conflict/BSA metadata is ready
    # without waiting for a manual "Scan archives" click
    try:
        conflicts.scan()
        conflicts.classify_file_types()
    except Exception as e:
        log.warning("post-download archive scan failed: %s", e)

    failed = sum(1 for e in progress.values() if e["status"] == "failed")
    state["phase"] = f"Finished ({failed} failed)" if failed else "Finished"
    return {"done": len(progress) - failed, "failed": failed}


def validate_files(file_ids):
    """Check selected library rows against the files on disk.

    Rows with sizeInBytes 0 from Nexus adopt the on-disk size. Missing or
    short files are flagged 'missing' so a redownload/diff picks them up.
    Returns {ok, fixed, missing} lists of file_ids."""
    report = {"ok": [], "fixed": [], "missing": []}
    with db.connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM mods WHERE file_id IN ({','.join('?' * len(file_ids))})", file_ids
        ).fetchall()
        for r in rows:
            path = os.path.join(DOWNLOADS_DIR, r["filename"]) if r["filename"] else None
            disk = os.path.getsize(path) if path and os.path.exists(path) else None
            if disk is None or (r["size_bytes"] and disk < r["size_bytes"]):
                conn.execute("UPDATE mods SET status = 'missing' WHERE file_id = ?", (r["file_id"],))
                report["missing"].append(r["file_id"])
            elif not r["size_bytes"] and disk:
                conn.execute(
                    "UPDATE mods SET size_bytes = ?, status = 'ok' WHERE file_id = ?", (disk, r["file_id"])
                )
                report["fixed"].append(r["file_id"])
            else:
                conn.execute("UPDATE mods SET status = 'ok' WHERE file_id = ?", (r["file_id"],))
                report["ok"].append(r["file_id"])
    return report


def delete_files(file_ids):
    """Soft-delete: mark rows 'deleted' (record kept) and remove the archives
    from disk. A later import will offer the mod as new again."""
    removed = 0
    with db.connect() as conn:
        rows = conn.execute(
            f"SELECT file_id, filename FROM mods WHERE file_id IN ({','.join('?' * len(file_ids))})", file_ids
        ).fetchall()
        for r in rows:
            path = os.path.join(DOWNLOADS_DIR, r["filename"]) if r["filename"] else None
            if path and os.path.exists(path):
                os.remove(path)
                removed += 1
            if r["filename"]:
                mo2.remove_meta(r["filename"])
            conn.execute("UPDATE mods SET status = 'deleted' WHERE file_id = ?", (r["file_id"],))
    return {"deleted": len(rows), "files_removed": removed}


def modfiles_from_db(file_ids):
    """Rebuild modlist-shaped entries from library rows, for redownloads."""
    with db.connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM mods WHERE file_id IN ({','.join('?' * len(file_ids))})", file_ids
        ).fetchall()
    return [
        {
            "fileId": r["file_id"],
            "optional": False,
            "file": {
                "fileId": r["file_id"],
                "name": r["file_name"],
                "size": 0,
                "sizeInBytes": r["size_bytes"],
                "version": r["file_version"],
                "requirementsAlert": r["requirements_alert"],
                "mod": {
                    "modId": r["mod_id"],
                    "name": r["mod_name"],
                    "version": r["mod_version"],
                    "author": r["author"],
                    "category": r["category"],
                    "game": {"id": nexus.game_id_for(r["game"]), "domainName": r["game"]},
                },
            },
        }
        for r in rows
    ]


def start_download(modfiles, file_ids, collection_id=None):
    """Async wrapper around run_job for the web app. Returns error string or None."""
    if not _job_lock.acquire(blocking=False):
        return "a download job is already running"

    def runner():
        try:
            state.update({"error": None, "running": True})
            run_job(modfiles, file_ids, collection_id=collection_id)
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _job_lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None
