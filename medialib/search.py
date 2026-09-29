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
    "random": None,  # handled separately (seeded, so pagination is stable)
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
    """Return (sql, params, count_sql, count_params)."""
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
    if sort == "random":
        seed = int(seed) % 2147483647 or 1
        order = f"((m.id * {seed}) % 2147483647), m.id"
    else:
        order = SORTS.get(sort) or SORTS["newest"]

    cols = ", ".join(f"m.{c.strip()}" for c in MEDIA_COLUMNS.split(","))
    sql = f"SELECT {cols} FROM media m {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    count_sql = f"SELECT COUNT(*) FROM media m {where_sql}"
    return sql, params + [int(limit), int(offset)], count_sql, list(params), p
