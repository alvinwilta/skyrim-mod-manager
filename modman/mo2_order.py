"""Compare the app's computed install order against what MO2 actually has
installed on disk.

Unlike mo2.py (which only touches per-download `.meta` sidecars), this reads
MO2's real install state from the active profile:
- `config.modlist_path()` -- one line per MO2 mod, in reverse-priority order.
  `+Name` enabled, `-Name` disabled, `*Name` unmanaged (DLC/CC), names ending
  `_separator` are visual separators. The file lists highest-priority first
  (top of file = bottom of MO2's left panel), so the app's rank 0..N order
  (panel top->bottom) is the REVERSE of the enabled lines.
- `MODS_DIR/<FolderName>/meta.ini` -- MO2 writes `modid`/`fileid` here on a
  Nexus install, which we use to join a mod folder back to our mod_id.

Everything here is read-only; nothing writes to MO2's tree.
"""

import os
import re

from . import db, order_store
from .config import MODS_DIR, modlist_path


def folder_to_modid():
    """{mo2_mod_folder_name: mod_id} for every installed folder whose meta.ini
    carries a Nexus modid. Manual/non-Nexus folders (no modid) are skipped."""
    out = {}
    try:
        entries = os.listdir(MODS_DIR)
    except OSError:
        return out
    for name in entries:
        meta = os.path.join(MODS_DIR, name, "meta.ini")
        try:
            with open(meta, errors="ignore") as f:
                for line in f:
                    # MO2 mod meta.ini uses lowercase `modid=`, unlike the
                    # download .meta's `modID=`. Match case-insensitively.
                    if re.match(r"\s*modid\s*=", line, re.I):
                        val = line.split("=", 1)[1].strip()
                        if val.isdigit() and int(val) > 0:
                            out[name] = int(val)
                        break
        except OSError:
            continue
    return out


def _enabled_folders():
    """MO2 mod folder names that are enabled, in app rank order (top->bottom of
    the left panel = reverse of modlist.txt)."""
    try:
        with open(modlist_path(), errors="ignore") as f:
            lines = [ln.rstrip("\n") for ln in f]
    except OSError:
        return []
    keep = []
    for ln in lines:
        if not ln or ln.startswith("#") or not ln.startswith("+"):
            continue  # only enabled (+); drop header, * unmanaged, - disabled
        name = ln[1:]
        if name.endswith("_separator"):
            continue
        keep.append(name)
    keep.reverse()
    return keep


def installed_order():
    """(ordered [mod_id], [unmatched_folder_name]) for MO2's enabled mods.
    Order matches the app's install-order sense (panel top->bottom)."""
    fmap = folder_to_modid()
    order, unmatched = [], []
    for folder in _enabled_folders():
        mid = fmap.get(folder)
        if mid is None:
            unmatched.append(folder)
        else:
            order.append(mid)
    return order, unmatched


def _lcs_set(a, b):
    """mod_ids that lie on a longest common subsequence of a and b (both are
    the same set in different orders). Anything NOT here is out of position."""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])
    keep, i, j = set(), 0, 0
    while i < n and j < m:
        if a[i] == b[j]:
            keep.add(a[i])
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return keep


def compare():
    """Diff the app's current install list against MO2's enabled install order.

    Returns:
      out_of_order   -- mods present in both but sitting in a different relative
                        position (mismatches: [{mod_id, mod_name}])
      in_mo2_not_list-- enabled in MO2 but absent from the app list, plus MO2
                        folders with no Nexus modid ({mod_id?, mod_name/folder})
      in_list_not_mo2-- in the app list but not enabled/installed in MO2
    """
    app_mods = order_store.load_order()["mods"]
    name_by_id = {m["mod_id"]: m["mod_name"] for m in app_mods}
    app_seq = [m["mod_id"] for m in app_mods]
    mo2_seq, unmatched = installed_order()

    app_set, mo2_set = set(app_seq), set(mo2_seq)
    common = app_set & mo2_set

    a_common = [x for x in app_seq if x in common]
    b_common = [x for x in mo2_seq if x in common]
    on_lcs = _lcs_set(a_common, b_common)

    # names for MO2-only ids (not in app list) -- pull from db
    extra_ids = [x for x in mo2_seq if x not in app_set]
    extra_names = _names_for(extra_ids)

    return {
        "out_of_order": [
            {"mod_id": x, "mod_name": name_by_id.get(x, str(x))}
            for x in a_common
            if x not in on_lcs
        ],
        "in_mo2_not_list": [
            {"mod_id": x, "mod_name": extra_names.get(x, str(x))} for x in extra_ids
        ]
        + [{"mod_id": None, "mod_name": folder} for folder in unmatched],
        "in_list_not_mo2": [
            {"mod_id": x, "mod_name": name_by_id.get(x, str(x))}
            for x in app_seq
            if x not in mo2_set
        ],
    }


def _names_for(mod_ids):
    if not mod_ids:
        return {}
    with db.connect() as conn:
        placeholders = ",".join("?" * len(mod_ids))
        rows = conn.execute(
            f"SELECT mod_id, mod_name FROM mods WHERE mod_id IN ({placeholders})", mod_ids
        ).fetchall()
    return {r["mod_id"]: r["mod_name"] for r in rows}
