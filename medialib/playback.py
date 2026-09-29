"""Making every video playable in the browser.

Browsers only decode a few codecs (H.264, VP8/VP9, AV1 video; AAC, MP3, Opus,
Vorbis, FLAC audio) in a few containers (MP4, WebM). Everything else, such as
MKV, AVI, WMV, HEVC, AC-3/DTS audio or 10-bit H.264, is converted on the fly by
ffmpeg into a fragmented MP4 stream:

* ``direct``    the file is served as-is (HTTP range requests, native seeking)
* ``remux``     the video stream is copied into MP4 without re-encoding (cheap);
                audio is converted to AAC only when necessary
* ``transcode`` the video is re-encoded to H.264 (CPU heavy, but plays anywhere)

Streams can't be byte-range seeked, so the player seeks by restarting the stream
at a timestamp (``?t=``). For ``remux`` the stream must start on a keyframe, so
:func:`keyframe_before` finds the exact start time first; that keeps audio and
video in sync and the displayed time accurate.
"""

import json
import os
import re
import threading
from pathlib import Path

from .ffmpeg import ffmpeg_exe, popen, run

DIRECT_CONTAINERS = {".mp4", ".m4v", ".webm", ".mov", ".ogv"}
BROWSER_VIDEO = {"h264", "vp8", "vp9", "av1", "theora"}
BROWSER_AUDIO = {"aac", "mp3", "opus", "vorbis", "flac"}
COPY_VIDEO = {"h264", "vp9", "av1"}   # can be copied into fragmented MP4 as-is
COPY_AUDIO = {"aac", "mp3", "opus"}   # can be copied into fragmented MP4 as-is
TEXT_SUBS = {"subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "microdvd", "subviewer", "jacosub", "sami", "realtext"}
SIDECAR_SUB_EXTS = {".srt", ".vtt", ".ass", ".ssa", ".sub"}

_DURATION = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)(?:,\s*start:\s*(-?\d+(?:\.\d+)?))?")
_STREAM = re.compile(
    r"^\s*Stream #\d+:(\d+)(?:\[0x[0-9a-fA-F]+\])?(?:\((\w+)\))?(?:\[0x[0-9a-fA-F]+\])?: "
    r"(Video|Audio|Subtitle|Attachment|Data): ([^\s,]+)(.*)$"
)
_META_TITLE = re.compile(r"^\s+title\s*:\s*(.+)$")
_DIMS = re.compile(r"\b(\d{2,5})x(\d{2,5})\b")
_ROTATE = re.compile(r"rotate\s*:\s*(-?\d+)|rotation of (-?\d+(?:\.\d+)?) degrees")
_TEN_BIT = re.compile(r"p1[0-6](?:le|be)\b")
_CHANNELS = re.compile(r"\b(mono|stereo|[1-9]\.[0-9](?:\(\w+\))?|\d+ channels)\b")


# ---------------------------------------------------------------------------
# Probing

def parse_probe(text):
    """Parse ``ffmpeg -i`` stream information into a dict."""
    info = {"duration": None, "start": 0.0, "width": None, "height": None, "video_codec": None,
            "ten_bit": False, "audio": [], "subtitles": []}
    m = _DURATION.search(text)
    if m:
        h, mi, s, start = m.groups()
        info["duration"] = int(h) * 3600 + int(mi) * 60 + float(s)
        info["start"] = float(start) if start else 0.0

    counts = {"Audio": 0, "Subtitle": 0}
    current = None
    video_seen = False
    for line in text.splitlines():
        sm = _STREAM.match(line)
        if sm:
            _, lang, kind, codec, rest = sm.groups()
            codec = codec.lower()
            current = None
            if kind == "Video" and not video_seen and "attached pic" not in rest:
                video_seen = True
                info["video_codec"] = codec
                info["ten_bit"] = bool(_TEN_BIT.search(rest))
                d = _DIMS.search(rest)
                if d:
                    info["width"], info["height"] = int(d.group(1)), int(d.group(2))
                current = info
            elif kind == "Audio":
                ch = _CHANNELS.search(rest)
                current = {"index": counts["Audio"], "codec": codec, "lang": _lang(lang),
                           "channels": ch.group(1) if ch else None, "title": None,
                           "default": "(default)" in rest}
                info["audio"].append(current)
                counts["Audio"] += 1
            elif kind == "Subtitle":
                current = {"index": counts["Subtitle"], "codec": codec, "lang": _lang(lang), "title": None,
                           "default": "(default)" in rest, "forced": "(forced)" in rest,
                           "text": codec in TEXT_SUBS}
                info["subtitles"].append(current)
                counts["Subtitle"] += 1
            continue
        if current is not None:
            tm = _META_TITLE.match(line)
            if tm and current is not info and not current["title"]:
                current["title"] = tm.group(1).strip()
            rm = _ROTATE.search(line)
            if rm and current is info and info.get("width"):
                angle = abs(float(rm.group(1) or rm.group(2)))
                if round(angle) % 180 == 90:
                    info["width"], info["height"] = info["height"], info["width"]
                current = None  # only rotate once
    return info


def _lang(code):
    return None if not code or code in ("und", "unk", "zxx") else code


def probe(path):
    exe = ffmpeg_exe()
    if not exe:
        return None
    try:
        res = run([exe, "-hide_banner", "-i", str(path)], timeout=30)
    except Exception:
        return None
    info = parse_probe(res.stderr.decode("utf-8", "replace"))
    if info["duration"] is None and info["video_codec"] is None:
        return None
    return info


# ---------------------------------------------------------------------------
# Playback decisions

def first_audio_codec(info):
    return info["audio"][0]["codec"] if info and info.get("audio") else None


def can_copy_video(info):
    v = info.get("video_codec")
    return v in COPY_VIDEO and not (v == "h264" and info.get("ten_bit"))


def playback_mode(ext, info):
    """'direct', 'remux' or 'transcode' for a video with the given probe info."""
    ext = (ext or "").lower()
    if not info or not info.get("video_codec"):
        # Not probed (yet): trust the container.
        return "direct" if ext in DIRECT_CONTAINERS else "transcode"
    v = info["video_codec"]
    a = first_audio_codec(info)
    video_ok = v in BROWSER_VIDEO and not (v == "h264" and info.get("ten_bit"))
    audio_ok = a is None or a in BROWSER_AUDIO
    if ext in DIRECT_CONTAINERS and video_ok and audio_ok:
        return "direct"
    return "remux" if can_copy_video(info) else "transcode"


def stream_mode(info, force_transcode=False):
    if force_transcode or not info or not can_copy_video(info):
        return "transcode"
    return "remux"


def stream_command(path, info, start=0.0, audio_index=0, force_transcode=False):
    exe = ffmpeg_exe()
    mode = stream_mode(info, force_transcode)
    audio = (info or {}).get("audio") or []
    audio_index = audio_index if 0 <= audio_index < len(audio) else 0
    a_codec = audio[audio_index]["codec"] if audio else None

    cmd = [exe, "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start and start > 0:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", str(path), "-map", "0:v:0", "-map", f"0:a:{audio_index}?",
            "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1"]
    if mode == "remux":
        cmd += ["-c:v", "copy"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
                "-profile:v", "high", "-g", "48", "-sc_threshold", "0",
                "-vf", "scale=-2:'trunc(min(1080,ih)/2)*2'"]
    # Copied audio only lines up with copied video (both start on the same keyframe); when the
    # video is re-encoded from an exact timestamp the audio must be re-encoded too.
    if mode == "remux" and a_codec in COPY_AUDIO:
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", "aac", "-b:a", "192k", "-ac", "2"]
    cmd += ["-avoid_negative_ts", "make_zero",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-f", "mp4", "pipe:1"]
    return cmd, mode


def keyframe_before(path, t, info):
    """Timestamp of the keyframe a stream-copy seek to ``t`` will actually start at."""
    if t <= 0:
        return 0.0
    exe = ffmpeg_exe()
    cmd = [exe, "-hide_banner", "-loglevel", "error", "-copyts", "-ss", f"{t:.3f}", "-i", str(path),
           "-map", "0:v:0", "-c", "copy", "-frames:v", "1", "-f", "framecrc", "-"]
    try:
        out = run(cmd, timeout=20).stdout.decode("utf-8", "replace")
    except Exception:
        return t
    tb = None
    for line in out.splitlines():
        if line.startswith("#tb 0:"):
            num, den = line.split(":", 1)[1].strip().split("/")
            tb = int(num) / int(den)
        elif tb and line and not line.startswith("#"):
            parts = [p.strip() for p in line.split(",")]
            try:
                pts = int(parts[2])  # stream, dts, pts, ...
            except (IndexError, ValueError):
                break
            k = pts * tb - (info.get("start") or 0.0)
            return max(0.0, min(t, k))
    return t


# ---------------------------------------------------------------------------
# Running streams

class StreamRegistry:
    """Keeps track of running ffmpeg processes so seeking kills the old stream."""

    def __init__(self):
        self._lock = threading.Lock()
        self._procs = {}

    def start(self, key, cmd):
        proc = popen(cmd)
        with self._lock:
            old = self._procs.pop(key, [])
            self._procs[key] = [proc]
        for p in old:
            _kill(p)
        return proc

    def finish(self, key, proc):
        _kill(proc)
        with self._lock:
            procs = self._procs.get(key)
            if procs and proc in procs:
                procs.remove(proc)
                if not procs:
                    self._procs.pop(key, None)

    def stop(self, key):
        with self._lock:
            procs = self._procs.pop(key, [])
        for p in procs:
            _kill(p)

    def stop_all(self):
        with self._lock:
            procs = [p for ps in self._procs.values() for p in ps]
            self._procs.clear()
        for p in procs:
            _kill(p)


def _kill(proc):
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Subtitles

def sidecar_subtitles(video_path):
    """External subtitle files next to the video: ``movie.srt``, ``movie.en.srt``, ``movie.English.forced.ass``."""
    folder, name = os.path.split(video_path)
    stem = os.path.splitext(name)[0]
    out = []
    try:
        entries = sorted(os.listdir(folder or "."))
    except OSError:
        return out
    for entry in entries:
        base, ext = os.path.splitext(entry)
        if ext.lower() not in SIDECAR_SUB_EXTS or not base.lower().startswith(stem.lower()):
            continue
        suffix = base[len(stem):]
        if suffix and suffix[0] not in "._- ":
            continue  # "movie2.srt" belongs to "movie2", not "movie"
        label = suffix.strip("._- ") or None
        out.append({"file": os.path.join(folder, entry), "label": label, "codec": ext.lower().lstrip(".")})
    return out


def subtitle_tracks(media_id, path, info):
    tracks = []
    for s in (info or {}).get("subtitles", []):
        if not s.get("text"):
            continue  # image-based (PGS / DVD) subtitles can't be converted to text
        label = s.get("title") or _lang_name(s.get("lang")) or f"Track {s['index'] + 1}"
        if s.get("forced") and "forced" not in label.lower():
            label += " (forced)"
        tracks.append({"key": f"e{s['index']}", "label": label, "lang": s.get("lang"),
                       "default": s.get("default", False), "url": f"/api/media/{media_id}/subtitles/e{s['index']}.vtt"})
    for i, s in enumerate(sidecar_subtitles(path)):
        label = _lang_name(s["label"]) or s["label"] or "External"
        tracks.append({"key": f"s{i}", "label": f"{label} ({s['codec'].upper()})", "lang": s["label"],
                       "default": False, "url": f"/api/media/{media_id}/subtitles/s{i}.vtt"})
    return tracks


def extract_subtitle(path, key, info, out_path):
    """Convert an embedded (``eN``) or sidecar (``sN``) subtitle to WebVTT. Returns True on success."""
    exe = ffmpeg_exe()
    if not exe:
        return False
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".tmp.vtt")
    idx = int(key[1:])
    if key.startswith("e"):
        src = ["-i", str(path), "-map", f"0:s:{idx}"]
    else:
        sidecars = sidecar_subtitles(path)
        if idx >= len(sidecars):
            return False
        # Re-encode the file as UTF-8 first: old .srt files are often Windows-1252, and ffmpeg
        # silently drops lines that aren't valid UTF-8.
        utf8 = out_path.with_suffix(".src" + Path(sidecars[idx]["file"]).suffix.lower())
        try:
            utf8.write_text(_decode_text(Path(sidecars[idx]["file"]).read_bytes()), encoding="utf-8")
        except OSError:
            return False
        src = ["-i", str(utf8)]
    try:
        res = run([exe, "-hide_banner", "-loglevel", "error", "-y", *src, "-f", "webvtt", str(tmp)], timeout=300)
    except Exception:
        res = None
    finally:
        if key.startswith("s"):
            Path(src[1]).unlink(missing_ok=True)
    if res is not None and res.returncode == 0 and tmp.exists() and tmp.stat().st_size > 0:
        tmp.replace(out_path)
        return True
    tmp.unlink(missing_ok=True)
    return False


def _decode_text(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


_LANGS = {
    "eng": "English", "en": "English", "ger": "German", "deu": "German", "de": "German", "fre": "French",
    "fra": "French", "fr": "French", "spa": "Spanish", "es": "Spanish", "ita": "Italian", "it": "Italian",
    "jpn": "Japanese", "ja": "Japanese", "por": "Portuguese", "pt": "Portuguese", "rus": "Russian",
    "ru": "Russian", "chi": "Chinese", "zho": "Chinese", "zh": "Chinese", "kor": "Korean", "ko": "Korean",
    "dut": "Dutch", "nld": "Dutch", "nl": "Dutch", "pol": "Polish", "pl": "Polish", "swe": "Swedish",
    "sv": "Swedish", "nor": "Norwegian", "no": "Norwegian", "dan": "Danish", "da": "Danish", "fin": "Finnish",
    "fi": "Finnish", "tur": "Turkish", "tr": "Turkish", "ara": "Arabic", "ar": "Arabic", "hin": "Hindi",
    "hi": "Hindi", "cze": "Czech", "ces": "Czech", "cs": "Czech", "hun": "Hungarian", "hu": "Hungarian",
    "gre": "Greek", "ell": "Greek", "el": "Greek", "heb": "Hebrew", "he": "Hebrew", "ukr": "Ukrainian", "uk": "Ukrainian",
}


def _lang_name(code):
    if not code:
        return None
    return _LANGS.get(code.lower().split(".")[0])


def audio_tracks(info):
    tracks = []
    for a in (info or {}).get("audio", []):
        parts = [a.get("title") or _lang_name(a.get("lang")) or f"Track {a['index'] + 1}"]
        detail = " ".join(x for x in (a.get("codec", "").upper(), a.get("channels")) if x)
        if detail:
            parts.append(detail)
        tracks.append({"index": a["index"], "label": " · ".join(parts), "lang": a.get("lang"), "default": a.get("default", False)})
    return tracks


def dumps(info):
    return json.dumps(info, separators=(",", ":")) if info else None


def loads(text):
    try:
        return json.loads(text) if text else None
    except ValueError:
        return None
