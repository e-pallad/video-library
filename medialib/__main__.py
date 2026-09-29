"""Command line entry point: ``python -m medialib --library "D:\\Videos"``."""

import argparse
import os
import sys
import threading
import webbrowser

import uvicorn

from .config import default_data_dir
from .db import Database
from .server import create_app


def main(argv=None):
    ap = argparse.ArgumentParser(prog="medialib", description="Local video & image library")
    ap.add_argument("-l", "--library", action="append", metavar="FOLDER",
                    help="folder to scan (repeatable). Saved, so later runs don't need it.")
    ap.add_argument("--data-dir", default=None,
                    help=f"where the database and thumbnails are stored (default: {default_data_dir()})")
    ap.add_argument("--host", default="127.0.0.1",
                    help="address to bind (default 127.0.0.1; use 0.0.0.0 to allow other devices)")
    ap.add_argument("-p", "--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    args = ap.parse_args(argv)

    data_dir = args.data_dir or default_data_dir()
    if args.library:
        roots = []
        for folder in args.library:
            folder = os.path.abspath(os.path.expanduser(folder))
            if not os.path.isdir(folder):
                ap.error(f"folder not found: {folder}")
            roots.append(folder)
        db = Database(os.path.join(data_dir, "library.db"))
        db.set_setting("roots", list(dict.fromkeys(roots)))
        db.close()

    app = create_app(data_dir, allow_remote=args.host not in ("127.0.0.1", "localhost", "::1"))
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}/"
    print(f"Media Library running at {url}  (data: {data_dir})  — press Ctrl+C to stop")
    if not args.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
