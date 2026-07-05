import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse

from modman import config, conflicts, db, engine, llm_refine, mo2, nexus, order_store, requirements

app = FastAPI(title="Mod Manager")
db.init_db()

# Local-only app with no auth: reject cross-origin browser requests (CSRF)
# and DNS-rebinding hosts. Requests without an Origin header (curl, the CLI)
# are allowed — browsers always send Origin on POST.
ALLOWED_ORIGINS = {"http://127.0.0.1:7788", "http://localhost:7788"}

app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost"])


@app.middleware("http")
async def reject_cross_origin(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        return JSONResponse({"error": "cross-origin request rejected"}, status_code=403)
    return await call_next(request)


@app.get("/")
def index():
    return FileResponse(os.path.join(config.WEB_DIR, "index.html"))


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
        # link every mod this collection references that's already in the
        # library, not just whatever ends up freshly downloaded below
        db.link_collection_files(collection_id, [m["fileId"] for m in modfiles])
        collection = {"id": collection_id, "slug": slug, "name": name}
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
    return engine.delete_files(file_ids)


@app.post("/api/redownload")
async def redownload(request: Request):
    body = await request.json()
    file_ids = (body or {}).get("file_ids") or []
    if not file_ids:
        return JSONResponse({"error": "no files selected"}, status_code=400)
    err = engine.start_download(engine.modfiles_from_db(file_ids), file_ids)
    if err:
        return JSONResponse({"error": err}, status_code=409)
    return {"started": len(file_ids)}


@app.get("/api/installorder")
def installorder():
    return order_store.load_order()


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
    err = order_store.move(mod_ids, position)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"moved": mod_ids, "position": position}


@app.post("/api/order/lock")
async def order_lock(request: Request):
    body = await request.json()
    try:
        mod_id, locked = int(body["mod_id"]), bool(body["locked"])
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {mod_id, locked}"}, status_code=400)
    err = order_store.set_lock(mod_id, locked)
    if err:
        return JSONResponse({"error": err}, status_code=400)
    return {"mod_id": mod_id, "locked": locked}


@app.get("/api/order/check")
def order_check():
    return order_store.check_order()


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


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7788)
