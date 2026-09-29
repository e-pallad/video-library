import subprocess

import pytest
from PIL import Image

from medialib.thumbs import ffmpeg_exe


def make_image(path, size=(64, 48), color=(200, 30, 30)):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(path)
    return path


def make_video(path, seconds=2):
    exe = ffmpeg_exe()
    if not exe:
        pytest.skip("ffmpeg not available")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [exe, "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size=160x90:rate=10:duration={seconds}",
         "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path


@pytest.fixture
def library(tmp_path):
    root = tmp_path / "media"
    make_image(root / "holiday" / "beach.jpg", (80, 40))
    make_image(root / "holiday" / "sunset.png", (40, 80), (250, 150, 0))
    make_image(root / "cat.webp")
    (root / "notes.txt").write_text("not media")
    (root / ".hidden").mkdir(parents=True)
    make_image(root / ".hidden" / "secret.jpg")
    return root
