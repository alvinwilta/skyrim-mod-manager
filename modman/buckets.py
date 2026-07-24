"""STEP SkyrimSE 2.3 MO2 left-panel bucket scheme and the pure name/category
heuristic that maps a mod to one. No db access here -- this module is just
data plus a function, shared by order_store.py (heuristic pass), llm_refine.py
(prompt text) and conflicts.py (structural-overwrite bucket numbers), without
any risk of a circular import between them."""

import json
import re
from pathlib import Path

# Ground truth scraped from the STEP SkyrimSE 2.3 guide's own mod tables
# (stepmodifications.org/wiki/SkyrimSE:2.3): {bucket: [mod name, ...]} for
# every mod the guide itself places in that bucket. Exact-name match against
# this beats every heuristic below -- it's not a guess, it's where STEP put it.
_STEP_GUIDE_PATH = Path(__file__).parent.parent / "data" / "step_2.3_groups.json"
with open(_STEP_GUIDE_PATH, encoding="utf-8") as _f:
    _STEP_GUIDE_GROUPS = {int(k): v for k, v in json.load(_f).items()}


def _norm(name):
    return re.sub(r"\s+", " ", (name or "").strip().lower())


STEP_GUIDE_BUCKET = {
    _norm(name): bucket for bucket, names in _STEP_GUIDE_GROUPS.items() for name in names
}

# Bucket scheme follows the STEP SkyrimSE 2.3 guide's MO2 left-panel
# separators (stepmodifications.org/wiki/SkyrimSE:2.3, groups 02-21).
BUCKETS = {
    1: "Extenders",
    2: "Resources",
    3: "Foundation",
    4: "Animation & Physics",
    5: "Models & Textures",
    6: "Sounds & Music",
    7: "Character Appearance",
    8: "Fixes",
    9: "Gameplay — General",
    10: "Gameplay — AI & Combat",
    11: "Gameplay — Economy",
    12: "Gameplay — Immersion",
    13: "Gameplay — Quests",
    14: "Gameplay — Skills & Perks",
    15: "Interface",
    16: "Locations",
    17: "Lighting & Weather",
    18: "Utilities",
    19: "Patches",
    20: "Post-Processing",
}

# Foundation (3) is installed early specifically to be broadly overwritten;
# Patches (19) is installed late specifically to broadly overwrite everything
# it touches -- both "conflict with lots of things" by design, not a red flag.
# Single source of truth for anything that needs to tell a structural
# overwrite apart from an unintentional collision (see conflicts.py).
STRUCTURAL_BUCKETS = {3, 19}

# What belongs in each bucket, per the STEP guide — fed into the LLM prompt
# so it sorts by STEP's intent instead of guessing from the label alone.
BUCKET_HINTS = {
    1: "SKSE64 itself and DLL-level engine plugins: Address Library, Engine Fixes, Crash Logger, PapyrusUtil, Display Tweaks",
    2: "shared frameworks other mods depend on: SPID, KID, Base Object Swapper, MCM Helper, JContainers, papyrus script libraries",
    3: "USSEP and wide-reach base overhauls installed early so later groups override them: SMIM, Majestic Mountains, ELFX, Cathedral Landscapes, Particle Patch, DynDOLOD Resources",
    4: "skeletons, animation replacers and physics: XP32/XPMSSE, OAR/DAR animations, HDT-SMP, behavior fixes",
    5: "standalone model/texture replacers that override Foundation assets",
    6: "sound, music, voice and footstep replacers or additions",
    7: "hair, brows, eyes, skin, bodies and NPC appearance overhauls",
    8: "targeted bug-fix mods (Bug Fixes SSE, Scrambled Bugs, po3's Tweaks) — after asset mods so fixes win",
    9: "general gameplay mechanics: crafting, alchemy, item/loot behavior, camera",
    10: "AI behavior and combat changes",
    11: "trade, barter, gold and economy changes",
    12: "immersion tweaks: dialogue, equipment display, movement, small QoL",
    13: "quest changes and quest-flow tweaks",
    14: "skills, perks, magic and leveling: Vokrii, Odin, uncappers, custom skill frameworks",
    15: "all UI: SkyUI, RaceMenu, HUD, map, menus, fonts, console",
    16: "worldspace/location edits: Cutting Room Floor, landscape fixes, city/building changes",
    17: "weather and lighting overhauls: Cathedral Weathers, Relighting, volumetrics",
    18: "tools and late-loading runtime patchers: Nemesis/Pandora, DynDOLOD, BodySlide, SSEEdit, SkyPatcher, No Grass In Objects",
    19: "compatibility patches between other mods — must overwrite everything they patch",
    20: "ENB/ReShade helpers and particle lights — the very bottom, below Patches",
}

# Nexus category name -> (bucket, confidence). Confidence < .5 gets [UNCERTAIN].
CATEGORY_BUCKET = {
    "Bug Fixes": (8, 0.7),
    "Patches": (19, 0.8),
    "Utilities": (18, 0.5),
    "Universal Tools": (18, 0.6),
    "Modders Resources": (2, 0.5),
    "Animation": (4, 0.6),
    "User Interface": (15, 0.8),
    "Models and Textures": (5, 0.6),
    "Visuals and Graphics": (20, 0.3),
    "Environmental": (17, 0.5),
    "Audio": (6, 0.8),
    "Gameplay": (9, 0.5),
    "Magic - Gameplay": (14, 0.6),
    "Magic - Spells & Enchantments": (14, 0.6),
    "Skills and Leveling": (14, 0.7),
    "Crafting": (9, 0.6),
    "Immersion": (12, 0.6),
    "Cheats and God items": (9, 0.4),
    "Overhauls": (9, 0.4),
    "Quests and Adventures": (13, 0.7),
    "Locations - Vanilla": (16, 0.6),
    "Creatures and Mounts": (5, 0.4),
    "Miscellaneous": (9, 0.2),
    "Body, Face, and Hair": (7, 0.7),
    "NPC": (7, 0.5),
    "Combat": (10, 0.7),
    "Stealth": (10, 0.7),
    "Shouts": (14, 0.6),
    "Alchemy": (9, 0.6),
    "Armour": (9, 0.4),
    "Weapons": (9, 0.4),
    "Items and Objects - Player": (9, 0.4),
    "Items and Objects - World": (5, 0.4),
    "Guilds/Factions": (13, 0.4),
    "Followers & Companions": (9, 0.3),
    "Followers & Companions - Creatures": (9, 0.3),
    "Buildings": (16, 0.4),
    "Cities, Towns, Villages, and Hamlets": (16, 0.7),
    "Player homes": (16, 0.7),
}

# Name keywords beat the Nexus category; first match wins, so more
# distinctive patterns come first (USSEP before the generic patch rule).
# Patterns are seeded from where STEP 2.3 actually files these mods
# (e.g. USSEP/SMIM/ELFX in Foundation, Nemesis/DynDOLOD in Utilities,
# po3's Tweaks / Bug Fixes SSE in Fixes, ENB lights in Post-Processing).
KEYWORDS = [
    (r"\bskse\b|address library|engine fixes|crash logger|script framework|buffout|papyrus (util|tweaks)|display tweaks|scaleform", 1, 0.95),
    (r"papyrus extender|\bspid\b|(spell perk item|keyword item|sound record) distributor|mcm helper|base object swapper|payload interpreter|uiextensions", 2, 0.9),
    (r"unofficial skyrim.*patch|\bussep\b|\bsmim\b|static mesh improvement|majestic mountains|enhanced lights and fx|\belfx\b|cathedral (landscapes|plants)|particle patch|dyndolod (resources|dll)|material fix|assorted mesh fixes", 3, 0.9),
    (r"nemesis|behavior engine|dyndolod|xlodgen|\blod\b|no grass in objects|road generator", 18, 0.9),
    (r"open animation replacer|dynamic animation replacer|\boar\b|\bdar\b|animation|xp32|skeleton|physics|\bhdt\b|bobbing", 4, 0.8),
    (r"\benb\b|reshade|particle lights|post.?process", 20, 0.85),
    (r"weather|lighting|relighting|\blux\b|azurite|obsidian|lanterns|volumetric|shooting stars|storm lightning|rainbows", 17, 0.85),
    (r"ks hairdos|bijin|\bcbbe\b|\b3ba\b|himbo|high poly head|expressive fac|beards|brows|\bhair\b|scars|warpaint|makeup|skin texture|salt and wind|npc overhaul|\beyes\b|children", 7, 0.8),
    (r"sound|audio|music|footsteps|reverb|shouts?\b|howls", 6, 0.8),
    (r"skyui|racemenu|\bhud\b|\bui\b|\bmenus?\b|widget|map markers|console|font|loading screens|cursors?\b|messagebox", 15, 0.8),
    (r"combat|stealth|\bai\b|detection|run for your lives|follower trap", 10, 0.75),
    (r"trade|barter|economy", 11, 0.8),
    (r"alternate start|quest|paarthurnax|thieves guild requirements|timing is everything|choice is yours", 13, 0.75),
    (r"perks?\b|vokrii|ordinator|\bodin\b|magic overhaul|skill uncapper|leveling", 14, 0.75),
    (r"alchemy|crafting|smithing|soul trap|\bwaccf\b|clutter fixes", 9, 0.7),
    (r"immersive|immersion|dialogue overhaul|drop lit torches|dual sheath|movement speed", 12, 0.6),
    (r"cutting room floor|hearthfires? extended|landscape fixes|worldspace|chimneys|shores", 16, 0.75),
    (r"compatib|consistency patch|patch (for|hub|collection)|patch$|patches$", 19, 0.7),
    (r"retexture|\b[24]k\b|\bhd\b|texture|mesh|amidianborn|rustic|elsopa|book covers", 5, 0.6),
    (r"fix(es|ed)?\b|tweaks\b", 8, 0.55),
]


def classify(name, category):
    step_bucket = STEP_GUIDE_BUCKET.get(_norm(name))
    if step_bucket is not None:
        return step_bucket, []

    lname = (name or "").lower()
    bucket = conf = None
    for pat, b, c in KEYWORDS:
        if re.search(pat, lname):
            bucket, conf = b, c
            break
    if bucket is None:
        # no keyword hit: fall back to the category map, defaulting unmapped
        # categories to Gameplay — General (9), the neutral middle of the order
        # rather than any opinionated bucket
        bucket, conf = CATEGORY_BUCKET.get(category or "", (9, 0.2))
    flags = []
    if conf < 0.5:
        flags.append("UNCERTAIN")
    return bucket, flags
