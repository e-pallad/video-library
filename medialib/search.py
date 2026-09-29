"""Search query parsing and SQL generation.

Syntax (all terms are combined with AND):

    tag:cats  #cats  tag:"two words"   item must have the tag
    -tag:blurry  -#blurry              item must NOT have the tag
    type:video / type:image            restrict the media kind
    beach                              filename, folder path or a tag name contains "beach"
    -draft                             none of those contain "draft"
    "exact phrase"                     quoted text is matched as one term
"""

import re
from dataclasses import dataclass, field

from .db import MEDIA_COLUMNS, _like_escape

_TOKEN = re.compile(r'(-)?(?:(tag|type|is):|(#))?(?:"([^"]*)"?|(\S+))', re.IGNORECASE)

SORTS = {
    "newest": "m.mtime DESC, m.id DESC",
    "oldest": "m.mtime ASC, m.id ASC",
    "name": "m.filename COLLATE NOCASE ASC, m.id ASC",
    "name_desc": "m.filename COLLATE NOCASE DESC, m.id DESC",
    "longest": "COALESCE(m.duration, 0) DESC, m.id DESC",
    "shortest": "COALESCE(m.duration, 1e12) ASC, m.id ASC",
    "largest": "m.size DESC, m.id DESC",
    "most_viewed": "m.view_count DESC, m.last_viewed_at DESC, m.id DESC",
    "recent": "m.last_viewed_at IS NULL, m.last_viewed_at DESC, m.id DESC",
    "added": "m.added_at DESC, m.id DESC",
    "random": None,  # ordered in Python by mixed_order() (seeded, so pagination is stable)
}


@dataclass
class ParsedQuery:
    include_tags: list = field(default_factory=list)
    exclude_tags: list = field(default_factory=list)
    words: list = field(default_factory=list)
    exclude_words: list = field(default_factory=list)
    kind: str | None = None


def parse(q: str) -> ParsedQuery:
    p = ParsedQuery()
    for m in _TOKEN.finditer(q or ""):
        neg, prefix = m.group(1), (m.group(2) or m.group(3) or "").lower()
        quoted, bare = m.group(4), m.group(5)
        value = (quoted if quoted is not None else bare or "").strip()
        if not value or value == "-":
            continue
        if prefix in ("tag", "#"):
            (p.exclude_tags if neg else p.include_tags).append(value)
        elif prefix in ("type", "is"):
            v = value.lower().rstrip("s")
            if v in ("video", "image"):
                p.kind = v
            elif v in ("photo", "picture", "pic", "img"):
                p.kind = "image"
            elif v in ("movie", "clip", "vid"):
                p.kind = "video"
        else:
            (p.exclude_words if neg else p.words).append(value)
    return p


def build_sql(q="", kind=None, sort="newest", limit=60, offset=0, seed=1,
              include_missing=False, watched=None):
    """Return (sql, params, count_sql, count_params, parsed).

    For sort="random" the query instead returns the id, root and rel_path of every match,
    unpaged: order them with mixed_order() and fetch the requested page by id.
    """
    p = parse(q)
    kind = kind or p.kind
    where, params = [], []

    if not include_missing:
        where.append("m.missing = 0")
    if kind in ("video", "image"):
        where.append("m.kind = ?")
        params.append(kind)
    if watched == "in_progress":
        where.append("m.kind = 'video' AND m.position > 5 AND (m.duration IS NULL OR m.position < m.duration - 5)")

    tag_exists = (
        "EXISTS (SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id "
        "WHERE mt.media_id = m.id AND t.name = ? COLLATE NOCASE)"
    )
    for t in p.include_tags:
        where.append(tag_exists)
        params.append(t)
    for t in p.exclude_tags:
        where.append("NOT " + tag_exists)
        params.append(t)

    text_match = (
        "(m.filename LIKE ? ESCAPE '\\' OR m.rel_path LIKE ? ESCAPE '\\' OR EXISTS ("
        "SELECT 1 FROM media_tags mt JOIN tags t ON t.id = mt.tag_id "
        "WHERE mt.media_id = m.id AND t.name LIKE ? ESCAPE '\\'))"
    )
    for w in p.words:
        like = f"%{_like_escape(w)}%"
        where.append(text_match)
        params += [like, like, like]
    for w in p.exclude_words:
        like = f"%{_like_escape(w)}%"
        where.append("NOT " + text_match)
        params += [like, like, like]

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    count_sql = f"SELECT COUNT(*) FROM media m {where_sql}"
    if sort == "random":
        sql = f"SELECT m.id, m.root, m.rel_path FROM media m {where_sql}"
        return sql, list(params), count_sql, list(params), p

    order = SORTS.get(sort) or SORTS["newest"]
    cols = ", ".join(f"m.{c.strip()}" for c in MEDIA_COLUMNS.split(","))
    sql = f"SELECT {cols} FROM media m {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    return sql, params + [int(limit), int(offset)], count_sql, list(params), p


def mixed_order(rows, seed):
    """Ids of ``rows`` (id, root, rel_path) shuffled so that every folder is spread evenly.

    A folder with n items gets one item in each n-th of the list, at a random spot inside it,
    so the results don't come in runs from one folder. Positions only depend on the seed and
    on the other items of the same folder, which keeps pages stable while scrolling.
    """
    folders = {}
    for r in rows:
        folder = r["rel_path"].replace("\\", "/").rpartition("/")[0]
        folders.setdefault((r["root"], folder), []).append((_hash(seed, r["id"]), r["id"]))
    keyed = []
    for items in folders.values():
        items.sort()
        n = len(items)
        # The hash's high bits pick the item's slot in its folder, its low bits the spot in the slot.
        keyed += [((slot + (h & 0xFFFFF) / 0x100000) / n, media_id)
                  for slot, (h, media_id) in enumerate(items)]
    keyed.sort()
    return [media_id for _, media_id in keyed]


_M64 = (1 << 64) - 1


def _hash(seed, value):
    """Well-mixed 64-bit hash of two integers (splitmix64 finalizer)."""
    x = (int(value) * 0x9E3779B97F4A7C15 + int(seed) * 0xD1B54A32D192ED03) & _M64
    x = ((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9) & _M64
    x = ((x ^ (x >> 27)) * 0x94D049BB133111EB) & _M64
    return x ^ (x >> 31)
