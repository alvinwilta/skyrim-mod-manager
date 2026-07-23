import asyncio
import json
import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from modman import commit, conflicts, config, db, engine, importlocal, jobs, llm_refine, mo2, mo2_order, order_store, precedence, requirements

app = FastAPI(title="Mod Manager")
db.init_db()

# Local-only app with no auth: reject cross-origin browser requests (CSRF)
# and DNS-rebinding hosts. Requests without an Origin header (curl, the CLI)
# are allowed — browsers always send Origin on POST.
# MODMAN_EXTRA_ORIGINS (comma-separated) mirrors the MODMAN_DB_PATH pattern:
# read at import time so a throwaway test server on another port (e.g. 7799)
# can accept its own browser origin without loosening the default.
ALLOWED_ORIGINS = {"http://127.0.0.1:7788", "http://localhost:7788"}
ALLOWED_ORIGINS |= {o.strip() for o in os.environ.get("MODMAN_EXTRA_ORIGINS", "").split(",") if o.strip()}

app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.middleware("http")
async def reject_cross_origin(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        return JSONResponse({"error": "cross-origin request rejected"}, status_code=403)
    return await call_next(request)


# Built React frontend (frontend/ — Vite). `npm run build` produces dist/.
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "dist")


# The synchronous heuristic sort's registered slot: makes the inline sort
# visible to (and excluded by) every jobs.start-based job. See /api/sort.
_sort_state = {"running": False}
jobs.register("sort", _sort_state)


def _order_rewrite_busy():
    """409 while a job that rewrites ranks from its own start-of-job snapshot
    is running: a manual move/lock/flag-clear would be silently overwritten by
    its corrections. Downloads/imports stay allowed — parking is a pure append.
    Returns the response to send, or None to proceed."""
    for name, st in (("sort refine", llm_refine.state), ("rule enforcement", precedence.state)):
        if st.get("running"):
            return JSONResponse(
                {"error": f"a {name} job is running — wait for it to finish first"}, status_code=409
            )
    return None


def _order_frozen(action):
    """409 while the install order is committed to disk (or mid-rename):
    anything that adds/removes/renames archives would desync the prefixed
    names from the db. Returns the response to send, or None to proceed."""
    if commit.state.get("running"):
        return JSONResponse(
            {"error": "Files are being renamed — wait for the commit/revert to finish."}, status_code=409
        )
    if commit.is_committed():
        return JSONResponse(
            {"error": f"Install order is committed to disk — revert it before {action}."}, status_code=409
        )
    return None


def _need_file_ids(body):
    """(file_ids, error_response) from a {file_ids: [...]} body."""
    file_ids = (body or {}).get("file_ids") or []
    if not file_ids:
        return [], JSONResponse({"error": "no files selected"}, status_code=400)
    return file_ids, None


@app.get("/")
def index():
    built = os.path.join(DIST_DIR, "index.html")
    if not os.path.isfile(built):
        return JSONResponse(
            {"error": "frontend not built — run: cd frontend && npm install && npm run build"},
            status_code=503,
        )
    return FileResponse(built)


@app.get("/favicon.svg")
def favicon():
    return FileResponse(os.path.join(DIST_DIR, "favicon.svg"))


@app.get("/api/mods")
def mods(q: str = None):
    rows = db.list_mods(q)
    collections = db.collections_for_files([r["file_id"] for r in rows])
    for r in rows:
        r["installed"] = mo2.is_installed(r["filename"])
        r["collections"] = collections.get(r["file_id"], [])
    return rows


@app.get("/api/config")
def get_config():
    """Stored overrides + the effective (post-precedence) values so the UI can
    show what's actually in effect even when a value comes from .env/default."""
    return {
        "stored": db.get_config(),
        "effective": config.effective(),
        "sources": config.sources(),
        "keys": list(config.CONFIG_KEYS),
        "dir_keys": list(config.CONFIG_DIR_KEYS),
    }


@app.get("/api/browse")
def browse(path: str = None):
    """List subdirectories of `path` (default: home) so the Config tab's folder
    picker can navigate the real filesystem -- browsers can't read absolute
    paths from a file input. Dirs only, no file contents; hidden dirs skipped.
    Localhost single-user tool, so plain fs listing is acceptable."""
    base = os.path.abspath(os.path.expanduser(path) if path else os.path.expanduser("~"))
    if not os.path.isdir(base):
        base = "/"
    try:
        dirs = sorted(
            e for e in os.listdir(base)
            if not e.startswith(".") and os.path.isdir(os.path.join(base, e))
        )
    except OSError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return {"path": base, "parent": os.path.dirname(base) or "/", "dirs": dirs}


@app.post("/api/config")
async def save_config(request: Request):
    """Persist config overrides. Dir keys must point at an existing directory
    (blank clears the override). Changes take effect on restart -- config.py
    binds path constants at import (the UI says so)."""
    body = await request.json()
    values = {k: v for k, v in (body or {}).items() if k in config.CONFIG_KEYS}
    for key in config.CONFIG_DIR_KEYS:
        val = (values.get(key) or "").strip()
        if val:
            expanded = os.path.expanduser(val)
            if not os.path.isdir(expanded):
                return JSONResponse(
                    {"error": f"{key}: not an existing directory: {expanded}"}, status_code=400
                )
    if "cdp_port" in values and (values["cdp_port"] or "").strip():
        try:
            int(values["cdp_port"])
        except (TypeError, ValueError):
            return JSONResponse({"error": "cdp_port must be a number"}, status_code=400)
    db.set_config(values)
    return {"saved": True, "restart_required": True, "stored": db.get_config()}


@app.get("/api/state")
def get_state():
    return engine.state


@app.get("/api/events")
async def events(request: Request):
    """SSE push of download + sort-refine state, in place of client polling.

    Replaces two separate 700ms/3s intervals with one connection; the server
    only writes when a snapshot actually changed, and backs off to a slower
    check while both jobs are idle."""

    async def gen():
        last = None
        while not await request.is_disconnected():
            busy = engine.state.get("running") or llm_refine.state.get("running")
            payload = json.dumps({"dl": engine.state, "sort": llm_refine.state})
            if payload != last:
                yield f"data: {payload}\n\n"
                last = payload
            await asyncio.sleep(0.3 if busy else 1.5)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.post("/api/diff")
async def diff(request: Request):
    payload = await request.json()
    try:
        modfiles = engine.parse_modlist(payload)
    except (KeyError, TypeError, ValueError):
        return JSONResponse(
            {"error": "not a valid modlist json (expected data.collectionRevision.modFiles)"},
            status_code=400,
        )
    return await run_in_threadpool(engine.diff_modlist, modfiles)


@app.post("/api/fetch-collection")
async def fetch_collection(request: Request):
    body = await request.json()
    urls = (body or {}).get("url", "").split()
    if not urls:
        return JSONResponse({"error": "paste a collection or mod url first"}, status_code=400)
    # threadpool: the fetch is a synchronous requests call that can hold the
    # event loop for tens of seconds, stalling SSE and every other request
    try:
        return await run_in_threadpool(engine.fetch_and_register, urls)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"fetch failed: {e}"}, status_code=502)


@app.post("/api/download")
async def download(request: Request):
    body = await request.json()
    try:
        modfiles = engine.parse_modlist(body["modlist"])
        file_ids = body["file_ids"]
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {modlist, file_ids}"}, status_code=400)
    frozen = _order_frozen("downloading")
    if frozen:
        return frozen
    collection_id = (body or {}).get("collection_id")
    err = engine.start_download(modfiles, file_ids, collection_id=collection_id)
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": len(file_ids), "batches": engine.state.get("batches", 0)}


@app.post("/api/cancel")
async def cancel(request: Request):
    body = await request.json()
    if (body or {}).get("all"):
        n = engine.cancel_download(cancel_all=True)
    else:
        file_ids, err = _need_file_ids(body)
        if err:
            return err
        n = engine.cancel_download(file_ids)
    return {"cancelled": n}


@app.post("/api/validate")
async def validate(request: Request):
    file_ids, err = _need_file_ids(await request.json())
    if err:
        return err
    return await run_in_threadpool(engine.validate_files, file_ids)


@app.post("/api/delete")
async def delete(request: Request):
    body = await request.json()
    mod_ids = (body or {}).get("mod_ids") or []
    if mod_ids:
        # mod-level delete (install order tab): expand to every live file
        file_ids = db.file_ids_for_mods(mod_ids)
        if not file_ids:
            return JSONResponse({"error": "no live files for the selected mod(s)"}, status_code=400)
    else:
        file_ids, err = _need_file_ids(body)
        if err:
            return err
    frozen = _order_frozen("deleting files")
    if frozen:
        return frozen
    return await run_in_threadpool(engine.delete_files, file_ids)


@app.post("/api/purge")
async def purge(request: Request):
    file_ids, err = _need_file_ids(await request.json())
    if err:
        return err
    frozen = _order_frozen("purging files")
    if frozen:
        return frozen
    return await run_in_threadpool(engine.purge_files, file_ids)


@app.post("/api/redownload")
async def redownload(request: Request):
    file_ids, err = _need_file_ids(await request.json())
    if err:
        return err
    frozen = _order_frozen("downloading")
    if frozen:
        return frozen
    modfiles = await run_in_threadpool(engine.modfiles_from_db, file_ids)
    # adopted local mods carry negative synthetic ids and no Nexus source —
    # fail fast instead of launching a browser job guaranteed to fail
    local = [m["file"]["mod"]["name"] or str(m["fileId"]) for m in modfiles if m["file"]["mod"]["modId"] <= 0]
    if local:
        shown = ", ".join(local[:3]) + ("…" if len(local) > 3 else "")
        return JSONResponse(
            {"error": f"cannot redownload local/non-Nexus import(s) — no Nexus source: {shown}"},
            status_code=400,
        )
    err = engine.start_download(modfiles, file_ids)
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": len(file_ids), "batches": engine.state.get("batches", 0)}


@app.get("/api/installorder")
def installorder():
    return {**order_store.load_order(), "committed": commit.is_committed(), "hidden": commit.is_hidden()}


@app.get("/api/collections")
def list_collections():
    return {"collections": db.list_collections()}


@app.get("/api/collections/{collection_id}/mods")
def collection_mods(collection_id: int):
    return {"mods": db.collection_mods(collection_id), "buckets": order_store.BUCKETS}


@app.post("/api/collections/{collection_id}/enabled")
async def set_collection_enabled(collection_id: int, request: Request):
    body = await request.json()
    try:
        enabled = bool(body["enabled"])
    except (KeyError, TypeError):
        return JSONResponse({"error": "expected {enabled}"}, status_code=400)
    db.set_collection_enabled(collection_id, enabled)
    return {"id": collection_id, "enabled": enabled}


@app.get("/api/collections/{collection_id}/removable")
def collection_removable(collection_id: int):
    """Preview for remove-mods: how many downloaded files are exclusive to
    this collection (removable) vs shared with another collection (kept)."""
    exclusive, shared = db.collection_exclusive_files(collection_id)
    return {"removable": len(exclusive), "shared": shared}


@app.post("/api/collections/{collection_id}/remove-mods")
async def remove_collection_mods(collection_id: int):
    """Soft-delete the collection's exclusive downloaded files (archives off
    disk, rows recoverable, gone from the install order since it only lists
    'ok' mods) and disable the collection so its order rules stop applying.
    Files shared with any other collection are kept."""
    frozen = _order_frozen("removing collection mods")
    if frozen:
        return frozen
    exclusive, shared = db.collection_exclusive_files(collection_id)
    if exclusive:
        result = await run_in_threadpool(engine.delete_files, exclusive)
    else:
        result = {"deleted": 0, "files_removed": 0}
    db.set_collection_enabled(collection_id, False)
    return {**result, "shared_kept": shared}


@app.post("/api/import-local")
def import_local():
    frozen = _order_frozen("importing new files")
    if frozen:
        return frozen
    err = importlocal.start_scan()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.get("/api/import-local-state")
def import_local_state():
    return importlocal.state


@app.post("/api/scan-conflicts")
def scan_conflicts():
    err = conflicts.start_scan()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.get("/api/scan-state")
def scan_state():
    return conflicts.state


@app.get("/api/conflicts")
def get_conflicts():
    scanned, total = conflicts.scan_progress()
    return {"pairs": conflicts.pairs(), "scanned": scanned, "total": total}


@app.post("/api/sync-requirements")
def sync_requirements():
    err = requirements.start_scan()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.get("/api/requirements-state")
def requirements_state():
    return requirements.state


@app.get("/api/requirements-missing")
def requirements_missing():
    return {"missing": requirements.missing()}


@app.post("/api/enforce-order")
def enforce_order():
    frozen = _order_frozen("applying collection rules")
    if frozen:
        return frozen
    err = precedence.start_enforce()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.get("/api/enforce-state")
def enforce_state():
    return precedence.state


@app.post("/api/sort")
async def sort_mods(request: Request):
    body = await request.json()
    frozen = _order_frozen("sorting")
    if frozen:
        return frozen
    # the heuristic pass runs inline (no job thread), so it claims a
    # registered slot via begin_exclusive: while "sort" is claimed, every
    # registered job's start() refuses under the same guard lock — a
    # commit/refine can never begin mid-sort and snapshot ranks the sort
    # is about to rewrite.
    running = jobs.begin_exclusive("sort", _sort_state)
    if running:
        return JSONResponse({"error": running}, status_code=409)
    try:
        n = await run_in_threadpool(order_store.heuristic_sort)
    finally:
        jobs.end_exclusive(_sort_state)
    if (body or {}).get("llm"):
        err = llm_refine.start_llm_refine((body or {}).get("model") or "haiku")
        if err:
            return JSONResponse({"error": err}, status_code=409)
    return {"sorted": n, "llm": bool((body or {}).get("llm"))}


@app.post("/api/sort-desc")
async def sort_desc(request: Request):
    body = await request.json()
    frozen = _order_frozen("sorting")
    if frozen:
        return frozen
    err = llm_refine.start_desc_refine((body or {}).get("model") or "haiku")
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.get("/api/sort-state")
def sort_state():
    return llm_refine.state


@app.post("/api/sort-stop")
def sort_stop():
    err = llm_refine.stop()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"stopped": True}


@app.post("/api/order/move")
async def order_move(request: Request):
    body = await request.json()
    try:
        raw = body.get("mod_ids") or [body["mod_id"]]
        mod_ids = [int(i) for i in raw]
        position = int(body["position"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {mod_id | mod_ids, position}"}, status_code=400)
    frozen = _order_frozen("moving mods") or _order_rewrite_busy()
    if frozen:
        return frozen
    err = await run_in_threadpool(order_store.move, mod_ids, position)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"moved": mod_ids, "position": position}


@app.post("/api/order/lock")
async def order_lock(request: Request):
    body = await request.json()
    try:
        raw = body.get("mod_ids") or [body["mod_id"]]
        mod_ids = [int(i) for i in raw]
        locked = bool(body["locked"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {mod_id | mod_ids, locked}"}, status_code=400)
    frozen = _order_frozen("changing locks") or _order_rewrite_busy()
    if frozen:
        return frozen
    err = await run_in_threadpool(order_store.set_lock, mod_ids, locked)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"mod_ids": mod_ids, "locked": locked}


@app.post("/api/order/clear-flags")
async def order_clear_flags(request: Request):
    body = await request.json()
    kinds = body.get("kinds")
    if not isinstance(kinds, list) or not all(isinstance(k, str) for k in kinds):
        return JSONResponse({"error": "expected {kinds: [str, ...]}"}, status_code=400)
    busy = _order_rewrite_busy()  # a refine mid-flight re-writes these flags
    if busy:
        return busy
    cleared, err = await run_in_threadpool(order_store.clear_flags, kinds)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"cleared": cleared, "kinds": kinds}


@app.get("/api/order/check")
def order_check():
    return order_store.check_order()


@app.get("/api/order/mo2-check")
def order_mo2_check():
    return mo2_order.compare()


@app.post("/api/order/commit")
def order_commit():
    err = commit.start_commit()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.post("/api/order/uncommit")
def order_uncommit():
    err = commit.start_uncommit()
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.post("/api/order/hide-installed")
async def order_hide_installed(request: Request):
    body = await request.json()
    err = commit.start_hide(bool((body or {}).get("enabled")))
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": True}


@app.get("/api/order/commit-state")
def order_commit_state():
    return {**commit.state, "committed": commit.is_committed(), "hidden": commit.is_hidden()}


@app.get("/api/sort-prompt")
def get_sort_prompt():
    return {"prompt": llm_refine.get_prompt(), "default": llm_refine.DEFAULT_PROMPT}


@app.post("/api/sort-prompt")
async def set_sort_prompt(request: Request):
    body = await request.json()
    err = llm_refine.set_prompt((body or {}).get("prompt", ""))
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"saved": True}


# Vite emits hashed /assets/*.js|css; conditional so a fresh clone without a
# build still imports (GET / then explains the missing build).
if os.path.isdir(os.path.join(DIST_DIR, "assets")):
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=os.path.join(DIST_DIR, "assets")), name="assets")


if __name__ == "__main__":
    # timeout_graceful_shutdown: open SSE streams (/api/events) never close on
    # their own, so cap the connection-drain wait or SIGTERM hangs forever.
    uvicorn.run(app, host="127.0.0.1", port=7788, timeout_graceful_shutdown=3)
