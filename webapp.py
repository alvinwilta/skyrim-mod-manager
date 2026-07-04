import os

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse

from modman import config, db, engine, mo2, nexus

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
    for r in rows:
        r["installed"] = mo2.is_installed(r["filename"])
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
    try:
        fetch = nexus.fetch_collection if "/collections/" in url else nexus.fetch_mod
        payload = fetch(url)
        modfiles = engine.parse_modlist(payload)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"fetch failed: {e}"}, status_code=502)
    return {"modlist": payload, "diff": engine.diff_modlist(modfiles), "count": len(modfiles)}


@app.post("/api/download")
async def download(request: Request):
    body = await request.json()
    try:
        modfiles = engine.parse_modlist(body["modlist"])
        file_ids = body["file_ids"]
    except (KeyError, TypeError, ValueError):
        return JSONResponse({"error": "expected {modlist, file_ids}"}, status_code=400)
    err = engine.start_download(modfiles, file_ids)
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


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=7788)
