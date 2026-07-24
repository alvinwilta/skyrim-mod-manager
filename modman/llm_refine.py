"""Claude-CLI-backed install-order refine over the separator bands.

The deterministic engine (`ordering.py`) already bands + orders every mod. This
pass shells out to the Claude Code CLI (`claude -p`, local login, no API key) to
fix the *ambiguous tail*: mods whose Nexus category is blank or unmapped, so the
engine could only place them by a keyword guess. It re-assigns those to a
separator BAND and emits conflict/duplicate notes.

Two tiers, cheap-first:
  1. bulk pass  (`start_llm_refine`) -- every uncertain-tail mod, name + category
     only. Resolves most; flags the genuinely-unclear UNCERTAIN.
  2. desc pass  (`start_desc_refine`) -- only the mods still UNCERTAIN, with a
     cached Nexus summary as extra signal (Nexus mods only; adopted negative-id
     mods have no summary to fetch).

Runs in a background thread with progress in `state`, mirroring the download
engine. The prompt is editable (meta key `sort_prompt`); placeholders
{{BANDS}}/{{CONFLICTS}}/{{MODS}} are filled per run.
"""

import json
import logging
import re
import shutil
import subprocess
import threading

from . import conflicts, db, jobs, nexus, order_store, rules, separators

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None, "job": None}  # job: 'bulk' | 'desc'
_lock = threading.Lock()
jobs.register("sort refine", state)
_proc = None  # running claude subprocess, for the force-stop endpoint
MODELS = ("haiku", "sonnet", "opus")


# {{BANDS}}, {{CONFLICTS}} and {{MODS}} are replaced before the call; the edited
# copy lives in the meta table (key 'sort_prompt') when the user changes it.
DEFAULT_PROMPT = """You are a Skyrim SE mod install-order sorter for the Mod Organizer 2
left panel (top installed first, bottom = highest priority / overwrites
everything above). Mods are grouped into numbered separator BANDS; band order is
the overwrite order, so a band's files overwrite every band above it, and a
compatibility patch overwrites everything it patches.

Assign each mod to ONE band from this list (id. name). Pick the band that fits
the mod's primary function:
{{BANDS}}

Guidance:
- Classify strictly by the mod's FUNCTIONAL role (what it changes in-game).
  Ignore its theme or subject matter — only the function decides the band.
- Script extenders, engine/core frameworks, and libraries other mods depend on
  go in the earliest (lowest-id) bands so they load first.
- Textures/meshes and world/asset mods sit in the middle; the things that must
  win — compatibility patches, fixes, LOD/late tools, post-processing — go in
  the latest (highest-id) bands.
- A mod's primary function decides its band when several could apply.
- The Nexus category is a hint only and is often blank or wrong.

Known file conflicts (ground truth: these archives were actually inspected and
share real file paths — not a guess). Use these; you may still flag a CONFLICT
if you're separately confident of a real incompatibility:
{{CONFLICTS}}

Each mod below is shown under its CURRENT band heading — a heuristic guess. Most
may already be right. Each line: mod_id|mod name|nexus category.

Reply with ONLY corrections — one line per mod whose band should change from the
heading it is shown under. Do NOT list a mod that is already correctly placed:
omitting a mod means "leave it where the heading shows it." No prose, no code
fences. Format:
<mod_id>|<band id from the list above>
Append |<flags> only when flagged (comma-separated). Allowed flags:
UNCERTAIN, CONFLICT:<mod_id it conflicts with>, DUPLICATE:<mod_id it duplicates>
Then, if any mods conflict or duplicate, a final section:
CONFLICTS:
<mod_id A> (<name A>) vs <mod_id B> (<name B>): <which should win and why>
DUPLICATE: <mod_id A> (<name A>) vs <mod_id B> (<name B>): <why they're the same mod, which to keep>
Use DUPLICATE when two entries are likely THE SAME mod under a different name or
rerelease ("X" vs "X NG", "X SE" vs "X AE", "X Redux", an author's old version
next to their replacement). Use plain CONFLICT for genuinely different mods that
merely share files.
If nothing needs correcting, reply with just the CONFLICTS section, or nothing.

Mods:
{{MODS}}"""


# Second pass: only the mods the bulk pass flagged UNCERTAIN, with a cached
# Nexus summary as an extra signal -- a separate, smaller, non-editable prompt.
DESC_PROMPT = """You are placing a small set of Skyrim SE mods into Mod Organizer 2
left-panel install-order BANDS (top installed first, bottom overwrites above).
These could not be confidently placed from name + Nexus category alone — a short
Nexus summary is included; use it to decide. Classify strictly by the mod's
functional role; ignore its theme or subject matter.

Bands (id. name), earliest loads first:
{{BANDS}}

Each line: mod_id|mod name|nexus category|nexus summary

Reply with ONLY plain lines, no prose, no code fences. One line per input mod:
<mod_id>|<band id from the list above>
Append |UNCERTAIN only if the summary still doesn't make the band clear.

Mods:
{{MODS}}"""


def _valid_flag(flag):
    """Only persist flags the UI understands and clear_flags can strip: UNCERTAIN,
    DUPLICATE:<mod_id>. The old CONFLICT tag was dropped — real file-overlap
    overwrite data (conflicts.relations) replaces the LLM's conflict guess — so a
    CONFLICT flag is no longer persisted."""
    if flag == "UNCERTAIN":
        return True
    kind, _, arg = flag.partition(":")
    return kind == "DUPLICATE" and arg.strip().lstrip("-").isdigit()


def _parse_reply(text, valid=None):
    """Parse the line-based reply: 'id|band[|flags]' rows, then an optional
    CONFLICTS: section. Line format keeps the reply ~3x smaller than JSON, which
    dominates the runtime. Non-matching lines are skipped.

    Validation boundary for everything the LLM writes into mod_sort: when `valid`
    (the set of assignable separator ids) is given, a band the model invents that
    isn't a real assignable band is dropped here — kept out of separator_id so it
    can never strand a mod on a nonexistent band. Flags are whitelisted for the
    same reason. `valid=None` keeps any integer band (used by unit tests)."""
    text = re.sub(r"^```\w*|```$", "", text.strip(), flags=re.M).strip()
    order, conflict_lines, in_conflicts = [], [], False
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.upper().rstrip(":").endswith("CONFLICTS"):
            in_conflicts = True
            continue
        if in_conflicts:
            # a well-formed line always names at least one mod id; a bare
            # "DUPLICATE:"/"CONFLICT:" with nothing after it (seen when the reply
            # is cut off mid-generation) would otherwise render as a blank bullet
            if re.search(r"\d", line) and line.rstrip(":").strip():
                conflict_lines.append(line)
            continue
        parts = [p.strip() for p in line.split("|")]
        # lstrip('-'): adopted local mods carry NEGATIVE ids and appear in replies
        if not parts[0].lstrip("-").isdigit():
            continue
        item = {"id": int(parts[0])}
        if len(parts) > 1 and parts[1].lstrip("-").isdigit():
            band = int(parts[1])
            if valid is None or band in valid:
                item["b"] = band
        if len(parts) > 2:
            item["f"] = [f.strip() for f in parts[2].split(",") if f.strip() and _valid_flag(f.strip())]
        order.append(item)
    return {"order": order, "conflicts": conflict_lines}


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


def _call_claude(prompt, model):
    global _proc
    _proc = subprocess.Popen(
        # --no-session-persistence: throwaway one-shot prompts, don't pollute the
        # user's `claude` session history / resume picker with them.
        ["claude", "-p", prompt, "--model", model, "--output-format", "json", "--no-session-persistence"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        # 1800s: the bulk pass can send a few hundred tail mods in one prompt and
        # haiku generating that much output can exceed a smaller budget.
        out, err = _proc.communicate(timeout=1800)
        code = _proc.returncode
    except subprocess.TimeoutExpired:
        # kill before clearing _proc: leaving the child alive would keep claude
        # burning usage with the stop endpoint already reporting "no process"
        _proc.kill()
        _proc.communicate()
        raise RuntimeError("claude timed out after 1800s")
    finally:
        _proc = None
    if code != 0:
        if code < 0:
            raise RuntimeError("stopped by user")
        raise RuntimeError(f"claude exited {code}: {err.strip()[:200]}")
    return json.loads(out).get("result", "")


def _assignable_bands(conn):
    """{id: label} for every band a mod may be assigned to: leaf bands only
    (special_kind IS NULL). Excludes section headers, ROOT, TOOL OUTPUTS, NEW &
    UNSORTED, STORAGE, DLC — none of which are category-assignable content bands."""
    return {
        r["id"]: r["name"]
        for r in conn.execute(
            "SELECT id, name FROM separator WHERE special_kind IS NULL ORDER BY id"
        )
    }


def _bands_text(bands):
    return "\n".join(f"{bid}. {label}" for bid, label in bands.items())


def _uncertain_tail(conn):
    """The mods this refine targets: status ok, unlocked, and lacking a usable
    Nexus category (blank, or a category the engine's map doesn't cover) — the
    only mods the deterministic engine had to *guess* a band for. Returns dicts
    with the current separator band so the prompt can show each under its guess."""
    rows = conn.execute(
        "SELECT m.mod_id, m.mod_name, m.category, s.separator_id, COALESCE(s.locked, 0) AS locked"
        " FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
        " WHERE m.status = 'ok' GROUP BY m.mod_id"
    ).fetchall()
    out = []
    for r in rows:
        if r["locked"]:
            continue
        cat = (r["category"] or "").strip()
        if cat and cat in rules.CATEGORY_BAND:
            continue  # confident placement — leave to the engine
        out.append(dict(r))
    return out


def _run_claude(mods, bands, model="haiku"):
    """Bulk pass: list each uncertain mod under its current band heading, ask for
    band corrections. `bands` = {id: label} assignable set (also the validator)."""
    band_label = dict(bands)
    mods = sorted(mods, key=lambda m: (m["separator_id"] or 0))
    sections, last = [], object()
    for m in mods:  # sorted, so same-band mods form contiguous runs
        if m["separator_id"] != last:
            last = m["separator_id"]
            sections.append(f"\n# {last}. {band_label.get(last, 'Unsorted')}")
        sections.append(f"{m['mod_id']}|{m['mod_name']}|{m['category'] or ''}")
    lines = "\n".join(sections).strip()
    known_conflicts = conflicts.summary_for([m["mod_id"] for m in mods]) or "(none scanned yet)"
    prompt = (
        get_prompt().replace("{{BANDS}}", _bands_text(bands))
        .replace("{{CONFLICTS}}", known_conflicts)
        .replace("{{MODS}}", lines)
    )
    return _parse_reply(_call_claude(prompt, model), valid=set(bands))


def _run_claude_desc(mods, bands, model="haiku"):
    lines = "\n".join(
        f"{m['mod_id']}|{m['mod_name']}|{m['category'] or ''}|{(m['description'] or '').strip()[:200]}"
        for m in mods
    )
    prompt = DESC_PROMPT.replace("{{BANDS}}", _bands_text(bands)).replace("{{MODS}}", lines)
    return _parse_reply(_call_claude(prompt, model), valid=set(bands))


def _apply_band_corrections(conn, corrections, valid):
    """Persist a sparse list of band corrections ({'id','b','f'} dicts) as
    separator_id + flags on `conn`. Only mods named here are touched. Re-checks
    the lock at APPLY time (a lock set during the minutes-long LLM call must win).
    Does NOT re-rank — the caller runs `order_store.rerank_by_separator()` after
    this transaction commits (it opens its own connection under `_rank_lock`, so
    calling it while `conn`'s write txn is open would self-deadlock on sqlite).
    Returns count of band changes applied (0 => caller can skip the rerank)."""
    seen, applied = set(), 0
    for item in corrections:
        mid = item["id"]
        if mid in seen:
            continue
        seen.add(mid)
        band = item.get("b")
        flags = ",".join(item.get("f") or [])
        cur = conn.execute(
            "SELECT COALESCE(locked, 0) AS locked FROM mod_sort WHERE mod_id = ?",
            (mid,),
        ).fetchone()
        if cur is not None and cur["locked"]:
            continue
        # band change (validated) and/or a flag update; skip an invalid band
        if band is not None and band in valid:
            conn.execute(
                "INSERT INTO mod_sort (mod_id, separator_id, flags) VALUES (?, ?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET separator_id = excluded.separator_id,"
                " flags = excluded.flags",
                (mid, band, flags),
            )
            applied += 1
        elif flags:  # e.g. UNCERTAIN with no confident band — record for pass 2
            conn.execute(
                "INSERT INTO mod_sort (mod_id, flags) VALUES (?, ?)"
                " ON CONFLICT(mod_id) DO UPDATE SET flags = excluded.flags",
                (mid, flags),
            )
    return applied


def stop():
    """Kill a running claude refine. Returns error string or None."""
    proc = _proc
    if proc is None:
        return "no claude process running"
    proc.kill()
    return None


def _refine_job(model):
    with db.connect() as conn:
        bands = _assignable_bands(conn)
        tail = _uncertain_tail(conn)
    if not tail:
        state["phase"] = "No uncertain mods to refine — the engine placed everything confidently"
        return
    state["phase"] = f"Asking Claude ({model}) to band {len(tail)} uncertain mod(s) (may take a few minutes)"
    result = _run_claude(tail, bands, model)
    known = {m["mod_id"] for m in tail}
    before = {m["mod_id"]: m["separator_id"] for m in tail}

    corrections = []
    for item in result["order"]:
        mid = item.get("id")
        if mid not in known:
            continue
        band = item.get("b")
        if band is not None and band != before.get(mid):
            item["f"] = [f for f in (item.get("f") or []) if not f.startswith("MOVED")]
            item["f"].append(f"MOVED:{before.get(mid)}>{band}")
        corrections.append(item)

    state["phase"] = f"Saving {len(corrections)} correction(s)"
    with db.connect() as conn:
        applied = _apply_band_corrections(conn, corrections, set(bands))
        conn.execute(
            "INSERT OR REPLACE INTO meta VALUES ('conflict_notes', ?)",
            (json.dumps(result.get("conflicts") or []),),
        )
    if applied:
        order_store.rerank_by_separator()  # re-group ranks into the new bands
    state["phase"] = "Finished"


def start_llm_refine(model="haiku"):
    """Async band refine over the uncertain tail. Returns error string or None
    (mirrors start_download)."""
    if model not in MODELS:
        return f"unknown model {model!r} — expected one of {MODELS}"
    if shutil.which("claude") is None:
        return "claude CLI not found — engine order kept"
    return jobs.start(_lock, state, "a sort job is already running",
                      lambda: _refine_job(model), init={"job": "bulk"},
                      exclusive_as="sort refine")


def _desc_refine_job(model):
    with db.connect() as conn:
        bands = _assignable_bands(conn)
        candidates = [dict(r) for r in conn.execute(
            "SELECT s.mod_id, m.mod_name, m.category, s.description, s.separator_id,"
            " (SELECT game FROM mods m2 WHERE m2.mod_id = s.mod_id LIMIT 1) AS game"
            " FROM mod_sort s JOIN mods m ON m.mod_id = s.mod_id AND m.status = 'ok'"
            " WHERE s.flags LIKE '%UNCERTAIN%' AND COALESCE(s.desc_checked, 0) = 0"
            " AND COALESCE(s.locked, 0) = 0 AND s.mod_id > 0 GROUP BY s.mod_id"
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
        for domain, items in by_domain.items():
            if not domain:
                continue
            # fetch OUTSIDE the write transaction: holding sqlite's write lock
            # across a 30s GraphQL call starves any concurrent writer
            summaries = nexus.fetch_summaries(domain, [c["mod_id"] for c in items])
            with db.connect() as conn:
                for c in items:
                    c["description"] = summaries.get(c["mod_id"]) or ""
                    conn.execute(
                        "UPDATE mod_sort SET description = ? WHERE mod_id = ?",
                        (c["description"], c["mod_id"]),
                    )

    state["phase"] = f"Asking Claude ({model}) about {len(candidates)} uncertain mod(s)"
    result = _run_claude_desc(candidates, bands, model)
    known = {c["mod_id"] for c in candidates}
    corrections = [item for item in result["order"] if item.get("id") in known and item.get("b") is not None]

    state["phase"] = "Saving"
    with db.connect() as conn:
        applied = _apply_band_corrections(conn, corrections, set(bands))
        # every candidate is marked checked regardless of outcome (corrected,
        # confirmed, or dropped) so it's never re-sent — nor its summary re-fetched
        for c in candidates:
            conn.execute("UPDATE mod_sort SET desc_checked = 1 WHERE mod_id = ?", (c["mod_id"],))
    if applied:
        order_store.rerank_by_separator()
    state["phase"] = "Finished"


def start_desc_refine(model="haiku"):
    """Second-pass refine: re-bands only mods the bulk pass flagged UNCERTAIN,
    using a cached Nexus summary as extra signal. Every processed mod is marked
    desc_checked, even if it stays UNCERTAIN, so it is never re-sent (nor its
    summary re-fetched) on a later refine run."""
    if model not in MODELS:
        return f"unknown model {model!r} — expected one of {MODELS}"
    if shutil.which("claude") is None:
        return "claude CLI not found"
    return jobs.start(_lock, state, "a sort job is already running",
                      lambda: _desc_refine_job(model), init={"job": "desc"},
                      exclusive_as="sort refine")
