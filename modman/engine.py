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

from . import collection_rules, conflicts, db, jobs, mo2, nexus, order_store
from .config import DOWNLOADS_DIR, GAME, MAX_WORKERS

log = logging.getLogger(__name__)

state = {"phase": "idle", "files": [], "error": None, "running": False}
_job_lock = threading.Lock()
jobs.register("download", state)

# signed CDN urls expire after ~4h; on free-tier bandwidth a large batch
# outlives them, so the transfer runs in rounds: entries whose link expired
# mid-batch get a fresh link next round (Range-resume picks up the partial)
_LINK_ROUNDS = 4


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


def _version_key(v):
    """Numeric tuple for ordering Nexus version strings ('2.5.1a' -> (2,5,1));
    None when the string has no digits, i.e. not comparable."""
    nums = re.findall(r"\d+", v or "")
    return tuple(int(n) for n in nums) if nums else None


def _norm_file_name(name):
    """File title with version-ish tokens stripped, for matching an incoming
    file to the library file it succeeds ('SkySA 2.5' == 'SkySA v2.8.3').
    Separators collapse first so underscore-glued versions ('SkyUI_5_2_SE')
    still shed their digits."""
    s = re.sub(r"[\s\-_.]+", " ", (name or "").lower())
    return re.sub(r"\bv?\d\S*", "", s).strip()


def _title_kin(a, b):
    """True when one normalized title's words are a subset of the other's —
    'papyrus extender' vs 'papyrus extender se' is the same file line renamed,
    'ordinator vokrii patch' vs 'ordinator apocalypse patch' is not."""
    ta, tb = set(a.split()), set(b.split())
    return bool(ta) and bool(tb) and (ta <= tb or tb <= ta)


def _row_recency(r):
    """Sort key: newest version first, download time as tiebreak/fallback."""
    return (_version_key(r["file_version"]) or (), r["downloaded_at"] or "")


def _assign_predecessors(entries, rows, live_ids_fn=lambda: None):
    """{fileId: [superseded rows]} for one mod's incoming files (exact
    file_id matches already removed). Mod id confirms these are the same mod,
    but a mod legitimately offers several distinct files (main, optionals,
    patches, variants) — so titles pair files up within the mod:

    - every row sharing an incoming file's title is superseded by it — a
      library holding several old revisions of one file line gets ALL of
      them replaced, not an 'ambiguous' shrug;
    - one leftover incoming file claims the leftover rows when they are a
      single title line kin to its own title (title drift between versions)
      AND Nexus no longer lists them as current files (live_ids_fn — ground
      truth: a still-current file is a distinct file, not someone's past;
      returns None when unavailable = no veto, heuristic stands);
      unrelated-titled leftovers (true sibling additions) stay unclaimed."""
    out = {}
    claimed = set()
    unmatched = []
    for f in entries:
        want = _norm_file_name(f["name"])
        matches = [r for r in rows if _norm_file_name(r["file_name"]) == want]
        if matches:
            out[f["fileId"]] = matches
            claimed.update(r["file_id"] for r in matches)
        else:
            unmatched.append(f)
    left = [r for r in rows if r["file_id"] not in claimed]
    if len(unmatched) == 1 and left:
        titles = {_norm_file_name(r["file_name"]) for r in left}
        if len(titles) == 1 and _title_kin(titles.pop(), _norm_file_name(unmatched[0]["name"])):
            live = live_ids_fn()
            if live:
                left = [r for r in left if r["file_id"] not in live]
            if left:
                out[unmatched[0]["fileId"]] = left
    return out


def _rows_by_mod(conn):
    by_mod = {}
    for r in conn.execute("SELECT * FROM mods WHERE status = 'ok' ORDER BY downloaded_at"):
        by_mod.setdefault(r["mod_id"], []).append(dict(r))
    return by_mod


def _name_keys(name):
    """Match keys for one title/filename: the full normalized form plus the
    part before the first digit, so an MO2-style archive name
    ('SkyUI_5_2_SE-3863-5-2-SE-1573234894') still meets the Nexus file title
    ('SkyUI_5_2_SE') despite the id/version/timestamp tail."""
    keys = set()
    full = _norm_file_name(name)
    if full:
        keys.add(full)
    head = re.split(r"\d", (name or "").lower(), maxsplit=1)[0]
    head = re.sub(r"[\s\-_.]+", " ", head).strip()
    if len(head) > 2:
        keys.add(head)
    return keys


def _local_name_index(by_mod):
    """Name index of local/non-Nexus adoptions (negative synthetic mod ids).
    These rows can never match an incoming Nexus file by id, so they get the
    name-based fallback: keyed by every _name_keys of their archive stem and
    mod_name."""
    idx = {}
    for mid, rows in by_mod.items():
        if mid >= 0:
            continue
        for r in rows:
            stem = os.path.splitext(r["file_name"] or "")[0]
            for key in _name_keys(stem) | _name_keys(r["mod_name"]):
                idx.setdefault(key, {})[r["file_id"]] = r
    return idx


def _local_match(local_idx, file_name):
    """The unique locally-adopted row an incoming file's name resolves to,
    or None (no match / ambiguous)."""
    found = {}
    for key in _name_keys(file_name):
        found.update(local_idx.get(key, {}))
    rows = list(found.values())
    return rows[0] if len(rows) == 1 else None


def _candidates(by_mod, mod_id, incoming_ids):
    """Candidate predecessor rows for one mod. Rows the modlist itself claims
    exactly (their file_id is another incoming entry) can't be anyone's
    predecessor — without this, a collection listing a mod's main file + a
    patch would let the patch claim the main file as its past."""
    all_rows = by_mod.get(mod_id, [])
    return [r for r in all_rows if r["file_id"] not in incoming_ids]


def _match_all(modfiles, by_mod, local_idx, have_all_ids):
    """{fileId: [superseded rows]} across a whole modlist. Id first: incoming
    files grouped per known mod_id and paired against that mod's rows
    (_assign_predecessors). The name fallback runs only when the mod id is
    absent from the library entirely — the mod may still be there as a local
    adoption whose synthetic id can never match."""
    incoming_ids = {m["file"]["fileId"] for m in modfiles}
    per_mod = {}
    matched = {}
    for m in modfiles:
        f, mod = m["file"], m["file"]["mod"]
        if f["fileId"] in have_all_ids:
            continue  # exact re-record/redownload — never a replacement
        if mod["modId"] in by_mod:
            per_mod.setdefault(mod["modId"], []).append(f)
        else:
            local = _local_match(local_idx, f["name"])
            if local:
                matched[f["fileId"]] = [local]
    for mod_id, entries in per_mod.items():
        domain = ((entries[0].get("mod") or {}).get("game") or {}).get("domainName")
        matched.update(_assign_predecessors(
            entries, _candidates(by_mod, mod_id, incoming_ids), _live_ids_lazy(mod_id, domain)))
    return matched


def _live_ids_lazy(mod_id, domain):
    """Deferred nexus.live_file_ids for one mod — only hit the network if the
    assignment actually reaches the drift-claim branch. None on any failure
    (offline pasted-modlist diffs must keep working on the heuristic alone)."""
    def get():
        if mod_id <= 0:
            return None
        try:
            return nexus.live_file_ids(mod_id, domain or GAME)
        except Exception as e:
            log.warning("no live file list for mod %s (%s) — using name heuristic", mod_id, e)
            return None
    return get


def diff_modlist(modfiles):
    """Compare a modlist against the local DB.

    new: file not in the library (unknown mod, or a sibling file of a known
    mod). updated/downgraded: a different revision of a file we have — id
    first (mod_id scopes to that mod's rows, title disambiguates between
    them), falling back to name-matching locally-adopted rows when the mod id
    is absent; the direction comes from comparing version strings
    (unparseable versions land in updated). unchanged: exact file recorded.
    Updated/downgraded items carry old_file_id — downloading them replaces
    that file (see _plan_replacements)."""
    with db.connect() as conn:
        have_files = {r["file_id"] for r in conn.execute("SELECT file_id FROM mods WHERE status = 'ok'")}
        by_mod = _rows_by_mod(conn)

    matched = _match_all(modfiles, by_mod, _local_name_index(by_mod), have_files)
    out = {"new": [], "updated": [], "downgraded": [], "unchanged": []}
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
            continue
        olds = matched.get(f["fileId"])
        if olds:
            old = max(olds, key=_row_recency)  # newest superseded revision is the one shown
            item["old_version"] = old["file_version"]
            item["old_file_id"] = old["file_id"]
            new_key, old_key = _version_key(f["version"]), _version_key(old["file_version"])
            group = "downgraded" if new_key and old_key and new_key < old_key else "updated"
            out[group].append(item)
        else:
            out["new"].append(item)
    return out


def _plan_replacements(modfiles):
    """{incoming file_id: [superseded file_ids]} for the files this download
    will replace — every old revision of the same file line, not just the
    newest. Computed against the DB *before* record_downloads inserts the new
    rows; after a replacement lands, the superseded archives are soft-deleted.
    A file_id already known to the DB (any status) is a redownload — never a
    replacement, so a mod's sibling file can't be mistaken for its past."""
    with db.connect() as conn:
        known = {r["file_id"] for r in conn.execute("SELECT file_id FROM mods")}
        by_mod = _rows_by_mod(conn)
    matched = _match_all(modfiles, by_mod, _local_name_index(by_mod), known)
    return {fid: [r["file_id"] for r in olds] for fid, olds in matched.items() if olds}


def _progress_entry(modfile):
    f, mod = modfile["file"], modfile["file"]["mod"]
    return {
        "name": base_for(modfile),
        "size": int(f.get("sizeInBytes") or 0),
        "got": 0,
        "status": "pending",
        # pre-seeded: a worker thread setting a NEW dict key while /api/state
        # or the SSE loop iterates this dict raises "dictionary changed size
        # during iteration" — overwriting an existing key is safe
        "filename": None,
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


def _generate_links(modfiles, progress):
    """Link-generation phase for one round: returns (url, filename, entry)
    tasks for every entry that got a url; the rest are marked failed."""
    tasks = []
    first = modfiles[0]["file"]["mod"]
    anchor_domain = (first.get("game") or {}).get("domainName") or "skyrimspecialedition"
    with nexus.LinkGenerator(anchor_domain, first["modId"]) as links:
        for m in modfiles:
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
    return tasks


def run_job(modfiles, file_ids, collection_id=None):
    """Synchronous download pipeline. Returns {'done': n, 'failed': n}."""
    os.makedirs(DOWNLOADS_DIR, exist_ok=True)

    wanted = set(file_ids)
    selected = [m for m in modfiles if m["file"]["fileId"] in wanted]
    progress = {e["name"]: e for e in (_progress_entry(m) for m in selected)}
    state["files"] = list(progress.values())

    if not selected:
        state["phase"] = "Finished"
        return {"done": 0, "failed": 0}

    # snapshot before record_downloads inserts the new rows
    replacements = _plan_replacements(selected)

    session = requests.Session()

    def work(task):
        url, filename, entry = task
        entry["status"] = "downloading"
        try:
            ok = nexus.retry(nexus.fetch_file, session, url, filename, entry,
                             fatal=(nexus.LinkExpired,))
        except nexus.LinkExpired:
            entry["status"] = "expired"  # next round regenerates and resumes
            log.info("expired link for %s — will regenerate", filename)
            return
        entry["status"] = "done" if ok else "failed"
        if ok:
            entry["filename"] = filename  # the exact on-disk name, for record_downloads
            try:
                mo2.write_meta(filename, entry["meta"])
            except OSError as e:
                log.warning("could not write .meta for %s: %s", filename, e)
        log.info("%s: %s", entry["status"], filename)

    remaining = selected
    try:
        for round_no in range(_LINK_ROUNDS):
            state["phase"] = ("Generating download links" if round_no == 0
                              else f"Refreshing {len(remaining)} expired link(s)")
            tasks = _generate_links(remaining, progress)
            if tasks:
                state["phase"] = "Downloading"
                with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
                    list(ex.map(work, tasks))
            remaining = [m for m in remaining if progress[base_for(m)]["status"] == "expired"]
            if not remaining:
                break
        for m in remaining:  # rounds exhausted with links still expiring
            progress[base_for(m)]["status"] = "failed"
    finally:
        # one worker raising (e.g. disk full mid-batch) must not discard the
        # records of every file that DID complete
        db.record_downloads(progress.values())
        # a landed update supersedes its predecessor: drop the old archive
        # (soft-delete — the row stays recoverable, the disk file goes)
        done_fids = {e["meta"]["file_id"] for e in progress.values() if e["status"] == "done"}
        old_ids = sorted({oid for fid in done_fids for oid in replacements.get(fid, ())} - done_fids)
        if old_ids:
            try:
                res = delete_files(old_ids)
                log.info("replaced %d superseded file(s): %s", res["deleted"], old_ids)
            except Exception as e:
                log.warning("could not remove superseded file(s) %s: %s", old_ids, e)
        # park brand-new mods at the very END of the install order (Unsorted,
        # installed last = top of the overwrite stack) — appending shifts
        # nothing, so a refine running right now is completely undisturbed
        done_ids = [e["meta"]["mod_id"] for e in progress.values() if e["status"] == "done"]
        try:
            parked = order_store.park_new_at_end(done_ids)
            if parked:
                log.info("parked %d new mod(s) at the end of the install order", parked)
        except Exception as e:
            log.warning("could not park new mods: %s", e)

    if collection_id is not None:
        entries = [
            {
                "file_id": e["meta"]["file_id"], "mod_id": e["meta"]["mod_id"],
                "mod_name": e["meta"]["mod_name"],
                "mod_url": nexus.mod_url(e["meta"]["game"] or GAME, e["meta"]["mod_id"]),
            }
            for e in progress.values() if e["status"] == "done"
        ]
        db.link_collection_files(collection_id, entries)

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
            # disk == 0 is always missing: no real archive is empty, and a
            # size_bytes-0 row (Nexus metadata gap) must not bless a crash
            # artifact that never received its first chunk
            if not disk or (r["size_bytes"] and disk < r["size_bytes"]):
                conn.execute("UPDATE mods SET status = 'missing' WHERE file_id = ?", (r["file_id"],))
                report["missing"].append(r["file_id"])
            elif not r["size_bytes"]:
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


def purge_files(file_ids):
    """Hard-delete: remove the rows entirely (record + archive + .meta + conflict
    paths + collection links), and drop the mod_sort row for any mod left with no
    files. Used to permanently clear already soft-deleted entries."""
    removed = 0
    with db.connect() as conn:
        rows = conn.execute(
            # status != 'ok' backstop: purge is only ever offered on the
            # deleted-only view ('missing' covers the out-of-band-deleted
            # escape hatch) — a live row reaching here is a caller bug, and
            # hard-deleting it would be unrecoverable data loss
            f"SELECT file_id, mod_id, filename FROM mods"
            f" WHERE status != 'ok' AND file_id IN ({','.join('?' * len(file_ids))})",
            file_ids,
        ).fetchall()
        for r in rows:
            if r["filename"]:
                path = os.path.join(DOWNLOADS_DIR, r["filename"])
                if os.path.exists(path):
                    os.remove(path)
                    removed += 1
                mo2.remove_meta(r["filename"])
            conn.execute("DELETE FROM mods WHERE file_id = ?", (r["file_id"],))
            conn.execute("DELETE FROM mod_files WHERE file_id = ?", (r["file_id"],))
            conn.execute("DELETE FROM mod_collections WHERE file_id = ?", (r["file_id"],))
            # drop install-order state only if the mod has no other files left
            if not conn.execute("SELECT 1 FROM mods WHERE mod_id = ? LIMIT 1", (r["mod_id"],)).fetchone():
                conn.execute("DELETE FROM mod_sort WHERE mod_id = ?", (r["mod_id"],))
    return {"purged": len(rows), "files_removed": removed}


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


def fetch_and_register(urls):
    """Fetch one or more collection/single-mod modlists from nexusmods URLs
    and, for each collection among them, register it: collections row, links
    for its FULL modlist (import alone should record everything, downloaded
    or not), and the curator's ordering rules when an API key is configured.
    Multiple urls are merged into one modlist (deduped by file id) and diffed
    together, so a batch of mod-page urls behaves like pasting them one at a
    time. `collection` in the return value is the first collection registered
    (batches are expected to be single mods; a mixed batch still registers
    every collection's provenance, it just only surfaces one for the caller's
    optional collection_id hookup). Returns the /api/fetch-collection
    response body. Synchronous — callers run it off the event loop."""
    if isinstance(urls, str):
        urls = [urls]
    multi = len(urls) > 1
    modfiles_all = []
    seen_file_ids = set()
    collection = None
    for url in urls:
        is_collection = "/collections/" in url
        fetch = nexus.fetch_collection if is_collection else nexus.fetch_mod
        try:
            payload = fetch(url)
        except Exception as e:
            raise ValueError(f"{url}: {e}" if multi else str(e)) from e
        modfiles = parse_modlist(payload)
        if is_collection:
            rev = payload["data"]["collectionRevision"]
            slug = nexus.collection_slug(url)
            name = (rev.get("collection") or {}).get("name")
            collection_id = db.upsert_collection(slug, rev.get("collectionId"), rev.get("revisionNumber"), name)
            entries = [
                {
                    "file_id": m["fileId"], "mod_id": m["file"]["mod"]["modId"],
                    "mod_name": m["file"]["mod"]["name"],
                    "mod_url": nexus.mod_url(
                        (m["file"]["mod"].get("game") or {}).get("domainName") or GAME, m["file"]["mod"]["modId"]
                    ),
                }
                for m in modfiles
            ]
            db.link_collection_files(collection_id, entries)
            this_collection = {"id": collection_id, "slug": slug, "name": name}
            # curated ordering rules, if a personal API key is configured --
            # non-fatal, collection provenance above still works without it
            try:
                this_collection["rules_synced"] = collection_rules.sync(collection_id, rev.get("downloadLink"))
            except Exception as e:
                log.warning("collection rules sync failed for %s: %s", slug, e)
            if collection is None:
                collection = this_collection
        for m in modfiles:
            fid = m["file"]["fileId"]
            if fid not in seen_file_ids:
                seen_file_ids.add(fid)
                modfiles_all.append(m)
    merged_payload = {"data": {"collectionRevision": {"modFiles": modfiles_all}}}
    return {
        "modlist": merged_payload, "diff": diff_modlist(modfiles_all),
        "count": len(modfiles_all), "collection": collection,
    }


def start_download(modfiles, file_ids, collection_id=None):
    """Async wrapper around run_job for the web app. Returns error string or None."""

    def work():
        run_job(modfiles, file_ids, collection_id=collection_id)  # maintains its own phase

    return jobs.start(_job_lock, state, "a download job is already running", work,
                      exclusive_as="download")
