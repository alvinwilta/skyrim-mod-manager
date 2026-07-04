"""Loose MO2 left-panel install order (top to bottom; bottom overwrites).
This is the *install* order (file conflicts), not the plugin load order —
LOOT handles that.

Two passes. The heuristic pass is deterministic and instant: mod name
keywords, then the Nexus category, map each mod to one of 13 buckets.
The optional LLM pass shells out to the Claude Code CLI (`claude -p`,
uses the local login, no API key) to re-rank, move misfits and emit
conflict notes; it runs in a background thread with progress in `state`,
mirroring the download engine. Results persist in the mods table
(sort_bucket / sort_rank / sort_flags) and the meta table (conflict
notes), so sorting is a one-time cost per library change."""

import json
import logging
import re
import shutil
import subprocess
import threading

from . import db, mo2

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None}
_lock = threading.Lock()

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
    lname = (name or "").lower()
    bucket = conf = None
    for pat, b, c in KEYWORDS:
        if re.search(pat, lname):
            bucket, conf = b, c
            break
    if bucket is None:
        bucket, conf = CATEGORY_BUCKET.get(category or "", (8, 0.2))
    flags = []
    if "patch" in lname and bucket not in (1, 3):
        flags.append("PATCH")
    if conf < 0.5:
        flags.append("UNCERTAIN")
    return bucket, flags


def heuristic_sort():
    """Bucket every ok mod and rank alphabetically within buckets."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT mod_id, mod_name, category FROM mods WHERE status = 'ok' GROUP BY mod_id"
        ).fetchall()
        results = []
        for r in rows:
            bucket, flags = classify(r["mod_name"], r["category"])
            results.append((bucket, (r["mod_name"] or "").lower(), r["mod_id"], flags))
        results.sort()
        for rank, (bucket, _, mod_id, flags) in enumerate(results):
            conn.execute(
                "UPDATE mods SET sort_bucket = ?, expected_bucket = ?, sort_rank = ?,"
                " sort_flags = ? WHERE mod_id = ?",
                (bucket, bucket, rank, ",".join(flags), mod_id),
            )
    return len(results)


def load_order():
    """Ordered library for the Load Order tab. One row per mod; a mod counts
    as installed when any of its archives is installed in MO2."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT mod_id, mod_name, category, mod_url, sort_bucket, sort_rank, sort_flags,"
            " json_group_array(filename) AS fns"
            " FROM mods WHERE status = 'ok' GROUP BY mod_id"
            " ORDER BY sort_bucket IS NULL, sort_bucket, sort_rank, mod_name COLLATE NOCASE"
        ).fetchall()
        note_row = conn.execute("SELECT value FROM meta WHERE key = 'conflict_notes'").fetchone()
    mods = [
        {
            "mod_id": r["mod_id"],
            "mod_name": r["mod_name"],
            "category": r["category"],
            "mod_url": r["mod_url"],
            "bucket": r["sort_bucket"],
            "flags": [f for f in (r["sort_flags"] or "").split(",") if f],
            "installed": any(mo2.is_installed(f) for f in json.loads(r["fns"]) if f),
        }
        for r in rows
    ]
    notes = json.loads(note_row["value"]) if note_row else []
    return {"buckets": BUCKETS, "mods": mods, "notes": notes}


def move(mod_id, position):
    """Move a mod to a 1-based position in the global order, shifting the rest.
    The mod adopts the bucket of its new neighbor above (below when moved to
    the top) so the grouped view stays coherent; expected_bucket is untouched,
    which is what check_order compares against."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT mod_id, sort_bucket FROM mods WHERE status = 'ok' GROUP BY mod_id"
            " ORDER BY sort_bucket IS NULL, sort_bucket, sort_rank, mod_name COLLATE NOCASE"
        ).fetchall()
        ids = [r["mod_id"] for r in rows]
        if mod_id not in ids:
            return "unknown mod"
        buckets = {r["mod_id"]: r["sort_bucket"] for r in rows}
        ids.remove(mod_id)
        pos = max(0, min(len(ids), int(position) - 1))
        ids.insert(pos, mod_id)
        neighbor = ids[pos - 1] if pos > 0 else (ids[pos + 1] if len(ids) > 1 else mod_id)
        buckets[mod_id] = buckets[neighbor]
        for rank, mid in enumerate(ids):
            conn.execute(
                "UPDATE mods SET sort_rank = ?, sort_bucket = ? WHERE mod_id = ?",
                (rank, buckets[mid], mid),
            )
    return None


def check_order():
    """Mods whose current bucket disagrees with the last sorter opinion
    (heuristic or LLM) — i.e. likely misplaced after manual moves."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT mod_id, sort_bucket, expected_bucket FROM mods WHERE status = 'ok'"
            " AND expected_bucket IS NOT NULL GROUP BY mod_id"
        ).fetchall()
    return {
        "mismatches": [
            {"mod_id": r["mod_id"], "actual": r["sort_bucket"], "expected": r["expected_bucket"]}
            for r in rows
            if r["sort_bucket"] != r["expected_bucket"]
        ]
    }


# {{BUCKETS}} and {{MODS}} are replaced before the call; the edited copy
# lives in the meta table (key 'sort_prompt') when the user changes it.
DEFAULT_PROMPT = """You are a Skyrim SE mod install order sorter for the MO2 left panel
(top to bottom, bottom = highest priority / overwrites above).

Buckets, in install order (the STEP SkyrimSE 2.3 guide's MO2 separators):
{{BUCKETS}}

Rules: a patch always goes below what it patches; more specific mods below
general ones; primary function decides multi-category mods. STEP conventions:
USSEP and base mesh/lighting overhauls (SMIM, ELFX, Majestic Mountains) are
Foundation; Nemesis/DynDOLOD/LOD tools are Utilities; generic bug-fix mods go
in Fixes, not Foundation; ENB/particle-light mods are Post-Processing, below
Patches.

Input lines below: mod_id|mod name|nexus category|heuristic bucket guess.
The guess may be wrong — fix misfits.

Reply with ONLY a JSON object, no prose, no code fences:
{"order": [{"id": <mod_id>, "b": <bucket 1-20>, "f": ["PATCH"|"UNCERTAIN"|"CONFLICT: <reason>"]}, ...],
 "conflicts": ["<mod A> vs <mod B>: <which should win and why>", ...]}
"order" must contain every input mod exactly once, in full install order.
Omit "f" when a mod has no flags.

Mods:
{{MODS}}"""


def get_prompt():
    with db.connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = 'sort_prompt'").fetchone()
    return row["value"] if row and row["value"].strip() else DEFAULT_PROMPT


def set_prompt(text):
    """Store a custom prompt; empty or unchanged-from-default resets to default.
    Returns error string or None."""
    text = (text or "").strip()
    if text and "{{MODS}}" not in text:
        return "prompt must contain the {{MODS}} placeholder"
    with db.connect() as conn:
        if text and text != DEFAULT_PROMPT.strip():
            conn.execute("INSERT OR REPLACE INTO meta VALUES ('sort_prompt', ?)", (text,))
        else:
            conn.execute("DELETE FROM meta WHERE key = 'sort_prompt'")
    return None


def _run_claude(mods):
    lines = "\n".join(
        f"{m['mod_id']}|{m['mod_name']}|{m['category'] or ''}|{m['bucket'] or ''}" for m in mods
    )
    buckets = "\n".join(f"{n}. {label}" for n, label in BUCKETS.items())
    prompt = get_prompt().replace("{{BUCKETS}}", buckets).replace("{{MODS}}", lines)
    proc = subprocess.run(
        ["claude", "-p", prompt, "--model", "haiku", "--output-format", "json"],
        capture_output=True, text=True, timeout=600,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited {proc.returncode}: {proc.stderr.strip()[:200]}")
    text = json.loads(proc.stdout).get("result", "")
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    return json.loads(text)


def _refine_job():
    order = load_order()["mods"]
    state["phase"] = f"Asking Claude to sort {len(order)} mods (may take a few minutes)"
    result = _run_claude(order)
    known = {m["mod_id"] for m in order}
    state["phase"] = "Saving"
    with db.connect() as conn:
        for rank, item in enumerate(result["order"]):
            if item.get("id") not in known:
                continue
            conn.execute(
                "UPDATE mods SET sort_bucket = ?, expected_bucket = ?, sort_rank = ?,"
                " sort_flags = ? WHERE mod_id = ?",
                (item.get("b"), item.get("b"), rank, ",".join(item.get("f") or []), item["id"]),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta VALUES ('conflict_notes', ?)",
            (json.dumps(result.get("conflicts") or []),),
        )
    state["phase"] = "Finished"


def start_llm_refine():
    """Async LLM refinement. Returns error string or None (mirrors start_download)."""
    if shutil.which("claude") is None:
        return "claude CLI not found — heuristic order kept"
    if not _lock.acquire(blocking=False):
        return "a sort job is already running"

    def runner():
        try:
            state.update({"error": None, "running": True})
            _refine_job()
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None
