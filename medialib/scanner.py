"""Folder scanning.

Rescans never delete rows or tags. A file that disappears is marked ``missing``
(hidden from the UI). When a new file appears with the same fingerprint as a
missing one it takes over that row, so tags follow files that were moved or
renamed.
"""

import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import kind_for, norm_path
from .thumbs import make_thumb

FINGERPRINT_CHUNK = 64 * 1024


def fingerprint(path, size):
    h = hashlib.sha1(str(size).encode())
    with open(path, "rb") as f:
        h.update(f.read(FINGERPRINT_CHUNK))
        if size > FINGERPRINT_CHUNK * 2:
            f.seek(-FINGERPRINT_CHUNK, os.SEEK_END)
            h.update(f.read(FINGERPRINT_CHUNK))
    return f"{size}:{h.hexdigest()}"


def walk_media(root):
    """Yield (path, kind, stat) for every supported file below root (skips hidden folders)."""
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                entries = list(it)
        except OSError:
            continue
        for e in entries:
            if e.name.startswith(".") or e.name.startswith("$"):
                continue
            try:
                if e.is_dir(follow_symlinks=False):
                    stack.append(e.path)
                elif e.is_file():
                    kind = kind_for(os.path.splitext(e.name)[1])
                    if kind:
                        yield e.path, kind, e.stat()
            except OSError:
                continue


class Scanner:
    def __init__(self, db, thumbs_dir, workers=None):
        self.db = db
        self.thumbs_dir = Path(thumbs_dir)
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)
        self.workers = workers or min(4, os.cpu_count() or 2)
        self._lock = threading.Lock()
        self._rescan = False
        self.status = {"running": False, "phase": "idle", "found": 0, "added": 0, "moved": 0,
                       "missing": 0, "thumbs_done": 0, "thumbs_total": 0, "finished_at": None,
                       "error": None}

    # -- public API --------------------------------------------------------

    def start(self, roots):
        """Run a scan in a background thread. If one is running, queue another afterwards."""
        if not self._lock.acquire(blocking=False):
            self._rescan = True
            return False
        threading.Thread(target=self._run_loop, args=(list(roots),), daemon=True).start()
        return True

    def scan_now(self, roots):
        """Synchronous scan (used by tests and the CLI)."""
        with self._lock:
            self._scan(list(roots))
            self._thumbnails()

    # -- internals ---------------------------------------------------------

    def _run_loop(self, roots):
        try:
            while True:
                self._rescan = False
                try:
                    self._scan(roots)
                    self._thumbnails()
                except Exception as exc:  # keep the server alive whatever happens
                    self.status["error"] = str(exc)
                if not self._rescan:
                    break
                roots = self.db.get_setting("roots", roots)
        finally:
            self.status.update(running=False, phase="idle", finished_at=time.time())
            self._lock.release()

    def _scan(self, roots):
        st = self.status
        st.update(running=True, phase="scanning", found=0, added=0, moved=0, missing=0,
                  thumbs_done=0, thumbs_total=0, error=None)
        existing = {
            r["path_key"]: dict(r)
            for r in self.db.query("SELECT id, path_key, size, mtime, missing FROM media")
        }
        seen, new_files, changed, revived = set(), [], [], []

        for root in roots:
            root_abs = os.path.abspath(root)
            if not os.path.isdir(root_abs):
                continue
            for path, kind, stat in walk_media(root_abs):
                key = norm_path(path)
                if key in seen:  # overlapping roots
                    continue
                seen.add(key)
                st["found"] += 1
                row = existing.get(key)
                info = {"path": path, "key": key, "root": root_abs, "kind": kind,
                        "size": stat.st_size, "mtime": stat.st_mtime}
                if row is None:
                    new_files.append(info)
                elif row["size"] != stat.st_size or abs(row["mtime"] - stat.st_mtime) > 1:
                    info["id"] = row["id"]
                    changed.append(info)
                elif row["missing"]:
                    revived.append(row["id"])

        # Rows whose file is gone are candidates for "moved" detection.
        gone = [r for k, r in existing.items() if k not in seen]
        gone_ids = [r["id"] for r in gone]
        by_fp = {}
        if gone_ids:
            for chunk in _chunks(gone_ids, 500):
                marks = ",".join("?" * len(chunk))
                for r in self.db.query(
                    f"SELECT id, fingerprint FROM media WHERE id IN ({marks}) AND fingerprint IS NOT NULL",
                    chunk,
                ):
                    by_fp.setdefault(r["fingerprint"], []).append(r["id"])

        st["phase"] = "indexing"
        for f in new_files + changed:  # hash outside the transaction so the UI stays responsive
            f["fp"] = _safe_fp(f)
        now = time.time()
        relinked = set()
        with self.db.tx() as c:
            if revived:
                c.executemany("UPDATE media SET missing = 0 WHERE id = ?", [(i,) for i in revived])
            for f in changed:
                c.execute(
                    "UPDATE media SET size = ?, mtime = ?, fingerprint = ?, missing = 0, "
                    "thumb_state = 'pending', duration = NULL, width = NULL, height = NULL WHERE id = ?",
                    (f["size"], f["mtime"], f["fp"], f["id"]),
                )
            for f in new_files:
                fp = f["fp"]
                rel = os.path.relpath(f["path"], f["root"])
                name = os.path.basename(f["path"])
                ext = os.path.splitext(name)[1].lower()
                old_ids = by_fp.get(fp) if fp else None
                old_id = next((i for i in old_ids or [] if i not in relinked), None)
                if old_id is not None:
                    relinked.add(old_id)
                    c.execute(
                        "UPDATE media SET path = ?, path_key = ?, root = ?, rel_path = ?, filename = ?, "
                        "ext = ?, kind = ?, size = ?, mtime = ?, missing = 0 WHERE id = ?",
                        (f["path"], f["key"], f["root"], rel, name, ext, f["kind"], f["size"],
                         f["mtime"], old_id),
                    )
                    st["moved"] += 1
                else:
                    c.execute(
                        "INSERT INTO media(path, path_key, root, rel_path, filename, ext, kind, size, "
                        "mtime, fingerprint, added_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (f["path"], f["key"], f["root"], rel, name, ext, f["kind"], f["size"],
                         f["mtime"], fp, now),
                    )
                    st["added"] += 1
            still_gone = [i for i in gone_ids if i not in relinked]
            c.executemany("UPDATE media SET missing = 1 WHERE id = ?", [(i,) for i in still_gone])
            st["missing"] = len(still_gone)

    def _thumbnails(self):
        st = self.status
        rows = [
            dict(r) for r in self.db.query(
                "SELECT id, path, kind FROM media WHERE missing = 0 AND thumb_state = 'pending' "
                "ORDER BY kind DESC, mtime DESC"
            )
        ]
        st.update(phase="thumbnails", thumbs_total=len(rows), thumbs_done=0)

        def work(item):
            ok, meta = make_thumb(item, self.thumbs_dir)
            self.db.set_thumb_result(item["id"], ok, meta)
            st["thumbs_done"] += 1

        if rows:
            with ThreadPoolExecutor(max_workers=self.workers) as pool:
                list(pool.map(work, rows))


def _safe_fp(f):
    try:
        return fingerprint(f["path"], f["size"])
    except OSError:
        return None


def _chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]
