"""Claude-CLI-backed install-order refine: shells out to the Claude Code CLI
(`claude -p`, uses the local login, no API key) to re-rank misfits and emit
conflict notes. Two passes -- a bulk pass over every unlocked mod, and a
second pass limited to mods the bulk pass flagged UNCERTAIN, using a cached
Nexus summary as extra signal. Runs in a background thread with progress in
`state`, mirroring the download engine."""

import json
import logging
import re
import shutil
import subprocess
import threading

from . import buckets, conflicts, db, jobs, nexus, order_store

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None, "job": None}  # job: 'bulk' | 'desc'
_lock = threading.Lock()
jobs.register("sort refine", state)
_proc = None  # running claude subprocess, for the force-stop endpoint
MODELS = ("haiku", "sonnet", "opus")

BUCKETS = buckets.BUCKETS
BUCKET_HINTS = buckets.BUCKET_HINTS

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

Known file conflicts (ground truth: these mods' archives were actually
inspected and share real file paths — not a guess). Use these instead of
inventing your own; you may still flag a mod CONFLICT if you're separately
confident of a real incompatibility, but prefer this list:
{{CONFLICTS}}

The mods below are listed under their current group heading — a heuristic
guess. Most are already right. Each line: mod_id|mod name|nexus category.

Reply with ONLY corrections — one line per mod whose group should change
from the heading it's shown under. Do NOT list a mod that's already
correctly placed: omitting a mod means "leave it exactly where the
heading shows it." No prose, no code fences. Format:
<mod_id>|<correct bucket 1-20>
Append |<flags> only when flagged (comma-separated). Allowed flags:
UNCERTAIN, CONFLICT:<mod_id of the mod it conflicts with>,
DUPLICATE:<mod_id of the mod it's a duplicate of>
Then, if any mods conflict or duplicate, a final section:
CONFLICTS:
<mod_id A> (<name A>) vs <mod_id B> (<name B>): <which should win and why>
DUPLICATE: <mod_id A> (<name A>) vs <mod_id B> (<name B>): <why they're the same mod, which to keep>
Use the DUPLICATE flag/line specifically when two entries are likely THE
SAME mod under a different name or rerelease (e.g. "X" vs "X NG", "X SE" vs
"X AE", "X Redux", an author's old version next to their replacement) —
that's a real duplicate-install problem the user should resolve, not an
install-order conflict. Use plain CONFLICT for mods that merely share files
or don't play well together but are genuinely different mods.
If nothing needs correcting, reply with just the CONFLICTS section, or
nothing at all.

Mods:
{{MODS}}"""


def _valid_flag(flag):
    """Only persist flags the UI understands and clear_flags can strip:
    UNCERTAIN, CONFLICT:<mod_id>, DUPLICATE:<mod_id>. Anything else the model
    invents would be stored verbatim and stuck (unclearable) forever."""
    if flag == "UNCERTAIN":
        return True
    kind, _, arg = flag.partition(":")
    return kind in ("CONFLICT", "DUPLICATE") and arg.strip().lstrip("-").isdigit()


def _parse_reply(text):
    """Parse the line-based reply: 'id|bucket[|flags]' rows, then an optional
    CONFLICTS: section. Line format keeps the reply ~3x smaller than JSON,
    which is what dominates the runtime. Non-matching lines are skipped.

    Validation boundary for everything the LLM writes into mod_sort: a bucket
    outside the real 1-20 STEP scheme (verified: both STEP 2.3 and 3.0 have
    exactly groups 02-21) is a hallucination — dropping it here keeps it out
    of bucket AND expected_bucket, where the drift check could never flag it
    (expected == actual). Flags are whitelisted for the same reason."""
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
            # "DUPLICATE:"/"CONFLICT:" with nothing after it (seen when the
            # reply gets cut off mid-generation on large libraries) would
            # otherwise render as a blank bullet in the UI
            if re.search(r"\d", line) and line.rstrip(":").strip():
                conflict_lines.append(line)
            continue
        parts = [p.strip() for p in line.split("|")]
        # lstrip('-'): adopted local mods carry NEGATIVE ids and appear in replies too
        if not parts[0].lstrip("-").isdigit():
            continue
        item = {"id": int(parts[0])}
        if len(parts) > 1 and parts[1].isdigit() and int(parts[1]) in BUCKETS:
            item["b"] = int(parts[1])
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
        # --no-session-persistence: these are throwaway one-shot prompts, don't
        # pollute the user's `claude` session history / resume picker with them.
        ["claude", "-p", prompt, "--model", model, "--output-format", "json", "--no-session-persistence"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        # 1800s: bulk pass on a large library (800+ mods) sends every mod in
        # one prompt/reply, and haiku generating that much output can exceed
        # the old 600s budget on a healthy, non-stuck run.
        out, err = _proc.communicate(timeout=1800)
        code = _proc.returncode
    except subprocess.TimeoutExpired:
        # kill before clearing _proc: leaving the child alive would keep
        # claude burning usage with the stop endpoint already reporting
        # "no claude process running"
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


BUCKET_LIST = "\n".join(f"{n}. {label} — {BUCKET_HINTS[n]}" for n, label in BUCKETS.items())


def _run_claude(mods, model="haiku"):
    sections, last = [], object()
    for m in mods:  # mods arrive ordered, so buckets form contiguous runs
        if m["bucket"] != last:
            last = m["bucket"]
            sections.append(f"\n# {last}. {BUCKETS.get(last, 'Unsorted')}")
        sections.append(f"{m['mod_id']}|{m['mod_name']}|{m['category'] or ''}")
    lines = "\n".join(sections).strip()
    known_conflicts = conflicts.summary_for([m["mod_id"] for m in mods]) or "(none scanned yet)"
    prompt = (
        get_prompt().replace("{{BUCKETS}}", BUCKET_LIST)
        .replace("{{CONFLICTS}}", known_conflicts)
        .replace("{{MODS}}", lines)
    )
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
    prompt = DESC_PROMPT.replace("{{BUCKETS}}", BUCKET_LIST).replace("{{MODS}}", lines)
    return _parse_reply(_call_claude(prompt, model))


def stop():
    """Kill a running claude refine. Returns error string or None."""
    proc = _proc
    if proc is None:
        return "no claude process running"
    proc.kill()
    return None


# A well-behaved sparse reply corrects a small fraction of what it's shown
# ("most are already right"). A reply correcting more than this is treated
# as a full reorder in disguise and rejected outright -- a structural
# backstop on top of the sparse-diff protocol itself, not a substitute for
# it: mods the model never mentions are never rewritten, full stop.
_MAX_CORRECTION_RATIO = 0.4


def _refine_job(model):
    order = [m for m in order_store.load_order()["mods"] if not m["locked"]]  # locked mods stay pinned
    state["phase"] = f"Asking Claude ({model}) to review {len(order)} mods (may take a few minutes)"
    result = _run_claude(order, model)
    known = {m["mod_id"] for m in order}
    before = {m["mod_id"]: m["bucket"] for m in order}

    corrections, seen = [], set()
    for item in result["order"]:
        mod_id = item.get("id")
        if mod_id not in known or mod_id in seen or item.get("b") is None:
            continue
        seen.add(mod_id)
        if item["b"] != before[mod_id]:
            # record the from->to buckets so the UI can label the change
            item["f"] = [f for f in (item.get("f") or []) if not f.startswith("MOVED")]
            item["f"].append(f"MOVED:{before[mod_id]}>{item['b']}")
        corrections.append(item)

    if order and len(corrections) > len(order) * _MAX_CORRECTION_RATIO:
        raise RuntimeError(
            f"Claude tried to correct {len(corrections)}/{len(order)} mods (>{_MAX_CORRECTION_RATIO:.0%})"
            " — looks like a full reorder rather than a sparse correction; rejected so the existing"
            " heuristic/previous order is kept untouched"
        )

    state["phase"] = f"Saving {len(corrections)} correction(s)"
    with db.connect() as conn:
        order_store.apply_corrections(conn, corrections)
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
    return jobs.start(_lock, state, "a sort job is already running",
                      lambda: _refine_job(model), init={"job": "bulk"},
                      exclusive_as="sort refine")


def _desc_refine_job(model):
    with db.connect() as conn:
        candidates = [dict(r) for r in conn.execute(
            "SELECT s.mod_id, m.mod_name, m.category, s.description, s.bucket AS cur_bucket,"
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
    result = _run_claude_desc(candidates, model)
    known = {c["mod_id"] for c in candidates}
    corrections = [item for item in result["order"] if item.get("id") in known and item.get("b") is not None]

    state["phase"] = "Saving"
    with db.connect() as conn:
        order_store.apply_corrections(conn, corrections)
        # every candidate is marked checked regardless of outcome (corrected,
        # confirmed unchanged, or dropped from the reply) so it's never
        # re-sent -- and its summary never re-fetched -- on a later run
        for c in candidates:
            conn.execute("UPDATE mod_sort SET desc_checked = 1 WHERE mod_id = ?", (c["mod_id"],))
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
    return jobs.start(_lock, state, "a sort job is already running",
                      lambda: _desc_refine_job(model), init={"job": "desc"},
                      exclusive_as="sort refine")
