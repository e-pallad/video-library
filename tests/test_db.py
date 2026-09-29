import pytest

from medialib.db import Database, TagError


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "lib.db")
    d.execute(
        "INSERT INTO media(path, path_key, root, rel_path, filename, ext, kind, added_at) "
        "VALUES('/a.mp4','/a.mp4','/','a.mp4','a.mp4','.mp4','video',0),"
        "('/b.jpg','/b.jpg','/','b.jpg','b.jpg','.jpg','image',0)"
    )
    return d


def test_tags_are_reused_case_insensitively(db):
    db.set_media_tags(1, ["Cats", "outdoor"])
    db.set_media_tags(2, ["cats", "  Outdoor  "])
    tags = db.list_tags()
    assert [t["name"] for t in tags] == ["Cats", "outdoor"]
    assert all(t["count"] == 2 for t in tags)


def test_duplicate_names_in_one_request_are_collapsed(db):
    assert [t["name"] for t in db.set_media_tags(1, ["a", "A", "a "])] == ["a"]


def test_empty_tag_rejected(db):
    with pytest.raises(TagError):
        db.set_media_tags(1, ["   "])


def test_rename_onto_existing_merges(db):
    db.set_media_tags(1, ["kitty"])
    db.set_media_tags(2, ["cat"])
    kitty = next(t for t in db.list_tags() if t["name"] == "kitty")
    merged = db.update_tag(kitty["id"], name="Cat")
    assert merged["name"] == "cat"
    assert [(t["name"], t["count"]) for t in db.list_tags()] == [("cat", 2)]


def test_bulk_add_remove(db):
    db.bulk_tags([1, 2], add=["x", "y"])
    db.bulk_tags([1], remove=["x"])
    tags = db.tags_for([1, 2])
    assert [t["name"] for t in tags[1]] == ["y"]
    assert [t["name"] for t in tags[2]] == ["x", "y"]


def test_delete_tag_removes_links(db):
    db.set_media_tags(1, ["gone"])
    tag_id = db.list_tags()[0]["id"]
    assert db.delete_tag(tag_id)
    assert db.tags_for([1])[1] == []
