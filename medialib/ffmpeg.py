"""Locating and running the ffmpeg binary.

The ``imageio-ffmpeg`` pip package ships a static ffmpeg for Windows, macOS and
Linux, so users never have to install ffmpeg themselves. A system ffmpeg on the
PATH is used as a fallback.
"""

import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path

# Keep ffmpeg from flashing console windows on Windows.
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0


@lru_cache(maxsize=1)
def ffmpeg_exe():
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            return exe
    except Exception:
        pass
    return shutil.which("ffmpeg")


def run(cmd, timeout):
    return subprocess.run(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
        timeout=timeout, creationflags=NO_WINDOW,
    )


def popen(cmd):
    return subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
        creationflags=NO_WINDOW, bufsize=0,
    )
