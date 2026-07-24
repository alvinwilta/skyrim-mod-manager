"""Push the tool's install order back OUT to MO2 (writes the active profile's
modlist.txt). The inverse of mo2_pull.py: the tool is now the authority and
MO2's left-panel order is made to match it.

Safety is the whole game here — a corrupt modlist.txt breaks the user's load
order — so this is deliberately minimal-diff and never destructive:

  * Every line of the current modlist.txt is preserved. Separators, the header
    comment, `*` unmanaged DLC/CC lines, generated tool outputs (Bodyslide/
    Pandora/DynDOLOD) and any folder the tool doesn't manage all stay exactly
    where they are.
  * Only the *managed* mod lines (folders that map back to an ok tool mod) are
    reordered among themselves to match the tool's rank order. Each managed
    folder keeps its own enabled/disabled mark (`+`/`-`) — pushing reorders,
    it never toggles a mod on or off.
  * The file is CRLF (MO2's format) and written atomically after a timestamped
    backup (`modlist.txt.bak-YYYYmmdd-HHMMSS`) is taken.

Direction: modlist.txt is REVERSED relative to the tool's rank — file top =
highest priority = the mod that overwrites, which is the tool's LAST rank. So
the managed folders are laid into their existing slots sorted by rank
descending.

MO2 rewrites modlist.txt when it exits, so pushing while MO2 is open would be
clobbered on its next close: a best-effort running-MO2 check refuses in that
case (the UI also warns in the confirm dialog)."""

import logging
import os
import shutil
import subprocess
import threading
import time

from . import db, jobs, mo2_order, order_store
from .config import modlist_path
from .mo2_pull import _db_indexes, _match

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None,
         "moved": 0, "skipped": 0, "backup": None}
_lock = threading.Lock()
jobs.register("mo2 push", state)


def _mo2_running():
    """Best-effort: True if a Mod Organizer process looks alive (proton runs it
    as ModOrganizer.exe). pgrep missing / erroring -> assume not running (we
    don't want a flaky check to block a legitimate push)."""
    try:
        r = subprocess.run(["pgrep", "-fi", "ModOrganizer.exe"],
                           capture_output=True, timeout=5)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _folder_to_modid(conn):
    """{mo2_folder_name: tool_mod_id} for every installed folder that resolves
    to an ok mod, by the SAME precedence pull uses (fileid -> installfile ->
    modid -> folder name). First folder wins on a mod_id collision."""
    idx = _db_indexes(conn)
    out = {}
    for folder, sig in mo2_order.folder_signals().items():
        mid = _match(folder, sig, idx)
        if mid is not None:
            out.setdefault(folder, mid)
    return out


def push():
    """Rewrite modlist.txt so managed mods sit in the tool's install order.
    Returns a summary phase string. Raises on unreadable modlist / MO2 open."""
    if _mo2_running():
        raise RuntimeError(
            "Mod Organizer looks like it's running — close it first, or it will "
            "overwrite this on exit."
        )

    path = modlist_path()
    try:
        with open(path, encoding="utf-8", errors="ignore", newline="") as f:
            raw = f.read()
    except OSError as e:
        raise RuntimeError(f"Can't read modlist.txt ({e}) — check the profiles path in Config")
    # split on \n, strip a trailing \r so we control the CRLF re-join ourselves
    lines = [ln[:-1] if ln.endswith("\r") else ln for ln in raw.split("\n")]
    trailing_nl = raw.endswith("\n")
    if trailing_nl:  # drop the empty element split() leaves after a final newline
        lines.pop()

    with db.connect() as conn:
        folder_mid = _folder_to_modid(conn)
    # tool order: load_order() rows are rank ascending (panel top->bottom).
    # rank_of[mod_id] = ascending index; file order wants DESCENDING (top of
    # file = highest priority = tool's last rank).
    order = order_store.load_order()["mods"]
    rank_of = {m["mod_id"]: i for i, m in enumerate(order)}

    def managed(ln):
        if not ln or ln[0] not in "+-":
            return None
        name = ln[1:]
        if name.endswith("_separator"):
            return None
        mid = folder_mid.get(name)
        if mid is None or mid not in rank_of:
            return None
        return mid

    slots = [i for i, ln in enumerate(lines) if managed(lines[i]) is not None]
    # the managed folders as they currently appear (mark + name), re-sorted into
    # file order (rank descending). Mark travels with the folder.
    managed_lines = [lines[i] for i in slots]
    managed_lines.sort(key=lambda ln: rank_of[folder_mid[ln[1:]]], reverse=True)
    for slot, new_line in zip(slots, managed_lines):
        lines[slot] = new_line

    # mods the tool knows but MO2 has no folder for (downloaded, not installed
    # in MO2) can't be placed — report them.
    placed = {folder_mid[ln[1:]] for ln in managed_lines}
    skipped = sum(1 for mid in rank_of if mid not in placed)

    backup = f"{path}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)

    body = "\r\n".join(lines) + ("\r\n" if trailing_nl else "")
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(body)
    os.replace(tmp, path)

    state["moved"], state["skipped"], state["backup"] = len(slots), skipped, os.path.basename(backup)
    return (f"Pushed {len(slots)} mod(s) to MO2 in tool order · {skipped} not installed "
            f"in MO2 (skipped) · backup {os.path.basename(backup)}")


def start_push():
    """Async push. Returns an error string or None. Exclusive: it reads the whole
    order, so it can't overlap a sort/refine/pull/download/commit rewriting it."""
    return jobs.start(
        _lock, state, "a push is already running", push,
        init={"moved": 0, "skipped": 0, "backup": None},
        exclusive_as="mo2 push",
    )
