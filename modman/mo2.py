"""Mod Organizer 2 interop.

MO2 tracks downloaded archives via <archive>.meta sidecar files (QSettings
ini). Writing them makes our downloads show up properly named in MO2's
Downloads tab; MO2 flips `installed=true` in the same file when the user
installs, which we read back to show install state in the library."""

import os

from .config import DOWNLOADS_DIR, GAME

# nexus domain -> MO2 gameName
GAME_NAMES = {
    "skyrimspecialedition": "SkyrimSE",
    "skyrim": "Skyrim",
    "fallout4": "Fallout4",
    "site": "SkyrimSE",  # tools; MO2 has no game for these, keep them visible
}
# reverse, for reading an MO2-written .meta back into a nexus domain
DOMAIN_FOR_GAMENAME = {"SkyrimSE": "skyrimspecialedition", "Skyrim": "skyrim", "Fallout4": "fallout4"}


def meta_path(filename):
    return os.path.join(DOWNLOADS_DIR, filename + ".meta")


def _write_meta_ini(path, *, game_name, mod_id, file_id, name, mod_name,
                    version, repository, nexus_domain=None):
    """The one QSettings-ini template both writers share."""
    with open(path, "w") as f:
        f.write("[General]\n")
        f.write(f"gameName={game_name}\n")
        if nexus_domain:
            # our own extension (MO2 ignores unknown keys): preserves the exact
            # Nexus domain, which gameName alone can't round-trip -- `site`
            # tools map to gameName=SkyrimSE and would re-import as the wrong
            # domain (broken redownload) without this
            f.write(f"nexusDomain={nexus_domain}\n")
        f.write(
            f"modID={mod_id}\n"
            f"fileID={file_id}\n"
            "url=\n"
            f"name={name}\n"
            f"modName={mod_name}\n"
            f"version={version}\n"
            "newestVersion=\n"
            "category=0\n"
            f"repository={repository}\n"
            "installed=false\n"
            "uninstalled=false\n"
            "paused=false\n"
            "removed=false\n"
        )


def write_meta(filename, meta):
    """Write an MO2 download meta for an archive. Never overwrites an existing
    meta — MO2 owns it after install (tracks installed/uninstalled there)."""
    path = meta_path(filename)
    if os.path.exists(path):
        return
    _write_meta_ini(
        path,
        game_name=GAME_NAMES.get(meta.get("game") or "", "SkyrimSE"),
        mod_id=meta["mod_id"], file_id=meta["file_id"],
        name=meta["file_name"], mod_name=meta["mod_name"],
        version=meta["file_version"], repository="Nexus",
        nexus_domain=meta.get("game"),
    )


# meta path -> (mtime_ns, installed): /api/mods and load_order call
# is_installed once per row per request — without this that's one file open
# per mod every time. MO2 rewrites the .meta when install state changes, so
# mtime is an exact invalidation key. One entry per archive, stays small.
_installed_cache = {}


def is_installed(filename):
    if not filename:
        return False
    path = meta_path(filename)
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return False
    hit = _installed_cache.get(path)
    if hit is not None and hit[0] == mtime:
        return hit[1]
    installed = False
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                if line.strip().lower().startswith("installed="):
                    installed = line.split("=", 1)[1].strip().lower() == "true"
                    break
    except OSError:
        return False
    _installed_cache[path] = (mtime, installed)
    return installed


def remove_meta(filename):
    path = meta_path(filename)
    if os.path.exists(path):
        os.remove(path)


def read_meta(filename):
    """Parse an archive's `.meta` sidecar (MO2 QSettings ini) into a flat dict of
    lowercased keys, or None if there's no sidecar. Only the [General] section is
    read. Used to adopt files MO2 (or another manager) downloaded."""
    path = meta_path(filename)
    if not os.path.isfile(path):
        return None
    out = {}
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("[") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip().lower()] = v.strip()
    except OSError:
        return None
    return out


def nexus_identity(meta):
    """(domain, mod_id, file_id) if a .meta describes a real Nexus download,
    else None. Requires repository=Nexus and positive modID/fileID — a
    non-Nexus (other-site) or manual .meta has no trustworthy Nexus identity."""
    if not meta or (meta.get("repository") or "").lower() != "nexus":
        return None
    try:
        mod_id, file_id = int(meta.get("modid") or 0), int(meta.get("fileid") or 0)
    except ValueError:
        return None
    if mod_id <= 0 or file_id <= 0:
        return None
    # nexusDomain (ours, exact) beats the gameName reverse map (lossy: `site`
    # tools write gameName=SkyrimSE)
    domain = meta.get("nexusdomain") or DOMAIN_FOR_GAMENAME.get(meta.get("gamename") or "", GAME)
    return domain, mod_id, file_id


def write_local_meta(filename, mod_name):
    """Create a MINIMAL, truthful `.meta` for an orphan archive that has none.
    Nothing is inferred: only the filename, the given mod_name (its own basename)
    and the configured game. Never overwrites an existing sidecar (MO2 owns it).
    repository is left blank — we must not claim a Nexus origin we don't have."""
    path = meta_path(filename)
    if os.path.exists(path):
        return
    _write_meta_ini(
        path,
        game_name=GAME_NAMES.get(GAME, "SkyrimSE"),
        mod_id=0, file_id=0,
        name=filename, mod_name=mod_name,
        version="", repository="",
    )
