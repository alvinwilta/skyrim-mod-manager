"""Loose MO2 left-panel install order (top to bottom; bottom overwrites).
This is the *install* order (file conflicts), not the plugin load order —
LOOT handles that.

Two passes. The heuristic pass is deterministic and instant: mod name
keywords, then the Nexus category, map each mod to one of 13 buckets.
The optional LLM pass shells out to the Claude Code CLI (`claude -p`,
uses the local login, no API key) to re-rank, move misfits and emit
conflict notes; it runs in a background thread with progress in `state`,
mirroring the download engine. Results persist in the mods table
(one row per mod: bucket/rank/flags/lock) and the meta table (conflict
notes), so sorting is a one-time cost per library change."""

import json
import logging
import re
import shutil
import subprocess
import threading

from . import db, mo2, nexus

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
    if conf < 0.5:
        flags.append("UNCERTAIN")
    return bucket, flags


def _write_ranks(conn, unlocked_ids):
    """Assign global ranks: locked mods stay pinned at their saved rank,
    unlocked mods (already ordered) fill the remaining slots around them."""
    locked = conn.execute(
        "SELECT mod_id, rank FROM mod_sort WHERE locked = 1"
        " AND mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok') ORDER BY rank"
    ).fetchall()
    total = len(unlocked_ids) + len(locked)
    slots = [None] * total
    for r in locked:
        i = min(r["rank"] or 0, total - 1)
        while slots[i] is not None:  # collision: next free slot downward
            i = (i + 1) % total
        slots[i] = r["mod_id"]
    it = iter(unlocked_ids)
    for i in range(total):
        if slots[i] is None:
            slots[i] = next(it)
    for rank, mod_id in enumerate(slots):
        conn.execute(
            "INSERT INTO mod_sort (mod_id, rank) VALUES (?, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank",
            (mod_id, rank),
        )


def _upsert_sort(conn, mod_id, bucket=None, flags=None, expected=True):
    conn.execute(
        "INSERT INTO mod_sort (mod_id, bucket, flags, expected_bucket) VALUES (?, ?, ?, ?)"
        " ON CONFLICT(mod_id) DO UPDATE SET bucket = excluded.bucket, flags = excluded.flags"
        + (", expected_bucket = excluded.expected_bucket" if expected else ""),
        (mod_id, bucket, flags, bucket if expected else None),
    )


def heuristic_sort():
    """Bucket every unlocked ok mod and rank alphabetically within buckets;
    locked mods keep their bucket and pinned position."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, m.category FROM mods m"
            " LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' AND COALESCE(s.locked, 0) = 0 GROUP BY m.mod_id"
        ).fetchall()
        results = []
        for r in rows:
            bucket, flags = classify(r["mod_name"], r["category"])
            results.append((bucket, (r["mod_name"] or "").lower(), r["mod_id"], flags))
        results.sort()
        for bucket, _, mod_id, flags in results:
            _upsert_sort(conn, mod_id, bucket, ",".join(flags))
        # a full heuristic re-sort discards any earlier bucket opinion, so
        # give the description pass a fresh shot at these mods too
        conn.execute(
            "UPDATE mod_sort SET desc_checked = 0"
            " WHERE mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok')"
            " AND COALESCE(locked, 0) = 0"
        )
        _write_ranks(conn, [mod_id for _, _, mod_id, _ in results])
    return len(results)


def _place_in_bucket(conn, mod_id, bucket):
    """Reposition a single already-tracked mod so its rank matches a new
    bucket assignment, without disturbing anyone else's order -- used when a
    later pass corrects an earlier bucket guess. Reuses _write_ranks so
    locked mods keep their pinned slots."""
    rows = conn.execute(
        "SELECT m.mod_id, s.bucket FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
        " WHERE m.status = 'ok' AND m.mod_id != ? AND COALESCE(s.locked, 0) = 0"
        " GROUP BY m.mod_id ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE",
        (mod_id,),
    ).fetchall()
    ids = [r["mod_id"] for r in rows]
    pos = sum(1 for r in rows if (r["bucket"] if r["bucket"] is not None else 999) <= bucket)
    ids.insert(pos, mod_id)
    _write_ranks(conn, ids)


def set_lock(mod_id, locked):
    """Pin/unpin a mod at its current position. Returns error string or None."""
    with db.connect() as conn:
        known = conn.execute("SELECT 1 FROM mods WHERE mod_id = ?", (mod_id,)).fetchone()
        if not known:
            return "unknown mod"
        conn.execute(
            "INSERT INTO mod_sort (mod_id, locked) VALUES (?, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET locked = excluded.locked",
            (mod_id, 1 if locked else 0),
        )
    return None


def load_order():
    """Ordered library for the Load Order tab. One row per mod; a mod counts
    as installed when any of its archives is installed in MO2."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, m.mod_name, m.category, m.mod_url, s.bucket AS sort_bucket,"
            " s.rank AS sort_rank, s.flags AS sort_flags, s.locked AS sort_locked,"
            " json_group_array(m.filename) AS fns"
            " FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' GROUP BY m.mod_id"
            " ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE"
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
            "locked": bool(r["sort_locked"]),
            "installed": any(mo2.is_installed(f) for f in json.loads(r["fns"]) if f),
        }
        for r in rows
    ]
    notes = json.loads(note_row["value"]) if note_row else []
    return {"buckets": BUCKETS, "mods": mods, "notes": notes}


def move(mod_ids, position):
    """Move one or several mods (as a block, keeping their relative order) to
    a 1-based position in the global order, shifting the rest. Moved mods
    adopt the bucket of their new neighbor above (below when moved to the
    top) so the grouped view stays coherent; expected_bucket is untouched,
    which is what check_order compares against."""
    if isinstance(mod_ids, int):
        mod_ids = [mod_ids]
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT m.mod_id, s.bucket FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
            " WHERE m.status = 'ok' GROUP BY m.mod_id"
            " ORDER BY s.rank IS NULL, s.rank, s.bucket, m.mod_name COLLATE NOCASE"
        ).fetchall()
        ids = [r["mod_id"] for r in rows]
        moving = [i for i in ids if i in set(mod_ids)]  # keep current relative order
        if len(moving) != len(set(mod_ids)):
            return "unknown mod"
        buckets = {r["mod_id"]: r["bucket"] for r in rows}
        ids = [i for i in ids if i not in set(moving)]
        pos = max(0, min(len(ids), int(position) - 1))
        ids[pos:pos] = moving
        neighbor = ids[pos - 1] if pos > 0 else (ids[pos + len(moving)] if len(ids) > len(moving) else moving[0])
        for mid in moving:
            buckets[mid] = buckets[neighbor]
        for rank, mid in enumerate(ids):
            conn.execute(
                "INSERT INTO mod_sort (mod_id, rank, bucket) VALUES (?, ?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET rank = excluded.rank, bucket = excluded.bucket",
                (mid, rank, buckets[mid]),
            )
    return None


def check_order():
    """Mods whose current bucket disagrees with the last sorter opinion
    (heuristic or LLM) — i.e. likely misplaced after manual moves."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT s.mod_id, s.bucket, s.expected_bucket FROM mod_sort s"
            " WHERE s.expected_bucket IS NOT NULL AND s.locked = 0"
            " AND s.mod_id IN (SELECT mod_id FROM mods WHERE status = 'ok')"
        ).fetchall()
    return {
        "mismatches": [
            {"mod_id": r["mod_id"], "actual": r["bucket"], "expected": r["expected_bucket"]}
            for r in rows
            if r["bucket"] != r["expected_bucket"]
        ]
    }


# {{BUCKETS}} and {{MODS}} are replaced before the call; the edited copy
# lives in the meta table (key 'sort_prompt') when the user changes it.
DEFAULT_PROMPT = """You are a Skyrim SE mod install order sorter for the MO2 left panel
(top to bottom, bottom = highest priority / overwrites above). The scheme is
the STEP SkyrimSE 2.3 guide (stepmodifications.org/wiki/SkyrimSE:2.3): mods
are installed in the guide's group order so that each group's files overwrite
the groups above it, and compatibility patches overwrite everything they
patch.

Groups, in install order, with what STEP puts in each:
{{BUCKETS}}

Rules:
- A patch always goes below every mod it patches.
- More specific mods go below general ones.
- A mod's primary function decides its group when several could apply.
- Keep STEP's counterintuitive placements: USSEP and base overhauls are
  Foundation (early, meant to be overwritten); generic bug-fix mods are
  Fixes (mid-list, after asset mods); Nemesis/DynDOLOD/LOD tools are
  Utilities (late); ENB and particle lights are Post-Processing, below
  Patches.
- The Nexus category is a hint only; it is often wrong (e.g. 'Bug Fixes'
  for SKSE plugins that belong in Extenders).

The mods below are listed under their current group heading — a heuristic
guess. Most are right; move the misfits. Each line: mod_id|mod name|nexus
category.

Reply with ONLY plain lines, no prose, no code fences. First every input mod
exactly once, one per line, in full install order (top to bottom):
<mod_id>|<bucket 1-20>
Append |<flags> only when flagged (comma-separated). Allowed flags:
UNCERTAIN, CONFLICT:<mod_id of the mod it conflicts with>
Then, if any mods conflict, a final section:
CONFLICTS:
<mod_id A> (<name A>) vs <mod_id B> (<name B>): <which should win and why>

Mods:
{{MODS}}"""


def _parse_reply(text):
    """Parse the line-based reply: 'id|bucket[|flags]' rows, then an optional
    CONFLICTS: section. Line format keeps the reply ~3x smaller than JSON,
    which is what dominates the runtime. Non-matching lines are skipped."""
    text = re.sub(r"^```\w*|```$", "", text.strip(), flags=re.M).strip()
    order, conflicts, in_conflicts = [], [], False
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.upper().rstrip(":").endswith("CONFLICTS"):
            in_conflicts = True
            continue
        if in_conflicts:
            conflicts.append(line)
            continue
        parts = [p.strip() for p in line.split("|")]
        if not parts[0].isdigit():
            continue
        item = {"id": int(parts[0])}
        if len(parts) > 1 and parts[1].isdigit():
            item["b"] = int(parts[1])
        if len(parts) > 2:
            item["f"] = [f.strip() for f in parts[2].split(",") if f.strip()]
        order.append(item)
    return {"order": order, "conflicts": conflicts}


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


_proc = None  # running claude subprocess, for the force-stop endpoint
MODELS = ("haiku", "sonnet", "opus")


def _call_claude(prompt, model):
    global _proc
    _proc = subprocess.Popen(
        ["claude", "-p", prompt, "--model", model, "--output-format", "json"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        out, err = _proc.communicate(timeout=600)
        code = _proc.returncode
    finally:
        _proc = None
    if code != 0:
        if code < 0:
            raise RuntimeError("stopped by user")
        raise RuntimeError(f"claude exited {code}: {err.strip()[:200]}")
    return json.loads(out).get("result", "")


def _run_claude(mods, model="haiku"):
    sections, last = [], object()
    for m in mods:  # mods arrive ordered, so buckets form contiguous runs
        if m["bucket"] != last:
            last = m["bucket"]
            sections.append(f"\n# {last}. {BUCKETS.get(last, 'Unsorted')}")
        sections.append(f"{m['mod_id']}|{m['mod_name']}|{m['category'] or ''}")
    lines = "\n".join(sections).strip()
    buckets = "\n".join(f"{n}. {label} — {BUCKET_HINTS[n]}" for n, label in BUCKETS.items())
    prompt = get_prompt().replace("{{BUCKETS}}", buckets).replace("{{MODS}}", lines)
    return _parse_reply(_call_claude(prompt, model))


# Second pass: only the mods the bulk pass flagged UNCERTAIN, with a cached
# Nexus summary as an extra signal -- kept as a separate, smaller prompt
# (not user-editable) since it runs on a handful of mods, not the library.
DESC_PROMPT = """You are placing a small set of Skyrim SE mods into MO2 left-panel
install-order groups (STEP SkyrimSE 2.3 scheme, top installed first, bottom
overwrites everything above). These mods could not be confidently classified
from name + Nexus category alone -- a short Nexus summary is included for
each; use it to decide.

Groups:
{{BUCKETS}}

Each line: mod_id|mod name|nexus category|nexus summary

Reply with ONLY plain lines, no prose, no code fences. One line per input mod:
<mod_id>|<bucket 1-20>
Append |UNCERTAIN only if the summary still doesn't make the group clear.

Mods:
{{MODS}}"""


def _run_claude_desc(mods, model="haiku"):
    lines = "\n".join(
        f"{m['mod_id']}|{m['mod_name']}|{m['category'] or ''}|{(m['description'] or '').strip()[:200]}"
        for m in mods
    )
    buckets = "\n".join(f"{n}. {label} — {BUCKET_HINTS[n]}" for n, label in BUCKETS.items())
    prompt = DESC_PROMPT.replace("{{BUCKETS}}", buckets).replace("{{MODS}}", lines)
    return _parse_reply(_call_claude(prompt, model))


def stop():
    """Kill a running claude refine. Returns error string or None."""
    proc = _proc
    if proc is None:
        return "no claude process running"
    proc.kill()
    return None


def _refine_job(model):
    order = [m for m in load_order()["mods"] if not m["locked"]]  # locked mods stay pinned
    state["phase"] = f"Asking Claude ({model}) to sort {len(order)} mods (may take a few minutes)"
    result = _run_claude(order, model)
    if len(result["order"]) < len(order) // 2:
        raise RuntimeError(f"reply only contained {len(result['order'])}/{len(order)} mods — order kept")
    known = {m["mod_id"] for m in order}
    before = {m["mod_id"]: m["bucket"] for m in order}
    state["phase"] = "Saving"
    with db.connect() as conn:
        ordered_ids = []
        for item in result["order"]:
            if item.get("id") not in known or item["id"] in ordered_ids:
                continue
            ordered_ids.append(item["id"])
            flags = [f for f in (item.get("f") or []) if f != "PATCH"]
            if item.get("b") != before[item["id"]]:
                # record the from->to buckets so the UI can label the change
                flags.append(f"MOVED:{before[item['id']]}>{item.get('b')}")
            _upsert_sort(conn, item["id"], item.get("b"), ",".join(flags))
        # mods claude dropped from the reply keep their relative order at the end
        ordered_ids += [m["mod_id"] for m in order if m["mod_id"] not in ordered_ids]
        _write_ranks(conn, ordered_ids)
        conn.execute(
            "INSERT OR REPLACE INTO meta VALUES ('conflict_notes', ?)",
            (json.dumps(result.get("conflicts") or []),),
        )
    state["phase"] = "Finished"


def start_llm_refine(model="haiku"):
    """Async LLM refinement. Returns error string or None (mirrors start_download)."""
    if model not in MODELS:
        return f"unknown model {model!r} — expected one of {MODELS}"
    if shutil.which("claude") is None:
        return "claude CLI not found — heuristic order kept"
    if not _lock.acquire(blocking=False):
        return "a sort job is already running"

    def runner():
        try:
            state.update({"error": None, "running": True})
            _refine_job(model)
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None


def _desc_refine_job(model):
    with db.connect() as conn:
        candidates = [dict(r) for r in conn.execute(
            "SELECT s.mod_id, m.mod_name, m.category, s.description, s.bucket AS cur_bucket,"
            " (SELECT game FROM mods m2 WHERE m2.mod_id = s.mod_id LIMIT 1) AS game"
            " FROM mod_sort s JOIN mods m ON m.mod_id = s.mod_id AND m.status = 'ok'"
            " WHERE s.flags LIKE '%UNCERTAIN%' AND COALESCE(s.desc_checked, 0) = 0"
            " AND COALESCE(s.locked, 0) = 0 GROUP BY s.mod_id"
        ).fetchall()]
    if not candidates:
        state["phase"] = "No uncertain mods need a description check"
        return

    missing = [c for c in candidates if not c["description"]]
    if missing:
        state["phase"] = f"Fetching Nexus summaries for {len(missing)} mod(s)"
        by_domain = {}
        for c in missing:
            by_domain.setdefault(c["game"], []).append(c)
        with db.connect() as conn:
            for domain, items in by_domain.items():
                if not domain:
                    continue
                summaries = nexus.fetch_summaries(domain, [c["mod_id"] for c in items])
                for c in items:
                    c["description"] = summaries.get(c["mod_id"]) or ""
                    conn.execute(
                        "UPDATE mod_sort SET description = ? WHERE mod_id = ?",
                        (c["description"], c["mod_id"]),
                    )

    state["phase"] = f"Asking Claude ({model}) about {len(candidates)} uncertain mod(s)"
    result = _run_claude_desc(candidates, model)
    replied = {item["id"]: item for item in result["order"]}

    state["phase"] = "Saving"
    with db.connect() as conn:
        for c in candidates:
            mod_id = c["mod_id"]
            item = replied.get(mod_id)
            if item and item.get("b") is not None:
                flags = [f for f in (item.get("f") or []) if f != "PATCH"]
                if item["b"] != c["cur_bucket"]:
                    _place_in_bucket(conn, mod_id, item["b"])
                _upsert_sort(conn, mod_id, item["b"], ",".join(flags))
            conn.execute("UPDATE mod_sort SET desc_checked = 1 WHERE mod_id = ?", (mod_id,))
    state["phase"] = "Finished"


def start_desc_refine(model="haiku"):
    """Second-pass refine: re-classifies only mods the bulk pass flagged
    UNCERTAIN, using a cached Nexus summary as extra signal. Every processed
    mod is marked desc_checked, even if it stays UNCERTAIN, so it is never
    re-sent (and its summary never re-fetched) on a later refine run."""
    if model not in MODELS:
        return f"unknown model {model!r} — expected one of {MODELS}"
    if shutil.which("claude") is None:
        return "claude CLI not found"
    if not _lock.acquire(blocking=False):
        return "a sort job is already running"

    def runner():
        try:
            state.update({"error": None, "running": True})
            _desc_refine_job(model)
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None
