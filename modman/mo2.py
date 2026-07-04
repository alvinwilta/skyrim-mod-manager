"""Mod Organizer 2 interop.

MO2 tracks downloaded archives via <archive>.meta sidecar files (QSettings
ini). Writing them makes our downloads show up properly named in MO2's
Downloads tab; MO2 flips `installed=true` in the same file when the user
installs, which we read back to show install state in the library."""

import os

from .config import DOWNLOADS_DIR

# nexus domain -> MO2 gameName
GAME_NAMES = {
    "skyrimspecialedition": "SkyrimSE",
    "skyrim": "Skyrim",
    "fallout4": "Fallout4",
    "site": "SkyrimSE",  # tools; MO2 has no game for these, keep them visible
}


def meta_path(filename):
    return os.path.join(DOWNLOADS_DIR, filename + ".meta")


def write_meta(filename, meta):
    """Write an MO2 download meta for an archive. Never overwrites an existing
    meta — MO2 owns it after install (tracks installed/uninstalled there)."""
    path = meta_path(filename)
    if os.path.exists(path):
        return
    game = GAME_NAMES.get(meta.get("game") or "", "SkyrimSE")
    with open(path, "w") as f:
        f.write(
            "[General]\n"
            f"gameName={game}\n"
            f"modID={meta['mod_id']}\n"
            f"fileID={meta['file_id']}\n"
            "url=\n"
            f"name={meta['file_name']}\n"
            f"modName={meta['mod_name']}\n"
            f"version={meta['file_version']}\n"
            "newestVersion=\n"
            "category=0\n"
            "repository=Nexus\n"
            "installed=false\n"
            "uninstalled=false\n"
            "paused=false\n"
            "removed=false\n"
        )


def is_installed(filename):
    if not filename:
        return False
    path = meta_path(filename)
    if not os.path.isfile(path):
        return False
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                if line.strip().lower().startswith("installed="):
                    return line.split("=", 1)[1].strip().lower() == "true"
    except OSError:
        pass
    return False


def remove_meta(filename):
    path = meta_path(filename)
    if os.path.exists(path):
        os.remove(path)
