import shutil

from medialib.db import Database
from medialib.scanner import Scanner

from .conftest import make_image, make_video


def names(db, missing=0):
    return sorted(r["filename"] for r in db.query("SELECT filename FROM media WHERE missing = ?", (missing,)))


def test_scan_finds_media_and_skips_hidden_and_other_files(tmp_path, library):
    db = Database(tmp_path / "d" / "lib.db")
    Scanner(db, tmp_path / "d" / "thumbs").scan_now([library])
    assert names(db) == ["beach.jpg", "cat.webp", "sunset.png"]
    beach = dict(db.query_one("SELECT * FROM media WHERE filename = 'beach.jpg'"))
    assert beach["thumb_state"] == "ok" and (beach["width"], beach["height"]) == (80, 40)
    assert (tmp_path / "d" / "thumbs" / f"{beach['id']}.jpg").exists()


def test_video_thumbnail_and_duration(tmp_path):
    root = tmp_path / "media"
    make_video(root / "clip.mp4", seconds=3)
    db = Database(tmp_path / "lib.db")
    Scanner(db, tmp_path / "thumbs").scan_now([root])
    row = dict(db.query_one("SELECT * FROM media"))
    assert row["kind"] == "video" and row["thumb_state"] == "ok"
    assert 2.5 < row["duration"] < 3.5
    assert (row["width"], row["height"]) == (160, 90)


def test_rescan_keeps_tags_and_follows_moved_files(tmp_path, library):
    db = Database(tmp_path / "lib.db")
    scanner = Scanner(db, tmp_path / "thumbs")
    scanner.scan_now([library])
    beach_id = db.query_one("SELECT id FROM media WHERE filename = 'beach.jpg'")["id"]
    db.set_media_tags(beach_id, ["summer"])

    # Move + rename the file: tags must follow it.
    (library / "archive").mkdir()
    shutil.move(library / "holiday" / "beach.jpg", library / "archive" / "beach-2019.jpg")
    scanner.scan_now([library])
    row = db.query_one("SELECT id, filename, missing FROM media WHERE id = ?", (beach_id,))
    assert row["filename"] == "beach-2019.jpg" and row["missing"] == 0
    assert [t["name"] for t in db.tags_for([beach_id])[beach_id]] == ["summer"]

    # Delete a file: it's hidden but its tags are kept in case it comes back.
    cat_id = db.query_one("SELECT id FROM media WHERE filename = 'cat.webp'")["id"]
    db.set_media_tags(cat_id, ["pets"])
    data = (library / "cat.webp").read_bytes()
    (library / "cat.webp").unlink()
    scanner.scan_now([library])
    assert names(db, missing=1) == ["cat.webp"]
    (library / "cat.webp").write_bytes(data)
    scanner.scan_now([library])
    assert db.query_one("SELECT missing FROM media WHERE id = ?", (cat_id,))["missing"] == 0
    assert [t["name"] for t in db.tags_for([cat_id])[cat_id]] == ["pets"]


def test_changed_file_is_reindexed(tmp_path, library):
    db = Database(tmp_path / "lib.db")
    scanner = Scanner(db, tmp_path / "thumbs")
    scanner.scan_now([library])
    make_image(library / "cat.webp", (300, 100))
    import os, time
    os.utime(library / "cat.webp", (time.time() + 10, time.time() + 10))
    scanner.scan_now([library])
    row = db.query_one("SELECT width, height FROM media WHERE filename = 'cat.webp'")
    assert (row["width"], row["height"]) == (300, 100)
