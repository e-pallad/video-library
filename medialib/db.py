"""SQLite persistence: media rows, reusable tags, tag links and settings.

A single connection is shared between the web server's worker threads and the
background scanner, guarded by a re-entrant lock. SQLite is more than fast
enough for a personal library of tens of thousands of files.
"""

import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS media (
    id             INTEGER PRIMARY KEY,
    path           TEXT NOT NULL,
    path_key       TEXT NOT NULL UNIQUE,
    root           TEXT NOT NULL,
    rel_path       TEXT NOT NULL,
    filename       TEXT NOT NULL,
    ext            TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('video', 'image')),
    size           INTEGER NOT NULL DEFAULT 0,
    mtime          REAL NOT NULL DEFAULT 0,
    duration       REAL,
    width          INTEGER,
    height         INTEGER,
    position       REAL NOT NULL DEFAULT 0,
    fingerprint    TEXT,
    missing        INTEGER NOT NULL DEFAULT 0,
    thumb_state    TEXT NOT NULL DEFAULT 'pending',
    thumb_ver      INTEGER NOT NULL DEFAULT 0,
    media_info     TEXT,
    added_at       REAL NOT NULL,
    last_viewed_at REAL,
    view_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_media_fingerprint ON media(fingerprint);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(kind, missing);

CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color      TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS media_tags (
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    added_at REAL NOT NULL,
    PRIMARY KEY (media_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_media_tags_tag ON media_tags(tag_id);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

MEDIA_COLUMNS = (
    "id, path, root, rel_path, filename, ext, kind, size, mtime, duration, width, height, "
    "position, missing, thumb_state, thumb_ver, media_info, added_at, last_viewed_at, view_count"
)

_ws = re.compile(r"\s+")


class TagError(ValueError):
    pass


def clean_tag_name(name: str) -> str:
    name = _ws.sub(" ", str(name or "")).strip()
    if not name:
        raise TagError("Tag name cannot be empty")
    if len(name) > 64:
        raise TagError("Tag name is too long (max 64 characters)")
    if '"' in name:
        raise TagError('Tag names cannot contain double quotes')
    return name


class Database:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        self._migrate()

    def _migrate(self):
        """Add columns introduced after a library database was first created."""
        cols = {r["name"] for r in self.conn.execute("PRAGMA table_info(media)")}
        for name, ddl in (("media_info", "TEXT"),):
            if name not in cols:
                self.conn.execute(f"ALTER TABLE media ADD COLUMN {name} {ddl}")

    def close(self):
        with self.lock:
            self.conn.close()

    # -- low level helpers -------------------------------------------------

    @contextmanager
    def tx(self):
        """Run a block inside a single transaction."""
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                yield self.conn
            except BaseException:
                self.conn.execute("ROLLBACK")
                raise
            else:
                self.conn.execute("COMMIT")

    def query(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    def query_one(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def execute(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params)

    # -- settings ----------------------------------------------------------

    def get_setting(self, key, default=None):
        row = self.query_one("SELECT value FROM settings WHERE key = ?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key, value):
        self.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    # -- media -------------------------------------------------------------

    def get_media(self, media_id):
        row = self.query_one(f"SELECT {MEDIA_COLUMNS} FROM media WHERE id = ?", (media_id,))
        return dict(row) if row else None

    def get_media_many(self, media_ids):
        """Rows for the given ids, in the same order."""
        rows = {}
        for chunk in _chunks(list(media_ids), 500):
            marks = ",".join("?" * len(chunk))
            for r in self.query(f"SELECT {MEDIA_COLUMNS} FROM media WHERE id IN ({marks})", chunk):
                rows[r["id"]] = dict(r)
        return [rows[i] for i in media_ids if i in rows]

    def get_media_path(self, media_id):
        row = self.query_one("SELECT path, missing FROM media WHERE id = ?", (media_id,))
        return (row["path"], bool(row["missing"])) if row else (None, True)

    def tags_for(self, media_ids):
        """Map media id -> sorted list of tag dicts."""
        ids = list(media_ids)
        out = {i: [] for i in ids}
        if not ids:
            return out
        for chunk in _chunks(ids, 500):
            marks = ",".join("?" * len(chunk))
            rows = self.query(
                f"SELECT mt.media_id, t.id, t.name, t.color FROM media_tags mt "
                f"JOIN tags t ON t.id = mt.tag_id WHERE mt.media_id IN ({marks}) "
                f"ORDER BY t.name COLLATE NOCASE",
                chunk,
            )
            for r in rows:
                out[r["media_id"]].append({"id": r["id"], "name": r["name"], "color": r["color"]})
        return out

    def record_view(self, media_id):
        self.execute(
            "UPDATE media SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?",
            (time.time(), media_id),
        )

    def set_position(self, media_id, position):
        self.execute(
            "UPDATE media SET position = ?, last_viewed_at = ? WHERE id = ?",
            (max(0.0, float(position)), time.time(), media_id),
        )

    def set_thumb_result(self, media_id, ok, meta=None):
        meta = meta or {}
        info = meta.get("info")
        self.execute(
            "UPDATE media SET thumb_state = ?, thumb_ver = thumb_ver + ?, "
            "duration = COALESCE(?, duration), width = COALESCE(?, width), height = COALESCE(?, height), "
            "media_info = COALESCE(?, media_info) WHERE id = ?",
            ("ok" if ok else "failed", 1 if ok else 0,
             meta.get("duration"), meta.get("width"), meta.get("height"),
             json.dumps(info, separators=(",", ":")) if info else None, media_id),
        )

    def set_media_info(self, media_id, info):
        self.execute(
            "UPDATE media SET media_info = ?, duration = COALESCE(duration, ?), "
            "width = COALESCE(width, ?), height = COALESCE(height, ?) WHERE id = ?",
            (json.dumps(info, separators=(",", ":")), info.get("duration"), info.get("width"),
             info.get("height"), media_id),
        )

    def mark_deleted(self, media_id):
        """Hide an item whose file was deleted from the app.

        The row and its tags are kept like for any missing file, so restoring the file from the
        Recycle Bin and rescanning brings it back tagged. Its thumbnail is rebuilt then.
        """
        self.execute("UPDATE media SET missing = 1, thumb_state = 'pending' WHERE id = ?", (media_id,))

    def related(self, media_id, limit=20):
        """Items of the same kind sharing the most tags, topped up with items from the same folder.

        Videos only get videos and images only get images, so the two never mix.
        """
        item = self.get_media(media_id)
        if not item:
            return []
        rows = self.query(
            f"SELECT {_prefixed('m')}, COUNT(*) AS shared FROM media_tags mt "
            f"JOIN media m ON m.id = mt.media_id "
            f"WHERE mt.tag_id IN (SELECT tag_id FROM media_tags WHERE media_id = ?) "
            f"AND m.id != ? AND m.missing = 0 AND m.kind = ? "
            f"GROUP BY m.id ORDER BY shared DESC, RANDOM() LIMIT ?",
            (media_id, media_id, item["kind"], limit),
        )
        results = [dict(r) for r in rows]
        if len(results) < limit:
            seen = {r["id"] for r in results} | {media_id}
            folder = item["rel_path"].replace("\\", "/").rpartition("/")[0]
            like = _like_escape(folder + "/") + "%" if folder else "%"
            more = self.query(
                f"SELECT {MEDIA_COLUMNS} FROM media WHERE missing = 0 AND id != ? AND kind = ? "
                f"AND root = ? AND replace(rel_path, '\\', '/') LIKE ? ESCAPE '\\' "
                f"ORDER BY filename COLLATE NOCASE LIMIT ?",
                (media_id, item["kind"], item["root"], like, limit * 2),
            )
            for r in more:
                if r["id"] not in seen and len(results) < limit:
                    results.append(dict(r))
                    seen.add(r["id"])
        return results

    # -- tags --------------------------------------------------------------

    def get_or_create_tag(self, name, conn=None):
        name = clean_tag_name(name)
        c = conn or self.conn
        with self.lock:
            row = c.execute("SELECT id, name FROM tags WHERE name = ?", (name,)).fetchone()
            if row:
                return row["id"]
            cur = c.execute("INSERT INTO tags(name, created_at) VALUES(?, ?)", (name, time.time()))
            return cur.lastrowid

    def list_tags(self):
        rows = self.query(
            "SELECT t.id, t.name, t.color, t.created_at, "
            "COUNT(m.id) AS count, "
            "SUM(CASE WHEN m.kind = 'video' THEN 1 ELSE 0 END) AS videos, "
            "SUM(CASE WHEN m.kind = 'image' THEN 1 ELSE 0 END) AS images "
            "FROM tags t LEFT JOIN media_tags mt ON mt.tag_id = t.id "
            "LEFT JOIN media m ON m.id = mt.media_id AND m.missing = 0 "
            "GROUP BY t.id ORDER BY t.name COLLATE NOCASE"
        )
        return [
            {**dict(r), "videos": r["videos"] or 0, "images": r["images"] or 0}
            for r in rows
        ]

    def get_tag(self, tag_id):
        row = self.query_one("SELECT id, name, color FROM tags WHERE id = ?", (tag_id,))
        return dict(row) if row else None

    def set_media_tags(self, media_id, names):
        """Replace the tags on one item. Unknown tag names are created."""
        cleaned = _dedupe([clean_tag_name(n) for n in names])
        now = time.time()
        with self.tx() as c:
            ids = [self.get_or_create_tag(n, c) for n in cleaned]
            c.execute("DELETE FROM media_tags WHERE media_id = ?", (media_id,))
            c.executemany(
                "INSERT OR IGNORE INTO media_tags(media_id, tag_id, added_at) VALUES(?, ?, ?)",
                [(media_id, t, now) for t in ids],
            )
        return self.tags_for([media_id])[media_id]

    def bulk_tags(self, media_ids, add=(), remove=()):
        add = _dedupe([clean_tag_name(n) for n in add])
        remove = _dedupe([clean_tag_name(n) for n in remove])
        now = time.time()
        with self.tx() as c:
            add_ids = [self.get_or_create_tag(n, c) for n in add]
            c.executemany(
                "INSERT OR IGNORE INTO media_tags(media_id, tag_id, added_at) VALUES(?, ?, ?)",
                [(m, t, now) for m in media_ids for t in add_ids],
            )
            for n in remove:
                c.executemany(
                    "DELETE FROM media_tags WHERE media_id = ? AND tag_id = "
                    "(SELECT id FROM tags WHERE name = ?)",
                    [(m, n) for m in media_ids],
                )
        return self.tags_for(media_ids)

    def update_tag(self, tag_id, name=None, color=None, clear_color=False):
        """Rename/recolor a tag. Renaming onto an existing tag merges the two."""
        with self.tx() as c:
            tag = c.execute("SELECT id, name FROM tags WHERE id = ?", (tag_id,)).fetchone()
            if not tag:
                return None
            if name is not None:
                name = clean_tag_name(name)
                other = c.execute(
                    "SELECT id FROM tags WHERE name = ? AND id != ?", (name, tag_id)
                ).fetchone()
                if other:
                    c.execute(
                        "INSERT OR IGNORE INTO media_tags(media_id, tag_id, added_at) "
                        "SELECT media_id, ?, added_at FROM media_tags WHERE tag_id = ?",
                        (other["id"], tag_id),
                    )
                    c.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
                    tag_id = other["id"]
                else:
                    c.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tag_id))
            if clear_color:
                c.execute("UPDATE tags SET color = NULL WHERE id = ?", (tag_id,))
            elif color is not None:
                c.execute("UPDATE tags SET color = ? WHERE id = ?", (color, tag_id))
        return self.get_tag(tag_id)

    def delete_tag(self, tag_id):
        cur = self.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
        return cur.rowcount > 0

    # -- stats -------------------------------------------------------------

    def stats(self):
        row = self.query_one(
            "SELECT "
            "SUM(CASE WHEN kind='video' AND missing=0 THEN 1 ELSE 0 END) AS videos, "
            "SUM(CASE WHEN kind='image' AND missing=0 THEN 1 ELSE 0 END) AS images, "
            "SUM(CASE WHEN missing=1 THEN 1 ELSE 0 END) AS missing, "
            "SUM(CASE WHEN missing=0 THEN size ELSE 0 END) AS bytes "
            "FROM media"
        )
        tags = self.query_one("SELECT COUNT(*) AS n FROM tags")["n"]
        return {k: (row[k] or 0) for k in ("videos", "images", "missing", "bytes")} | {"tags": tags}


def _prefixed(alias):
    return ", ".join(f"{alias}.{c.strip()}" for c in MEDIA_COLUMNS.split(","))


def _like_escape(s):
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _dedupe(names):
    seen, out = set(), []
    for n in names:
        if n.lower() not in seen:
            seen.add(n.lower())
            out.append(n)
    return out


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]
