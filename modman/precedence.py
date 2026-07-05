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

state = {"phase": "idle", "running": False, "error": None}
_lock = threading.Lock()

# conflicts/recommends/provides don't imply an order, only before/after/requires do
_ORDER_TYPES = ("before", "after", "requires")


def _edges():
    """{mod_id: set(mod_ids that must come before it)}, built from every
    synced collection's rules combined."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT type, source_mod_id, reference_mod_id FROM collection_mod_rules"
            f" WHERE type IN ({','.join('?' * len(_ORDER_TYPES))})", _ORDER_TYPES
        ).fetchall()
    must_precede = {}
    for r in rows:
        if r["type"] == "after":
            dependent, precedent = r["reference_mod_id"], r["source_mod_id"]
        else:  # before, requires: the reference is the precedent
            dependent, precedent = r["source_mod_id"], r["reference_mod_id"]
        must_precede.setdefault(dependent, set()).add(precedent)
    return must_precede


def enforce():
    """Reposition mods that violate a stored ordering rule. Returns the
    number of moves made. Caps total attempts so a cyclic/contradictory
    rule set can't loop forever -- a repeat violation on the same pair
    after one fix attempt is logged and dropped rather than retried."""
    must_precede = _edges()
    if not must_precede:
        state["phase"] = "No collection ordering rules to apply"
        return 0

    mods = order_store.load_order()["mods"]
    locked = {m["mod_id"] for m in mods if m["locked"]}
    pos = {m["mod_id"]: i for i, m in enumerate(mods)}

    fixed_once = set()
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
        if precedent in locked or violation in fixed_once:
            if violation in fixed_once:
                log.warning("dependency cycle/conflict involving mods %s and %s -- dropping", precedent, dependent)
            must_precede[dependent].discard(precedent)
            continue

        fixed_once.add(violation)
        state["phase"] = f"Repositioning mod {precedent} before {dependent}"
        order_store.move([precedent], pos[dependent] + 1)
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
            state["phase"] = f"Repositioned {n} mod(s)" if n else "Nothing to reposition"
        except Exception as e:
            state.update({"error": str(e), "phase": "Error"})
        finally:
            state["running"] = False
            _lock.release()

    threading.Thread(target=runner, daemon=True).start()
    return None
