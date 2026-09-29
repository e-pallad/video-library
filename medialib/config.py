"""Paths, supported extensions and app-wide constants."""

import os
import sys
from pathlib import Path

VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi", ".wmv", ".flv", ".ogv", ".mpg", ".mpeg", ".3gp"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif", ".tif", ".tiff"}

THUMB_WIDTH = 480


def default_data_dir() -> Path:
    """Where the database and thumbnail cache live (never inside the media folder)."""
    env = os.environ.get("MEDIALIB_DATA")
    if env:
        return Path(env)
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "medialib"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "medialib"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "medialib"


def kind_for(ext: str):
    ext = ext.lower()
    if ext in VIDEO_EXTS:
        return "video"
    if ext in IMAGE_EXTS:
        return "image"
    return None


def norm_path(p) -> str:
    """Absolute, normalized path used as the unique key in the database."""
    return os.path.normcase(os.path.abspath(os.fspath(p)))
