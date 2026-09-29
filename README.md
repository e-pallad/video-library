# Media Library

A local, YouTube-style library for your own video and image files. Point it at a folder: it scans
all sub-folders, builds thumbnails, and lets you **tag** everything. Tags are reusable, are saved
between restarts, and power the search.

Everything runs on your computer. Nothing is uploaded, and your files are never moved or modified.

## Features

- **Library grid.** Videos and images are shown together with thumbnails, durations and a watched-progress bar. Hovering over a video plays a preview. The grid loads more as you scroll, and you can sort by date, name, length, size, views or shuffle.
- **Video player.** It plays MKV, AVI, HEVC and other formats by converting them on the fly (see *Supported formats*). A YouTube-style watch page with:
  - custom controls: seek bar with time preview, volume, speed 0.25–2×, loop, theater mode, fullscreen, picture-in-picture,
  - an autoplay-next toggle and an "Up next" list,
  - audio-track selection and subtitles (embedded or `.srt`/`.ass` files next to the video),
  - **resume** from where you stopped.
- **Image gallery.** A justified grid like Google Photos, with a size slider. It opens a fullscreen **lightbox** with:
  - prev/next (keys, buttons or swipe),
  - zoom and pan (mouse wheel, double-click, drag),
  - a slideshow with an adjustable interval,
  - a thumbnail filmstrip,
  - an info panel where you can tag without leaving the viewer.
- **Tags.**
  - **Adding tags:** autocomplete reuses existing tags (case-insensitive), and new tags are created as you type.
  - **Bulk tagging:** press *Select*, click items (Shift-click selects a range), then add or remove a tag.
  - **Tag manager:** rename, merge (rename onto an existing name), recolour, delete.
  - **Tag sidebar:** click a tag to filter; right-click to exclude it.
- **Search.** Combine tags and text. See below.
- **Rescans keep your tags.** A file that is renamed or moved inside your library keeps its tags. Its identity comes from its size plus a hash of its content, not its path. A deleted file is hidden, but its tags come back if the file returns.
- Dark and light themes, keyboard shortcuts, and a layout that works on a phone.

## Install & run (Windows)

1. Install **Python 3.10+** from <https://www.python.org/downloads/>. Tick *"Add python.exe to PATH"*.
2. Download or clone this folder.
3. Double-click **`run.bat`**, or run from a terminal:

   ```bat
   run.bat "D:\Videos"
   ```

   The first run creates a virtual environment and installs the dependencies, which takes about a minute.
   Your browser opens at <http://127.0.0.1:8000>.

You only need the folder argument once, because it is remembered. You can also add or remove folders
later in **Library folders** in the sidebar, or use several folders.

**You do not need to install ffmpeg.** Video thumbnails and durations come from the ffmpeg binary
bundled with the `imageio-ffmpeg` pip package. If it ever fails, the browser captures the thumbnail itself.

### macOS / Linux

```sh
./run.sh ~/Videos
```

### Manual

```sh
pip install -r requirements.txt
python -m medialib --library "D:\Videos" [--library "E:\Photos"] [--port 8000] [--no-browser]
```

Other options: `--data-dir PATH` changes where the database is stored. `--host 0.0.0.0` lets other
devices on your network use it. Only do that on a network you trust, because there is no login.

## Searching

Type in the search bar. All terms must match.

| You type | Finds |
|---|---|
| `beach` | Names, folder paths or tags containing "beach" |
| `#cats` or `tag:cats` | Items tagged **cats** |
| `#cats #outdoor` | Items tagged **cats AND outdoor** |
| `#cats -#blurry` | Tagged cats but **not** blurry |
| `tag:"road trip"` | Tags that contain spaces |
| `-draft` | Hides anything whose name, folder or tags contain "draft" |
| `type:video` / `type:image` | Only videos or only images |

When you type `#`, matching tags are suggested. Picking one turns it into a chip. Click a chip to
switch between include and exclude. You can also click any tag chip on a card, the tag pills above
the grid, or a tag in the sidebar.

## Keyboard shortcuts

| Key | Video player | Image lightbox |
|---|---|---|
| `Space` / `K` | Play / pause | Slideshow (also `S`) |
| `←` / `→` | Seek 5 s | Previous / next |
| `J` / `L` | Seek 10 s | |
| `↑` / `↓` | Volume | |
| `0`–`9` | Jump to 0–90 % | `0` resets zoom |
| `+` / `-` | | Zoom |
| `M` | Mute | |
| `C` | Subtitles on/off | |
| `F` | Fullscreen | Fullscreen |
| `T` | Theater mode | Add a tag |
| `I` | Picture-in-picture | Info panel |
| `<` / `>` | Speed | |
| `Shift+N` / `Shift+P` | Next / previous video | |
| `G` | Add a tag | |
| `/` | Focus search | |
| `Esc` | | Close |

## Supported formats

- **Videos:** mp4, m4v, webm, mov, **mkv**, avi, wmv, flv, ogv, mpg/mpeg, 3gp
- **Images:** jpg, png, gif, webp, bmp, avif, tiff

**Every video plays in the built-in player, including MKV, AVI, WMV, HEVC/H.265, 10-bit H.264, and AC-3/DTS audio.**
When the library scans a video, it records the video's codecs, and each one is played in one of three ways:

| Playback | When | What happens |
|---|---|---|
| **Native** | MP4/WebM/MOV with H.264, VP9 or AV1 video and AAC/MP3/Opus audio | The file is streamed as-is |
| **Repackaged** | e.g. MKV with H.264/VP9/AV1 video, or any file with AC-3/DTS/FLAC audio | The video is copied into MP4 on the fly (no quality loss, almost no CPU); only the audio is converted when needed |
| **Converted** | HEVC/H.265, 10-bit H.264, MPEG-2/4, WMV, DivX/Xvid, … | The video is re-encoded to H.264 on the fly (uses CPU; capped at 1080p) |

Seeking, resume and playback speed work for all three. If a file still won't play (for example a damaged file),
an **Open in default player** button opens it in e.g. VLC.

MKV extras:
- **Multiple audio tracks:** use the 🎧 button in the player. Your chosen language is remembered.
- **Subtitles:** use the CC button, or press `C`. The player shows:
  - text subtitles embedded in the file (SRT, ASS/SSA, WebVTT, MP4 text),
  - subtitle files next to the video with the same name: `Movie.srt`, `Movie.en.srt`, `Movie.German.ass`, `.vtt`.

  Old non-UTF-8 `.srt` files are converted automatically. Image-based subtitles (Blu-ray PGS, DVD) can't be shown.

## Where your data lives

Tags, settings, the watch history and the thumbnail cache are stored outside your media folders:

- Windows: `%APPDATA%\medialib\` (`library.db` + `thumbs\`)
- macOS: `~/Library/Application Support/medialib/`
- Linux: `~/.local/share/medialib/`

To back up your tags, copy `library.db`. It is a normal SQLite database.

## Development

```sh
pip install -r requirements.txt
python -m pytest
```

Layout:
- `medialib/server.py`: FastAPI routes
- `medialib/db.py`: SQLite schema and queries
- `medialib/search.py`: query parser → SQL
- `medialib/scanner.py`: folder scanning and move detection
- `medialib/thumbs.py`: thumbnails and metadata
- `medialib/playback.py`: codec probing, direct/remux/transcode decisions, streaming, subtitles
- `medialib/static/`: the frontend (plain ES modules, no build step)
