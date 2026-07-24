"""Read MO2's real install state from the active profile, for the pull/push
sync (modman/mo2_pull.py, modman/mo2_push.py):
- `config.modlist_path()` -- one line per MO2 mod, in reverse-priority order.
  `+Name` enabled, `-Name` disabled, `*Name` unmanaged (DLC/CC), names ending
  `_separator` are visual separators. The file lists highest-priority first
  (top of file = bottom of MO2's left panel), so the app's rank 0..N order
  (panel top->bottom) is the REVERSE of the enabled lines.
- `MODS_DIR/<FolderName>/meta.ini` -- MO2 writes `modid`/`fileid` here on a
  Nexus install, which the pull/push matcher joins back to our mod_id.

Everything here is read-only; nothing writes to MO2's tree.
"""

import os

from .config import MODS_DIR, modlist_path


def _read_folder_meta(folder):
    """Parse one installed mod folder's meta.ini into the identity signals we
    match on. Returns {'modid','fileid','installfile'} or None if unreadable.

    Nexus ids are read from BOTH `[General] modid` AND the `[installedFiles]`
    section (`N\\modid`, `N\\fileid`): MO2 leaves `[General] modid=0` for many
    installs but records the true ids under installedFiles, so reading only the
    former missed real Nexus mods. `installationFile` is the source archive
    name, which the tool stores as a row's filename/orig_filename."""
    path = os.path.join(MODS_DIR, folder, "meta.ini")
    modid = fileid = 0
    installfile = None
    section = None
    try:
        f = open(path, errors="ignore")
    except OSError:
        return None
    with f:
        for line in f:
            s = line.strip()
            if s.startswith("["):
                section = s.lower()
                continue
            if "=" not in s:
                continue
            key, val = s.split("=", 1)
            key, val = key.strip().lower(), val.strip()
            if key == "installationfile":
                installfile = val or None
            elif key == "modid" and section and "general" in section:
                if val.isdigit() and int(val) > 0 and not modid:
                    modid = int(val)
            elif section and "installedfiles" in section:
                # keys look like `1\modid` / `1\fileid`
                if key.endswith("\\modid") and val.lstrip("-").isdigit() and int(val) > 0 and not modid:
                    modid = int(val)
                elif key.endswith("\\fileid") and val.lstrip("-").isdigit() and int(val) > 0 and not fileid:
                    fileid = int(val)
    return {"modid": modid, "fileid": fileid, "installfile": installfile}


def folder_signals():
    """{folder_name: {'modid','fileid','installfile'}} for every installed mod
    folder with a readable meta.ini. The raw material the pull matcher joins
    against the db (fileid → filename → modid → name)."""
    out = {}
    try:
        entries = os.listdir(MODS_DIR)
    except OSError:
        return out
    for name in entries:
        m = _read_folder_meta(name)
        if m is not None:
            out[name] = m
    return out


def read_modlist():
    """Every managed mod entry in modlist.txt, in FILE order (top = highest
    priority = bottom of the app's rank order). Separators, headers and `*`
    unmanaged DLC/CC are dropped. Returns [{"folder": name, "enabled": bool}].
    Reverse this for the app's rank 0..N (panel top->bottom) sense."""
    try:
        with open(modlist_path(), errors="ignore") as f:
            lines = [ln.rstrip("\n") for ln in f]
    except OSError:
        return []
    out = []
    for ln in lines:
        if not ln or ln.startswith("#"):
            continue
        mark, name = ln[0], ln[1:]
        if mark not in "+-":  # '*' unmanaged DLC/CC, anything else: skip
            continue
        if name.endswith("_separator"):
            continue
        out.append({"folder": name, "enabled": mark == "+"})
    return out

