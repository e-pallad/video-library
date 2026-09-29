import errno
import os
import shutil

import pytest
from fastapi.testclient import TestClient

from medialib import trash
from medialib.server import create_app

from .conftest import make_video


def client(data_dir):
    return TestClient(create_app(data_dir, scan_on_start=False))


def scan(c):
    c.app.state.scanner.scan_now(c.app.state.db.get_setting("roots"))


def ids_by_name(c, **params):
    return {i["filename"]: i["id"] for i in c.get("/api/media", params=params).json()["items"]}


def test_full_flow_tags_persist_across_restart(tmp_path, library):
    data = tmp_path / "data"
    with client(data) as c:
        r = c.put("/api/settings", json={"roots": [str(library)]})
        assert r.status_code == 200
        scan(c)
        items = ids_by_name(c)
        assert set(items) == {"beach.jpg", "sunset.png", "cat.webp"}

        assert c.put(f"/api/media/{items['beach.jpg']}/tags", json={"tags": ["Summer", "sea"]}).status_code == 200
        assert c.put(f"/api/media/{items['sunset.png']}/tags", json={"tags": ["summer"]}).json()["tags"][0]["name"] == "Summer"
        c.post("/api/media/bulk-tags", json={"ids": [items["cat.webp"]], "add": ["pets"]})

    # "Restart": brand new app instance on the same data directory.
    with client(data) as c:
        tags = {t["name"]: t["count"] for t in c.get("/api/tags").json()}
        assert tags == {"Summer": 2, "sea": 1, "pets": 1}
        assert set(ids_by_name(c, q="tag:summer")) == {"beach.jpg", "sunset.png"}
        assert set(ids_by_name(c, q="tag:summer -tag:sea")) == {"sunset.png"}
        assert set(ids_by_name(c, q="#summer #sea")) == {"beach.jpg"}
        assert set(ids_by_name(c, q="holiday")) == {"beach.jpg", "sunset.png"}  # folder name
        assert set(ids_by_name(c, q="pet")) == {"cat.webp"}                     # partial tag text
        assert set(ids_by_name(c, q="tag:nothing")) == set()
        assert c.get("/api/media", params={"q": "type:image"}).json()["total"] == 3


def test_media_file_supports_range_requests(tmp_path):
    root = tmp_path / "media"
    make_video(root / "clip.mp4")
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(root)]})
        scan(c)
        item = c.get("/api/media").json()["items"][0]
        assert item["thumb"] and item["duration"]
        r = c.get(item["url"], headers={"Range": "bytes=0-99"})
        assert r.status_code == 206 and len(r.content) == 100
        assert r.headers["content-type"] == "video/mp4"
        assert c.get(item["thumb"]).headers["content-type"] == "image/jpeg"

        c.post(f"/api/media/{item['id']}/position", json={"position": 1.5})
        detail = c.get(f"/api/media/{item['id']}").json()
        assert detail["position"] == 1.5


def test_related_and_detail(tmp_path, library):
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(library)]})
        scan(c)
        items = ids_by_name(c)
        for n in ("beach.jpg", "cat.webp"):
            c.put(f"/api/media/{items[n]}/tags", json={"tags": ["shared"]})
        d = c.get(f"/api/media/{items['beach.jpg']}").json()
        assert d["related"][0]["filename"] == "cat.webp"


def test_bad_input_and_security(tmp_path, library):
    with client(tmp_path / "data") as c:
        assert c.put("/api/settings", json={"roots": [str(tmp_path / "nope")]}).status_code == 400
        assert c.get("/api/media/999/file").status_code == 404
        assert c.put("/api/media/999/tags", json={"tags": ["x"]}).status_code == 404
        # Requests from a foreign Host header (DNS rebinding) are refused.
        assert c.get("/api/tags", headers={"Host": "evil.example.com"}).status_code == 403
        assert c.get("/api/tags", headers={"Host": "127.0.0.1:8000"}).status_code == 200
        # Frontend is served.
        assert "Media Library" in c.get("/").text


def test_browser_thumbnail_upload(tmp_path, library):
    import io
    from PIL import Image

    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(library)]})
        scan(c)
        mid = next(iter(ids_by_name(c).values()))
        buf = io.BytesIO()
        Image.new("RGB", (32, 18), "blue").save(buf, "JPEG")
        r = c.post(f"/api/media/{mid}/thumb", content=buf.getvalue(), headers={"X-Duration": "12.5"})
        assert r.status_code == 200 and r.json()["thumb"]
        assert c.post(f"/api/media/{mid}/thumb", content=b"garbage").status_code == 400


def test_mkv_stream_and_subtitles(tmp_path):
    import subprocess
    from medialib.ffmpeg import ffmpeg_exe

    root = tmp_path / "media"
    root.mkdir()
    (root / "clip.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nSidecar\n")
    subprocess.run([ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=6",
                    "-f", "lavfi", "-i", "sine=f=440:duration=6", "-c:v", "libx265", "-x265-params", "log-level=error",
                    "-c:a", "ac3", str(root / "clip.mkv")], check=True)
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(root)]})
        scan(c)
        item = c.get("/api/media").json()["items"][0]
        assert item["playback"] == "transcode" and not item["browser_playable"]
        detail = c.get(f"/api/media/{item['id']}").json()
        assert detail["codecs"]["video"] == "hevc" and detail["stream_mode"] == "transcode"
        assert [s["label"] for s in detail["subtitles"]] == ["External (SRT)"]
        assert "Sidecar" in c.get(detail["subtitles"][0]["url"]).text
        assert c.get(f"/api/media/{item['id']}/stream-start", params={"t": 2.5}).json()["start"] == 2.5
        r = c.get(detail["stream_url"], params={"t": 2})
        assert r.status_code == 200 and r.headers["content-type"] == "video/mp4"
        assert r.headers["x-playback-mode"] == "transcode"
        assert r.content[4:8] == b"ftyp" and len(r.content) > 1000


@pytest.fixture
def fake_trash(tmp_path, monkeypatch):
    """Stand-in for the OS trash so tests don't fill the real one."""
    bin_dir = tmp_path / "trash-bin"
    bin_dir.mkdir()

    def send2trash(path):
        shutil.move(path, bin_dir / os.path.basename(path))

    monkeypatch.setattr(trash, "send2trash", send2trash)
    return bin_dir


def test_delete_moves_file_to_trash_and_restore_keeps_tags(tmp_path, library, fake_trash):
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(library)]})
        scan(c)
        items = ids_by_name(c)
        beach = items["beach.jpg"]
        c.put(f"/api/media/{beach}/tags", json={"tags": ["sea"]})
        thumb = tmp_path / "data" / "thumbs" / f"{beach}.jpg"
        assert thumb.exists()

        r = c.post("/api/media/bulk-delete", json={"ids": [beach]})
        assert r.status_code == 200 and r.json() == {"deleted": [beach], "failed": []}
        assert not (library / "holiday" / "beach.jpg").exists()
        assert (fake_trash / "beach.jpg").exists()
        assert not thumb.exists()
        assert set(ids_by_name(c)) == {"sunset.png", "cat.webp"}
        assert set(ids_by_name(c, sort="random")) == {"sunset.png", "cat.webp"}
        assert {t["name"]: t["count"] for t in c.get("/api/tags").json()} == {"sea": 0}

        # Restored from the trash: a rescan brings it back with its tags and a new thumbnail.
        shutil.move(fake_trash / "beach.jpg", library / "holiday" / "beach.jpg")
        scan(c)
        assert ids_by_name(c)["beach.jpg"] == beach
        detail = c.get(f"/api/media/{beach}").json()
        assert [t["name"] for t in detail["tags"]] == ["sea"] and detail["thumb"]
        assert thumb.exists()


def test_delete_permanently_when_trash_fails(tmp_path, library, monkeypatch):
    def broken_trash(path):
        raise OSError(errno.EXDEV, "No trash on this drive")

    monkeypatch.setattr(trash, "send2trash", broken_trash)
    monkeypatch.setattr(trash.time, "sleep", lambda s: None)
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(library)]})
        scan(c)
        cat = ids_by_name(c)["cat.webp"]
        r = c.post("/api/media/bulk-delete", json={"ids": [cat, 999]}).json()
        assert r["deleted"] == []
        assert r["failed"] == [
            {"id": cat, "error": "No trash on this drive", "can_force": True},
            {"id": 999, "error": "Not in the library", "can_force": False},
        ]
        assert (library / "cat.webp").exists()

        r = c.post("/api/media/bulk-delete", json={"ids": [cat], "permanent": True}).json()
        assert r == {"deleted": [cat], "failed": []}
        assert not (library / "cat.webp").exists()
        assert "cat.webp" not in ids_by_name(c)


def test_delete_without_send2trash(tmp_path, library, monkeypatch):
    monkeypatch.setattr(trash, "send2trash", None)
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(library)]})
        scan(c)
        assert c.get("/api/settings").json()["trash"] is None
        cat = ids_by_name(c)["cat.webp"]
        failed = c.post("/api/media/bulk-delete", json={"ids": [cat]}).json()["failed"]
        assert failed[0]["can_force"] and (library / "cat.webp").exists()


def test_delete_input_and_cross_site_requests(tmp_path, library, fake_trash):
    with client(tmp_path / "data") as c:
        c.put("/api/settings", json={"roots": [str(library)]})
        scan(c)
        cat = ids_by_name(c)["cat.webp"]
        assert c.post("/api/media/bulk-delete", json={"ids": []}).status_code == 400
        assert c.post("/api/media/bulk-delete", json={"ids": "12"}).status_code == 400
        # Another website can't make the browser delete files (or change anything else).
        for origin in ("http://evil.example.com", "null"):
            r = c.post("/api/media/bulk-delete", json={"ids": [cat]}, headers={"Origin": origin})
            assert r.status_code == 403
            assert c.put(f"/api/media/{cat}/tags", json={"tags": ["x"]}, headers={"Origin": origin}).status_code == 403
        assert (library / "cat.webp").exists()
        # The app's own page may.
        r = c.post("/api/media/bulk-delete", json={"ids": [cat]}, headers={"Origin": "http://testserver"})
        assert r.json()["deleted"] == [cat]


def test_windows_network_drives_ask_before_deleting_permanently(monkeypatch):
    calls = []
    monkeypatch.setattr(trash, "send2trash", calls.append)
    monkeypatch.setattr(trash.os.path, "lexists", lambda p: True)
    monkeypatch.setattr(trash.sys, "platform", "win32")
    # Windows would silently delete these for good, so the app must ask first.
    for path in (r"\\nas\media\clip.mp4", "//nas/media/clip.mp4"):
        with pytest.raises(trash.TrashFailed, match="network drives"):
            trash.delete_file(path)
    trash.delete_file(r"C:\Videos\clip.mp4")  # a local drive (no windll here, so treated as local)
    assert calls == [r"C:\Videos\clip.mp4"]
