import subprocess

import pytest

from medialib import playback
from medialib.ffmpeg import ffmpeg_exe

SAMPLE = """Input #0, matroska,webm, from 'x.mkv':
  Duration: 01:02:03.50, start: 1.400000, bitrate: 5000 kb/s
  Stream #0:0(eng): Video: hevc (Main 10), yuv420p10le(tv), 1920x1080 [SAR 1:1 DAR 16:9], 23.98 fps (default)
  Stream #0:1(jpn): Audio: flac, 48000 Hz, stereo, s16 (default)
    Metadata:
      title           : Japanese
  Stream #0:2(eng): Audio: ac3, 48000 Hz, 5.1(side), fltp, 640 kb/s
  Stream #0:3(eng): Subtitle: ass (default)
    Metadata:
      title           : Full Subs
  Stream #0:4(ger): Subtitle: hdmv_pgs_subtitle (forced)
  Stream #0:5: Video: mjpeg (Baseline), yuvj420p, 600x882, 90k tbr (attached pic)
"""


def test_parse_probe():
    info = playback.parse_probe(SAMPLE)
    assert info["duration"] == pytest.approx(3723.5)
    assert info["start"] == 1.4
    assert (info["video_codec"], info["ten_bit"], info["width"], info["height"]) == ("hevc", True, 1920, 1080)
    assert [(a["codec"], a["lang"], a["title"], a["channels"]) for a in info["audio"]] == [
        ("flac", "jpn", "Japanese", "stereo"), ("ac3", "eng", None, "5.1")]
    assert [(s["codec"], s["text"], s["title"], s["forced"]) for s in info["subtitles"]] == [
        ("ass", True, "Full Subs", False), ("hdmv_pgs_subtitle", False, None, True)]


@pytest.mark.parametrize("ext,video,ten_bit,audio,expected", [
    (".mp4", "h264", False, "aac", "direct"),
    (".webm", "vp9", False, "opus", "direct"),
    (".mp4", "h264", False, "ac3", "remux"),       # browsers can't decode AC-3 -> convert audio only
    (".mkv", "h264", False, "aac", "remux"),
    (".mkv", "vp9", False, "opus", "remux"),
    (".mkv", "hevc", False, "aac", "transcode"),
    (".mp4", "hevc", False, "aac", "transcode"),
    (".mkv", "h264", True, "aac", "transcode"),    # 10-bit H.264 isn't decodable in browsers
    (".avi", "mpeg4", False, "mp3", "transcode"),
    (".wmv", "wmv3", False, "wmav2", "transcode"),
])
def test_playback_mode(ext, video, ten_bit, audio, expected):
    info = {"video_codec": video, "ten_bit": ten_bit, "audio": [{"codec": audio}]}
    assert playback.playback_mode(ext, info) == expected


def test_unprobed_files_fall_back_to_container():
    assert playback.playback_mode(".mp4", None) == "direct"
    assert playback.playback_mode(".mkv", None) == "transcode"


def test_stream_command_modes():
    info = {"video_codec": "h264", "ten_bit": False, "audio": [{"codec": "aac"}, {"codec": "dts"}]}
    cmd, mode = playback.stream_command("in.mkv", info, start=10, audio_index=0)
    assert mode == "remux" and cmd[cmd.index("-c:v") + 1] == "copy" and cmd[cmd.index("-c:a") + 1] == "copy"
    cmd, _ = playback.stream_command("in.mkv", info, audio_index=1)
    assert "0:a:1?" in cmd and cmd[cmd.index("-c:a") + 1] == "aac"
    cmd, mode = playback.stream_command("in.mkv", info, start=5, force_transcode=True)
    assert mode == "transcode" and cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-c:a") + 1] == "aac"  # never copy audio next to re-encoded video (A/V sync)


def test_sidecar_subtitles(tmp_path):
    for name in ("Movie.mkv", "Movie.srt", "Movie.en.srt", "Movie.German.forced.ass", "Movie2.srt", "Other.srt"):
        (tmp_path / name).write_text("x")
    found = playback.sidecar_subtitles(str(tmp_path / "Movie.mkv"))
    assert sorted(s["label"] or "" for s in found) == ["", "German.forced", "en"]


def _ff(*args):
    exe = ffmpeg_exe()
    if not exe:
        pytest.skip("ffmpeg not available")
    subprocess.run([exe, "-y", "-loglevel", "error", *args], check=True)


def test_keyframe_and_subtitle_extraction(tmp_path):
    srt = tmp_path / "s.srt"
    srt.write_text("1\n00:00:01,000 --> 00:00:02,000\nHello\n", encoding="utf-8")
    mkv = tmp_path / "v.mkv"
    _ff("-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=12", "-i", str(srt),
        "-map", "0:v", "-map", "1:s", "-c:v", "libx264", "-g", "50", "-pix_fmt", "yuv420p", "-c:s", "srt", str(mkv))
    info = playback.probe(mkv)
    assert playback.playback_mode(".mkv", info) == "remux"
    assert playback.keyframe_before(mkv, 7.3, info) == pytest.approx(5.0, abs=0.05)
    out = tmp_path / "e0.vtt"
    assert playback.extract_subtitle(mkv, "e0", info, out)
    assert "Hello" in out.read_text()

    # A non-UTF-8 sidecar file keeps its accented lines.
    (tmp_path / "v.de.srt").write_bytes("1\n00:00:01,000 --> 00:00:02,000\nGrüße\n".encode("cp1252"))
    out = tmp_path / "s0.vtt"
    assert playback.extract_subtitle(mkv, "s0", info, out)
    assert "Grüße" in out.read_text(encoding="utf-8")
