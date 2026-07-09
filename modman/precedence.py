"""Real per-collection curated ordering rules -- before/after/requires from
collection_mod_rules (see modman/collection_rules.py) -- applied as a final
position-adjustment pass on top of whatever heuristic/LLM order already
exists. Deliberately last in the pipeline and deliberately minimal: only
mods actually named in a violated rule ever get repositioned, reusing
order_store.move() (which also means the moved mod adopts its new
neighbor's bucket -- a side effect that's fine specifically because this
pass runs last, not before heuristic/LLM bucket assignment; check_order()
will surface the resulting bucket/expected_bucket drift, which is
informational here, not a bug to auto-correct)."""

import logging
import threading

from . import db, jobs, order_store

log = logging.getLogger(__name__)

state = {"phase": "idle", "running": False, "error": None, "log": []}
_lock = threading.Lock()


def _edges():
    """{mod_id: set(mod_ids that must come before it)}, built from every
    *enabled* collection's rules combined -- toggling a collection off in
    the Collections tab excludes its rules here without touching its
    provenance links or stored rules. Also returns the rule type behind
    each (dependent, precedent) pair, purely for the human-readable log."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.type, r.source_mod_id, r.reference_mod_id FROM collection_mod_rules r"
            " JOIN collections c ON c.id = r.collection_id"
            f" WHERE c.enabled = 1 AND r.type IN ({','.join('?' * len(db.ORDER_RULE_TYPES))})",
            db.ORDER_RULE_TYPES,
        ).fetchall()
    must_precede, rule_type = {}, {}
    for r in rows:
        if r["type"] == "before":
            dependent, precedent = r["reference_mod_id"], r["source_mod_id"]
        else:  # after, requires: the reference is the precedent
            dependent, precedent = r["source_mod_id"], r["reference_mod_id"]
        must_precede.setdefault(dependent, set()).add(precedent)
        rule_type[(dependent, precedent)] = r["type"]
    return must_precede, rule_type


def _on_cycle(dependent, precedent, must_precede):
    """True when the rule 'precedent before dependent' lies on a directed
    cycle, i.e. some chain of other rules also forces dependent before
    precedent -- genuinely unsatisfiable, so the rule should be dropped.
    A pair merely re-broken by another rule's move is NOT on a cycle and
    can simply be fixed again."""
    forward = {}  # X -> mods that X must precede
    for dep, precs in must_precede.items():
        for p in precs:
            forward.setdefault(p, set()).add(dep)
    stack, seen = [dependent], set()
    while stack:
        node = stack.pop()
        if node == precedent:
            return True
        if node in seen:
            continue
        seen.add(node)
        stack.extend(forward.get(node, ()))
    return False


def enforce():
    """Reposition mods that violate a stored ordering rule. Returns the
    number of moves made, and fills state['log'] with one human-readable
    line per move/skip/drop so they're visible in the UI.

    A pair is re-fixed when a later rule's move legitimately re-breaks it
    (chained before/after rules are the normal case in manifests); only a
    pair on an actual rule cycle -- or one still thrashing after a generous
    retry cap, the backstop for a contradiction the cycle check can't see --
    is dropped. max_attempts caps the whole pass regardless."""
    must_precede, rule_type = _edges()
    state["log"] = []
    if not must_precede:
        state["phase"] = "No collection ordering rules to apply"
        return 0

    mods = order_store.load_order()["mods"]
    names = {m["mod_id"]: m["mod_name"] for m in mods}
    locked = {m["mod_id"] for m in mods if m["locked"]}
    pos = {m["mod_id"]: i for i, m in enumerate(mods)}
    name = lambda mid: names.get(mid, f"mod {mid}")

    n_edges = sum(len(v) for v in must_precede.values())
    fix_counts = {}
    max_fixes_per_pair = max(5, n_edges)
    entries = []
    moves = 0
    max_attempts = max(10, n_edges * n_edges * 3)
    for _ in range(max_attempts):
        violation = None
        for dependent, precedents in must_precede.items():
            if dependent not in pos:
                continue
            for precedent in precedents:
                if precedent in pos and pos[precedent] > pos[dependent]:
                    violation = (precedent, dependent)
                    break
            if violation:
                break
        if not violation:
            break

        precedent, dependent = violation
        rtype = rule_type.get((dependent, precedent), "?")
        exhausted = fix_counts.get(violation, 0) >= max_fixes_per_pair
        if precedent in locked or exhausted or (
            fix_counts.get(violation) and _on_cycle(dependent, precedent, must_precede)
        ):
            if precedent in locked:
                entries.append(
                    f"Skipped: '{name(precedent)}' should be before '{name(dependent)}' ({rtype}) but is locked in place"
                )
            else:
                log.warning("dependency cycle/conflict involving mods %s and %s -- dropping", precedent, dependent)
                entries.append(
                    f"Dropped: '{name(precedent)}' vs '{name(dependent)}' ({rtype}) — "
                    "conflicts with another rule, left as-is"
                )
            must_precede[dependent].discard(precedent)
            state["log"] = entries
            continue

        fix_counts[violation] = fix_counts.get(violation, 0) + 1
        state["phase"] = f"Repositioning '{name(precedent)}' before '{name(dependent)}'"
        order_store.move([precedent], pos[dependent] + 1)
        entries.append(f"Moved '{name(precedent)}' to just before '{name(dependent)}' ({rtype})")
        state["log"] = entries
        moves += 1
        mods = order_store.load_order()["mods"]
        pos = {m["mod_id"]: i for i, m in enumerate(mods)}

    return moves


def start_enforce():
    """Async ordering-rule enforcement. Returns error string or None (mirrors start_download)."""

    def work():
        n = enforce()
        skipped = sum(1 for e in state["log"] if e.startswith("Skipped"))
        dropped = sum(1 for e in state["log"] if e.startswith("Dropped"))
        bits = [f"{n} repositioned"] if n else []
        if skipped:
            bits.append(f"{skipped} skipped (locked)")
        if dropped:
            bits.append(f"{dropped} dropped (conflicting rule)")
        return ", ".join(bits) if bits else "Nothing to reposition"

    return jobs.start(_lock, state, "an enforce pass is already running", work)
