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

# The separator taxonomy, hardcoded (the original `separator/` scaffold dir is
# transient and may be deleted). These are the exact MO2 separator folder names
# -- `_parse_name()` derives each band's id (major*100+minor) and clean label
# from the numeric prefix, so this list IS the source of truth for the bands.
# Keep in sync with what a Push writes back to MO2's modlist.txt (Phase 4).
TAXONOMY = [
    "-_______________________________________ SKYRIM DLCs & CC ________________________________________separator",
    "00. _______________________________________ ROOT FOLDER __________________________________________separator",
    "01. ________________________________________ CORE MODS ___________________________________________separator",
    "01.1 EARLY LOADERS - CORE_separator",
    "01.2 MODDER RESOURCES - UTILITIES - CORE FIXES_separator",
    "02. ______________________________________ USER INTERFACE _________________________________________separator",
    "02.1 MENUS - HUD - CONSOLE_separator",
    "02.2 CAMERA_separator",
    "02.3 MAPS_separator",
    "02.4 CONTROLS_separator",
    "03. ____________________________________________ SOUND _____________________________________________separator",
    "03.1 AUDIO - SOUND_separator",
    "03.2 MUSIC_separator",
    "04. ___________________________________ MESHES & TEXTURES _______________________________________separator",
    "04.1 BASE MESHES & TEXTURES - EARLY LOADERS_separator",
    "04.2 FOOD - INGREDIENTS - POTIONS - CONSUMABLES_separator",
    "04.3 FURNITURE - CLUTTER - ITEMS_separator",
    "04.4 BASE LOD_separator",
    "05. ___________________________________ ENVIRONMENT & VFX _____________________________________separator",
    "05.01 LANDSCAPE_separator",
    "05.02 MOUNTAINS - ROCKS_separator",
    "05.03 MINES - CAVES - DUNGEONS_separator",
    "05.04 TREES - GRASS - FLORA_separator",
    "05.05 WATER - SNOW - ICE_separator",
    "05.06 WEATHERS - SKY_separator",
    "05.07 PARTICLE LIGHTS - ENB LIGHT_separator",
    "05.08 FIRE_separator",
    "05.09 OTHER VISUAL EFFECTS_separator",
    "06. ________________________________ CITIES - TOWNS - VILLAGES __________________________________separator",
    "06.1 CITES & MAJOR TOWNS - VANILLA_separator",
    "06.2 VILLAGES - VANILLA_separator",
    "06.3 NEW CITIES - TOWNS - VILLAGES_separator",
    "06.4 INTERIORS_separator",
    "07. _______________________________ WORLDSPACE & LOCATIONS _________________________________separator",
    "07.1 WORLDSPACE ADDITIONS - IMMERSION_separator",
    "07.2 VANILLA LOCATIONS OVERHAUL_separator",
    "07.3 NEW LOCATIONS - NEW DUNGEONS_separator",
    "07.4 PLAYER HOMES_separator",
    "08. _____________________________________ LATE GRAPHICS _________________________________________separator",
    "08.1 LIGHTING_separator",
    "08.2 LATE TEXTURES & MESHES_separator",
    "09. _________________________________________ GAMEPLAY __________________________________________separator",
    "09.1 PERKS - RACIAL - CLASSES - SKILLS_separator",
    "09.2 MAGIC - SHOUTS_separator",
    "09.3 CRAFTING - ENCHANTING - ALCHEMY_separator",
    "09.4 GAMEPLAY - IMMERSION_separator",
    "10. __________________________________________ QUESTS ____________________________________________separator",
    "10.1 NEW QUESTS - DLC-SIZED MOD - NEW LANDS _separator",
    "10.2 QUESTS - VANILLA_separator",
    "11. ______________________________________ PLAYER & NPC _________________________________________separator",
    "11.1 SKELETON - PHYSICS - BODY - FACE - HAIR _separator",
    "11.2 NPC - LOOKS_separator",
    "11.3 NPC - AI - INTERACTIONS_separator",
    "11.4 FOLLOWERS_separator",
    "12. ________________________________________ CREATURES __________________________________________separator",
    "12.1 CREATURES - VANILLA_separator",
    "12.2 CREATURES - NEW_separator",
    "13. _________________________________ WEAPONS & ARMOURS _____________________________________separator",
    "13.1 WEAPONS & ARMOUR - VANILLA _separator",
    "13.2 WEAPONS & ARMOUR - NEW_separator",
    "13.3 CLOTHING - JEWELRY_separator",
    "14. ________________________________ COMBAT & ANIMATIONS ____________________________________separator",
    "14.1 COMBAT_separator",
    "14.2 ANIMATIONS_separator",
    "15. ________________________________ GENERIC & LATE LOADERS ___________________________________separator",
    "15.1 MISCELLANEOUS PATCHES - BUG FIXES - SCRIPT FIXES_separator",
    "15.2 LATE LOADERS_separator",
    "15.3 DynDOLOD_separator",
    "16. __________________________________________ OTHER ______________________________________________separator",
    "16.1 COMMUNITY SHADERS_separator",
    "16.2 SEASONS_separator",
    "16.3 MOD STORAGE FOR NEXT PLAYTHROUGH_separator",
    "17. _____________________________________ TOOL OUTPUTS __________________________________________separator",
    "17.1 SSEEdit Output",
    "17.2 Synthesis Output",
    "17.3 Bodyslide Output",
    "17.4 Nemesis Output",
    "17.5 Wrye Bash Output",
    "17.6 Mator Smash Output",
    "17.9 Mod Settings",
    "99. ___________________________________ NEW & UNSORTED _______________________________________separator",
]

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
    # Most "Bug Fixes" are foundational engine/game fixes that belong in CORE
    # FIXES (load early, overwritten by real content), not the late Misc Patches
    # band. Mod-specific bug fixes get pulled to their base's band by the
    # name-regroup pass; genuinely-late compat patches ("Patches" category) stay
    # in 1501.
    "Bug Fixes": 102,
    "Patches": 1501,
    "Presets - ENB and ReShade": 1601,
    # explicitly unsorted: too broad to place without a look
    "Miscellaneous": UNSORTED,
    "Cheats and God items": UNSORTED,
    "Save Games": UNSORTED,
}


def seed(conn):
    """Idempotently load the hardcoded TAXONOMY into the separator table.
    Upserts name/folder/kind; never touches an existing row's `collapsed` (user
    UI state). Returns the number of bands known. The `separator/` dir is no
    longer required at runtime -- TAXONOMY is the source of truth -- but if it
    still exists any extra folders in it are also picked up (forward-compat)."""
    folders = list(TAXONOMY)
    try:
        for f in os.listdir(SEP_DIR):
            f = f.rstrip("/")
            if f not in folders:
                folders.append(f)
    except OSError:
        pass
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
