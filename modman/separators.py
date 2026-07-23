"""Separator taxonomy: the cosmetic GROUPING layer (STEP-style numbered bands),
separate from the functional install order (ranks/conflicts).

The target taxonomy lives in the repo `separator/` dir (one MO2 separator folder
per band, named `NN.M LABEL_separator`). We parse those names into a `separator`
table whose id IS the band sort key (major*100 + minor), so ordering by id is
ordering by band. Each ok mod is then tagged with a `separator_id` via a
Nexus-category -> band mapping (+ a few special rules). This is Phase 2: it only
GROUPS; it never reorders (Phase 3's engine does band-driven ordering).
"""

import os
import re

from . import db
from .config import ROOT_DIR

SEP_DIR = os.path.join(ROOT_DIR, "separator")

# Fallback band for anything unmapped / uncategorised: NEW & UNSORTED (99).
UNSORTED = 9900


def _parse_name(folder):
    """Separator folder name -> (sort_key, clean_label). sort_key = major*100 +
    minor from the numeric prefix; the DLCs entry (leading '-') sorts first
    (-100); a prefix-less name returns (None, ...)."""
    base = folder[: -len("_separator")] if folder.endswith("_separator") else folder
    m = re.match(r"\s*(\d+)(?:\.(\d+))?", base)
    if m:
        key = int(m.group(1)) * 100 + int(m.group(2) or 0)
    elif base.strip().startswith("-"):
        key = -100
    else:
        key = None
    label = re.sub(r"_+", " ", re.sub(r"^[\s\-\d.]+", "", base)).strip(" _-")
    return key, label


def _special_kind(key):
    """Classify a band. Non-NULL kinds are NOT category-fed: header = a section
    title (mods never land directly on it), output/unsorted/dlc/storage/root are
    handled specially."""
    if key == -100:
        return "dlc"
    if key == 0:
        return "root"
    if key == UNSORTED:
        return "unsorted"
    if key == 1603:
        return "storage"
    if 1701 <= key <= 1799:
        return "output"
    if key % 100 == 0:  # a major header (01., 02., ... 17.)
        return "header"
    return None


# Nexus category -> band sort key. Category-first, coarse; the AI refine (Phase
# 3) nudges into finer sub-bands. Anything absent falls back to UNSORTED.
CATEGORY_SEPARATOR = {
    "Utilities": 102,
    "Modders Resources": 102,
    "User Interface": 201,
    "Audio": 301,
    "Models and Textures": 401,
    "Items and Objects - Player": 403,
    "Items and Objects - World": 403,
    "Environmental": 501,
    "Visuals and Graphics": 501,
    "Cities, Towns, Villages, and Hamlets": 601,
    "Buildings": 601,
    "Locations - New": 703,
    "Locations - Vanilla": 702,
    "Player homes": 704,
    "Skills and Leveling": 901,
    "Races, Classes, and Birthsigns": 901,
    "Shouts": 902,
    "Magic - Spells & Enchantments": 902,
    "Magic - Gameplay": 904,
    "Crafting": 903,
    "Alchemy": 903,
    "Gameplay": 904,
    "Overhauls": 904,
    "Immersion": 904,
    "Stealth": 904,
    "Guilds/Factions": 904,
    "Quests and Adventures": 1001,
    "Collectables, Treasure Hunts, and Puzzles": 1001,
    "Body, Face, and Hair": 1101,
    "NPC": 1102,
    "Followers & Companions": 1104,
    "Creatures and Mounts": 1202,
    "Weapons": 1302,
    "Armour": 1302,
    "Weapons and Armour": 1302,
    "Clothing and Accessories": 1303,
    "Combat": 1401,
    "Animation": 1402,
    "Bug Fixes": 1501,
    "Patches": 1501,
    "Presets - ENB and ReShade": 1601,
    # explicitly unsorted: too broad to place without a look
    "Miscellaneous": UNSORTED,
    "Cheats and God items": UNSORTED,
    "Save Games": UNSORTED,
}


def seed(conn):
    """Idempotently load the `separator/` taxonomy into the separator table.
    Upserts name/folder/kind; never touches an existing row's `collapsed` (user
    UI state). Returns the number of bands known."""
    try:
        folders = os.listdir(SEP_DIR)
    except OSError:
        return conn.execute("SELECT COUNT(*) FROM separator").fetchone()[0]
    for folder in folders:
        key, label = _parse_name(folder)
        if key is None:
            continue
        conn.execute(
            "INSERT INTO separator (id, name, folder, special_kind) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET name = excluded.name, folder = excluded.folder,"
            " special_kind = excluded.special_kind",
            (key, label, folder, _special_kind(key)),
        )
    return conn.execute("SELECT COUNT(*) FROM separator").fetchone()[0]


def list_separators():
    """All bands in display (band) order, with a live mod count each."""
    with db.connect() as conn:
        seed(conn)
        rows = conn.execute(
            "SELECT s.id, s.name, s.special_kind, s.collapsed,"
            " (SELECT COUNT(*) FROM mod_sort ms JOIN mods m ON m.mod_id = ms.mod_id"
            "  WHERE ms.separator_id = s.id AND m.status = 'ok') AS mod_count"
            " FROM separator s ORDER BY s.id"
        ).fetchall()
    return [dict(r) for r in rows]


def assign():
    """Tag every ok mod with a separator_id from its Nexus category (unmapped ->
    NEW & UNSORTED), then re-rank so the install order groups by band (each
    band's internal order preserved). This makes the separators clean inline
    dividers in the single draggable order. Returns count assigned."""
    from . import order_store

    with db.connect() as conn:
        seed(conn)
        valid = {r["id"] for r in conn.execute("SELECT id FROM separator")}
        rows = conn.execute(
            "SELECT m.mod_id, m.category FROM mods m WHERE m.status = 'ok'"
        ).fetchall()
        n = 0
        for r in rows:
            sk = CATEGORY_SEPARATOR.get((r["category"] or "").strip(), UNSORTED)
            if sk not in valid:
                sk = UNSORTED
            conn.execute(
                "INSERT INTO mod_sort (mod_id, separator_id) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET separator_id = excluded.separator_id",
                (r["mod_id"], sk),
            )
            n += 1
    order_store.rerank_by_separator()
    return n


def set_collapsed(sep_id, collapsed):
    """Persist a band's collapsed UI state."""
    with db.connect() as conn:
        conn.execute("UPDATE separator SET collapsed = ? WHERE id = ?", (1 if collapsed else 0, sep_id))
