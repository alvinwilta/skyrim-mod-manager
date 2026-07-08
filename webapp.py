import asyncio
import json
import logging
import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from modman import collection_rules, commit, config, conflicts, db, engine, importlocal, llm_refine, mo2, mo2_order, nexus, order_store, precedence, requirements

log = logging.getLogger(__name__)
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
    return engine.diff_modlist(modfiles)


@app.post("/api/fetch-collection")
async def fetch_collection(request: Request):
    body = await request.json()
    url = (body or {}).get("url", "")
    is_collection = "/collections/" in url
    try:
        fetch = nexus.fetch_collection if is_collection else nexus.fetch_mod
        payload = fetch(url)
        modfiles = engine.parse_modlist(payload)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"fetch failed: {e}"}, status_code=502)
    collection = None
    if is_collection:
        rev = payload["data"]["collectionRevision"]
        slug = nexus.collection_slug(url)
        name = (rev.get("collection") or {}).get("name")
        collection_id = db.upsert_collection(slug, rev.get("collectionId"), rev.get("revisionNumber"), name)
        # link this collection's FULL modlist now, whether or not any file
        # is actually downloaded -- import alone should register everything
        entries = [
            {
                "file_id": m["fileId"], "mod_id": m["file"]["mod"]["modId"],
                "mod_name": m["file"]["mod"]["name"],
                "mod_url": f"https://www.nexusmods.com/{(m['file']['mod'].get('game') or {}).get('domainName') or 'skyrimspecialedition'}/mods/{m['file']['mod']['modId']}",
            }
            for m in modfiles
        ]
        db.link_collection_files(collection_id, entries)
        collection = {"id": collection_id, "slug": slug, "name": name}
        # curated ordering rules, if a personal API key is configured --
        # non-fatal, collection provenance above still works without it
        try:
            n_rules = collection_rules.sync(collection_id, rev.get("downloadLink"))
            collection["rules_synced"] = n_rules
        except Exception as e:
            log.warning("collection rules sync failed for %s: %s", slug, e)
    return {
        "modlist": payload, "diff": engine.diff_modlist(modfiles),
        "count": len(modfiles), "collection": collection,
    }


@app.post("/api/download")
async def download(request: Request):
    body = await request.json()
    try:
        modfiles = engine.parse_modlist(body["modlist"])
        file_ids = body["file_ids"]
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {modlist, file_ids}"}, status_code=400)
    if commit.is_committed():
        return JSONResponse(
            {"error": "Install order is committed to disk — revert it before downloading."}, status_code=409
        )
    collection_id = (body or {}).get("collection_id")
    err = engine.start_download(modfiles, file_ids, collection_id=collection_id)
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": len(file_ids)}


@app.post("/api/validate")
async def validate(request: Request):
    body = await request.json()
    file_ids = (body or {}).get("file_ids") or []
    if not file_ids:
        return JSONResponse({"error": "no files selected"}, status_code=400)
    return engine.validate_files(file_ids)


@app.post("/api/delete")
async def delete(request: Request):
    body = await request.json()
    file_ids = (body or {}).get("file_ids") or []
    if not file_ids:
        return JSONResponse({"error": "no files selected"}, status_code=400)
    if commit.is_committed():
        return JSONResponse(
            {"error": "Install order is committed to disk — revert it before deleting files."}, status_code=409
        )
    return engine.delete_files(file_ids)


@app.post("/api/redownload")
async def redownload(request: Request):
    body = await request.json()
    file_ids = (body or {}).get("file_ids") or []
    if not file_ids:
        return JSONResponse({"error": "no files selected"}, status_code=400)
    if commit.is_committed():
        return JSONResponse(
            {"error": "Install order is committed to disk — revert it before downloading."}, status_code=409
        )
    err = engine.start_download(engine.modfiles_from_db(file_ids), file_ids)
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": len(file_ids)}


@app.get("/api/installorder")
def installorder():
    return {**order_store.load_order(), "committed": commit.is_committed()}


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


@app.post("/api/import-local")
def import_local():
    if commit.is_committed():
        return JSONResponse(
            {"error": "Install order is committed to disk — revert it before importing new files."}, status_code=409
        )
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
    with db.connect() as conn:
        total = conn.execute("SELECT COUNT(*) c FROM mods WHERE status = 'ok'").fetchone()["c"]
        scanned = conn.execute(
            "SELECT COUNT(*) c FROM mods WHERE status = 'ok' AND COALESCE(files_scanned, 0) = 1"
        ).fetchone()["c"]
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
    n = order_store.heuristic_sort()
    if (body or {}).get("llm"):
        err = llm_refine.start_llm_refine((body or {}).get("model") or "haiku")
        if err:
            return JSONResponse({"error": err}, status_code=409)
    return {"sorted": n, "llm": bool((body or {}).get("llm"))}


@app.post("/api/sort-desc")
async def sort_desc(request: Request):
    body = await request.json()
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
    if commit.is_committed():
        return JSONResponse({"error": "install order is committed to disk — revert first"}, status_code=409)
    err = order_store.move(mod_ids, position)
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
    if commit.is_committed():
        return JSONResponse({"error": "install order is committed to disk — revert first"}, status_code=409)
    err = order_store.set_lock(mod_ids, locked)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"mod_ids": mod_ids, "locked": locked}


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


@app.get("/api/order/commit-state")
def order_commit_state():
    return {**commit.state, "committed": commit.is_committed()}


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
    uvicorn.run(app, host="127.0.0.1", port=7788)
