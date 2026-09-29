"""Thumbnail generation and media metadata.

Images are handled by Pillow. Videos use the ffmpeg binary that ships with the
``imageio-ffmpeg`` pip package, so nothing has to be installed separately on
Windows. If ffmpeg is unavailable the frontend grabs a frame itself and uploads
it (see ``POST /api/media/{id}/thumb``).
"""

import io
from pathlib import Path

from PIL import Image, ImageOps

from .config import THUMB_WIDTH
from .ffmpeg import ffmpeg_exe, run as _run
from .playback import probe

Image.MAX_IMAGE_PIXELS = 400_000_000  # allow large photos/panoramas


def video_thumb(path, out_path, duration=None):
    """Grab a representative frame (10% in) and save it as a JPEG. Returns True on success."""
    exe = ffmpeg_exe()
    if not exe:
        return False
    out_path = Path(out_path)
    tmp = out_path.with_suffix(".tmp.jpg")
    offsets = [min(duration * 0.1, 60.0)] if duration and duration > 1 else []
    offsets.append(0)
    for t in offsets:
        cmd = [
            exe, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{t:.2f}", "-i", str(path),
            "-frames:v", "1", "-vf", f"scale={THUMB_WIDTH}:-2", "-q:v", "4", str(tmp),
        ]
        try:
            _run(cmd, timeout=60)
        except Exception:
            continue
        if tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(out_path)
            return True
    tmp.unlink(missing_ok=True)
    return False


def _to_rgb(img):
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (24, 24, 24))
        bg.paste(img, mask=img.split()[-1])
        return bg
    return img.convert("RGB") if img.mode != "RGB" else img


def image_thumb(src, out_path):
    """Create a JPEG thumbnail from an image file (or file-like). Returns metadata dict."""
    with Image.open(src) as img:
        width, height = img.size
        if img.getexif().get(0x0112, 1) in (5, 6, 7, 8):  # rotated 90/270 degrees
            width, height = height, width
        img.draft("RGB", (THUMB_WIDTH * 2, THUMB_WIDTH * 2))  # fast JPEG downscale on decode
        img = _to_rgb(ImageOps.exif_transpose(img))
        img.thumbnail((THUMB_WIDTH, THUMB_WIDTH * 3), Image.LANCZOS)
        tmp = Path(out_path).with_suffix(".tmp.jpg")
        img.save(tmp, "JPEG", quality=82, optimize=True)
        tmp.replace(out_path)
    return {"width": width, "height": height}


def thumb_from_bytes(data: bytes, out_path):
    """Store a browser-captured frame (validated and re-encoded)."""
    return image_thumb(io.BytesIO(data), out_path)


def make_thumb(item, thumbs_dir):
    """Generate the thumbnail + metadata for a media row. Returns (ok, meta)."""
    out = Path(thumbs_dir) / f"{item['id']}.jpg"
    try:
        if item["kind"] == "image":
            return True, image_thumb(item["path"], out)
        info = probe(item["path"])
        meta = {"info": info}
        if info:
            meta.update(duration=info["duration"], width=info["width"], height=info["height"])
        ok = video_thumb(item["path"], out, meta.get("duration"))
        return ok, meta
    except Exception:
        return False, {}
