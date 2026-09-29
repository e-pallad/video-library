"""Deleting media files: to the Recycle Bin / Trash, or permanently when asked."""

import ntpath
import os
import sys
import time

try:
    from send2trash import send2trash
except ImportError:  # without it files can only be deleted permanently
    send2trash = None


class TrashFailed(OSError):
    """The file could not be moved to the trash (deleting it permanently may still work)."""


def trash_name():
    """What the OS calls its trash, or None when files can't be moved there."""
    if send2trash is None:
        return None
    return "Recycle Bin" if sys.platform == "win32" else "Trash"


def delete_file(path, permanent=False, retries=2):
    """Move ``path`` to the trash, or delete it for good. A file that is already gone counts as deleted.

    Failures are retried briefly: right after the player stops, the file can still be open for a
    moment (a stream being shut down), and Windows can't delete open files.
    """
    if not permanent and send2trash is None:
        raise TrashFailed("the Recycle Bin/Trash can't be used (the send2trash package is not installed)")
    if not permanent and _on_network_drive(path):
        # Windows would silently delete the file for good instead of recycling it.
        raise TrashFailed("network drives have no Recycle Bin")
    for attempt in range(retries + 1):
        if not os.path.lexists(path):
            return
        try:
            if permanent:
                os.remove(path)
            else:
                send2trash(path)
            return
        except OSError as e:
            if not os.path.lexists(path):
                return
            if attempt == retries:
                if permanent:
                    raise
                raise TrashFailed(describe(e)) from e
            time.sleep(0.3 * (attempt + 1))


def _on_network_drive(path):
    """True for files on a Windows network share or mapped network drive."""
    if sys.platform != "win32":
        return False
    drive = ntpath.splitdrive(path)[0]
    if drive.startswith(("\\\\", "//")):  # \\server\share
        return True
    try:
        import ctypes
        return ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == 4  # DRIVE_REMOTE
    except (AttributeError, OSError, ValueError):
        return False


def describe(error):
    """Short human readable reason for an OSError."""
    return error.strerror or str(error) or type(error).__name__
