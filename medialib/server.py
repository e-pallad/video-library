"""HTTP API and static frontend."""

import mimetypes
import os
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, search, thumbs
from .config import BROWSER_VIDEO_EXTS, default_data_dir
from .db import Database, TagError
from .scanner import Scanner

STATIC_DIR = Path(__file__).parent / "static"

for _ext, _type in {
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".ogv": "video/ogg", ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv",
    ".webp": "image/webp", ".avif": "image/avif", ".3gp": "video/3gpp",
}.items():
    mimetypes.add_type(_type, _ext)

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}


def create_app(data_dir=None, allow_remote=False, scan_on_start=True):
    data_dir = Path(data_dir or default_data_dir())
    db = Database(data_dir / "library.db")
    thumbs_dir = data_dir / "thumbs"
    scanner = Scanner(db, thumbs_dir)

    @asynccontextmanager
    async def lifespan(_app):
        roots = db.get_setting("roots", [])
        if scan_on_start and roots:
            scanner.start(roots)
        yield
        db.close()

    app = FastAPI(title="Media Library", version=__version__, lifespan=lifespan)
    app.state.db, app.state.scanner, app.state.data_dir = db, scanner, data_dir

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # Block DNS-rebinding style access from web pages when bound to localhost.
        if not allow_remote:
            host = request.url.hostname or ""
            if host not in LOCAL_HOSTS and host != "testserver":
                return JSONResponse({"detail": "Forbidden host"}, status_code=403)
        return await call_next(request)

    # -- helpers -----------------------------------------------------------

    def serialize(items, with_tags=True):
        tags = db.tags_for([i["id"] for i in items]) if with_tags else {}
        out = []
        for i in items:
            d = {k: i[k] for k in (
                "id", "filename", "rel_path", "kind", "ext", "size", "mtime", "duration", "width",
                "height", "position", "view_count", "last_viewed_at", "added_at", "thumb_state",
            )}
            d["title"] = os.path.splitext(i["filename"])[0]
            d["folder"] = os.path.dirname(i["rel_path"]).replace("\\", "/")
            d["missing"] = bool(i["missing"])
            d["url"] = f"/api/media/{i['id']}/file"
            d["thumb"] = f"/api/media/{i['id']}/thumb?v={i['thumb_ver']}" if i["thumb_state"] == "ok" else None
            d["browser_playable"] = i["kind"] == "image" or i["ext"] in BROWSER_VIDEO_EXTS
            if with_tags:
                d["tags"] = tags.get(i["id"], [])
            out.append(d)
        return out

    def require_item(media_id):
        item = db.get_media(media_id)
        if not item:
            raise HTTPException(404, "Media not found")
        return item

    def require_file(media_id):
        path, missing = db.get_media_path(media_id)
        if not path or not os.path.isfile(path):
            raise HTTPException(404, "File not found on disk")
        return path

    def tag_error(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except TagError as e:
            raise HTTPException(400, str(e))

    # -- media -------------------------------------------------------------

    @app.get("/api/media")
    def list_media(q: str = "", type: str | None = None, sort: str = "newest", offset: int = 0,
                   limit: int = 60, seed: int = 1, filter: str | None = None):
        limit = max(1, min(limit, 500))
        sql, params, count_sql, count_params, parsed = search.build_sql(
            q, kind=type, sort=sort, limit=limit, offset=max(0, offset), seed=seed, watched=filter)
        rows = [dict(r) for r in db.query(sql, params)]
        total = db.query_one(count_sql, count_params)[0]
        return {
            "items": serialize(rows), "total": total, "offset": offset, "limit": limit,
            "query": {"tags": parsed.include_tags, "exclude_tags": parsed.exclude_tags,
                      "words": parsed.words, "exclude_words": parsed.exclude_words,
                      "kind": parsed.kind},
        }

    @app.get("/api/media/{media_id}")
    def media_detail(media_id: int):
        item = serialize([require_item(media_id)])[0]
        path, _ = db.get_media_path(media_id)
        item["path"] = path
        item["related"] = serialize(db.related(media_id, limit=24))
        return item

    @app.get("/api/media/{media_id}/file")
    def media_file(media_id: int):
        path = require_file(media_id)
        media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
        return FileResponse(path, media_type=media_type, content_disposition_type="inline",
                            filename=os.path.basename(path))

    @app.get("/api/media/{media_id}/thumb")
    def media_thumb(media_id: int):
        p = thumbs_dir / f"{media_id}.jpg"
        if not p.exists():
            raise HTTPException(404, "No thumbnail")
        return FileResponse(p, media_type="image/jpeg",
                            headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @app.post("/api/media/{media_id}/thumb")
    async def upload_thumb(media_id: int, request: Request):
        """Accept a frame captured by the browser when ffmpeg can't be used."""
        item = require_item(media_id)
        data = await request.body()
        if not data or len(data) > 10 * 1024 * 1024:
            raise HTTPException(400, "Invalid image")
        try:
            thumbs.thumb_from_bytes(data, thumbs_dir / f"{media_id}.jpg")
        except Exception:
            raise HTTPException(400, "Invalid image")
        meta = {}
        if request.headers.get("x-duration"):
            try:
                meta["duration"] = float(request.headers["x-duration"])
                meta["width"] = int(request.headers.get("x-width", 0)) or None
                meta["height"] = int(request.headers.get("x-height", 0)) or None
            except ValueError:
                meta = {}
        db.set_thumb_result(item["id"], True, meta)
        return serialize([db.get_media(media_id)], with_tags=False)[0]

    @app.post("/api/media/{media_id}/view")
    def media_view(media_id: int):
        require_item(media_id)
        db.record_view(media_id)
        return {"ok": True}

    @app.post("/api/media/{media_id}/position")
    async def media_position(media_id: int, request: Request):
        # POST (not PUT) so the browser can send it with navigator.sendBeacon on page unload.
        require_item(media_id)
        try:
            body = await request.json()
            position = float(body.get("position", 0))
        except Exception:
            raise HTTPException(400, "Expected JSON {position: seconds}")
        db.set_position(media_id, position)
        return {"ok": True}

    @app.put("/api/media/{media_id}/tags")
    def put_tags(media_id: int, body: dict = Body(...)):
        require_item(media_id)
        names = body.get("tags")
        if not isinstance(names, list):
            raise HTTPException(400, "Expected {tags: [names]}")
        return {"tags": tag_error(db.set_media_tags, media_id, names)}

    @app.post("/api/media/bulk-tags")
    def bulk_tags(body: dict = Body(...)):
        ids = [int(i) for i in body.get("ids", [])]
        if not ids:
            raise HTTPException(400, "No items selected")
        result = tag_error(db.bulk_tags, ids, body.get("add", []), body.get("remove", []))
        return {"tags": {str(k): v for k, v in result.items()}}

    @app.post("/api/media/{media_id}/open")
    def open_external(media_id: int, body: dict = Body(default={})):
        """Open the file in the OS default app, or reveal it in the file manager."""
        path = require_file(media_id)
        reveal = bool(body.get("reveal"))
        try:
            if sys.platform == "win32":
                if reveal:
                    subprocess.Popen(["explorer", "/select,", path])
                else:
                    os.startfile(path)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", "-R", path] if reveal else ["open", path])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(path) if reveal else path])
        except OSError as e:
            raise HTTPException(500, f"Could not open: {e}")
        return {"ok": True}

    # -- tags --------------------------------------------------------------

    @app.get("/api/tags")
    def list_tags():
        return db.list_tags()

    @app.post("/api/tags")
    def create_tag(body: dict = Body(...)):
        tag_id = tag_error(db.get_or_create_tag, body.get("name", ""))
        if body.get("color"):
            db.update_tag(tag_id, color=body["color"])
        return db.get_tag(tag_id)

    @app.patch("/api/tags/{tag_id}")
    def update_tag(tag_id: int, body: dict = Body(...)):
        color = body.get("color")
        tag = tag_error(db.update_tag, tag_id, name=body.get("name"),
                        color=color or None, clear_color="color" in body and not color)
        if not tag:
            raise HTTPException(404, "Tag not found")
        return tag

    @app.delete("/api/tags/{tag_id}")
    def delete_tag(tag_id: int):
        if not db.delete_tag(tag_id):
            raise HTTPException(404, "Tag not found")
        return {"ok": True}

    # -- library settings & scanning --------------------------------------

    @app.get("/api/settings")
    def get_settings():
        return {"roots": db.get_setting("roots", []), "data_dir": str(data_dir),
                "ffmpeg": bool(thumbs.ffmpeg_exe()), "version": __version__}

    @app.put("/api/settings")
    def put_settings(body: dict = Body(...)):
        roots = body.get("roots")
        if not isinstance(roots, list):
            raise HTTPException(400, "Expected {roots: [folders]}")
        cleaned, bad = [], []
        for r in roots:
            r = os.path.abspath(os.path.expanduser(str(r).strip().strip('"')))
            (cleaned if os.path.isdir(r) else bad).append(r)
        if bad:
            raise HTTPException(400, "Folder not found: " + ", ".join(bad))
        cleaned = list(dict.fromkeys(cleaned))
        db.set_setting("roots", cleaned)
        scanner.start(cleaned)
        return get_settings()

    @app.post("/api/scan")
    def start_scan():
        roots = db.get_setting("roots", [])
        if not roots:
            raise HTTPException(400, "No library folders configured")
        scanner.start(roots)
        return scanner.status

    @app.get("/api/scan/status")
    def scan_status():
        return scanner.status

    @app.get("/api/stats")
    def stats():
        return db.stats()

    # -- frontend ----------------------------------------------------------

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app
