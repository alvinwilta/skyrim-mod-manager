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

from . import db, order_store

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
        if r["type"] == "after":
            dependent, precedent = r["reference_mod_id"], r["source_mod_id"]
        else:  # before, requires: the reference is the precedent
            dependent, precedent = r["source_mod_id"], r["reference_mod_id"]
        must_precede.setdefault(dependent, set()).add(precedent)
        rule_type[(dependent, precedent)] = r["type"]
    return must_precede, rule_type


def enforce():
    """Reposition mods that violate a stored ordering rule. Returns the
    number of moves made, and fills state['log'] with one human-readable
    line per move/skip/drop -- locked-skips and cyclic drops used to be
    silent (python logger only); now they're visible in the UI too. Caps
    total attempts so a cyclic/contradictory rule set can't loop forever --
    a repeat violation on the same pair after one fix attempt is dropped
    rather than retried."""
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

    fixed_once = set()
    entries = []
    moves = 0
    max_attempts = max(10, sum(len(v) for v in must_precede.values()) * 3)
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
        if precedent in locked or violation in fixed_once:
            if violation in fixed_once:
                log.warning("dependency cycle/conflict involving mods %s and %s -- dropping", precedent, dependent)
                entries.append(
                    f"Dropped: '{name(precedent)}' vs '{name(dependent)}' ({rtype}) — "
                    "conflicts with another rule, left as-is"
                )
            else:
                entries.append(
                    f"Skipped: '{name(precedent)}' should be before '{name(dependent)}' ({rtype}) but is locked in place"
                )
            must_precede[dependent].discard(precedent)
            state["log"] = entries
            continue

        fixed_once.add(violation)
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
    if not _lock.acquire(blocking=False):
        return "an enforce pass is already running"

    def runner():
        try:
            state.update({"error": None, "running": True})
            n = enforce()
            skipped = sum(1 for e in state["log"] if e.startswith("Skipped"))
            dropped = sum(1 for e in state["log"] if e.startswith("Dropped"))
            bits = [f"{n} repositioned"] if n else []
            if skipped:
                bits.append(f"{skipped} skipped (locked)")
            if dropped:
                bits.append(f"{dropped} dropped (conflicting rule)")
            state["phase"] = ", ".join(bits) if bits else "Nothing to reposition"
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None
