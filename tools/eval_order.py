"""Ordering-engine eval harness: score the generated order against ground truth.

Copies the live mods.db to a scratch db (never touches live), runs the ordering
engine (modman.ordering.compute) on it, and scores the produced order against a
hand-tuned overwrite ground-truth file at repo-root `conflicting_mods_file.txt`
(top->bottom = low->high priority). Supply that file yourself; it is not shipped
with the repo.

Metrics:
  - conflict-pair agreement %: of GT mod pairs that are ALSO real file conflicts
    (share a Data path in the db), the fraction the engine places in the same
    relative order (base before overwriter). This is the number that matters --
    pairs where install order genuinely changes the game.
  - broad GT-pair agreement %: same, over ALL ordered GT pairs (not just real
    conflicts) -- noisier (cross-section pairs are trivially right via bands) but
    a sanity check that bands aren't globally inverted.
  - separator-membership: every matched GT mod's band vs a coarse expected band
    (informational; GT has no band labels, so this just surfaces UNSORTED tails).

Run: .venv/bin/python -m tools.eval_order   (from repo root)
     .venv/bin/python -m tools.eval_order --verbose   (list disagreements)
Read-only on the live db; writes only under the scratch dir.
"""

import os
import re
import shutil
import sqlite3
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE_DB = os.path.join(ROOT, "mods.db")
GT_FILE = os.path.join(ROOT, "conflicting_mods_file.txt")

sys.path.insert(0, ROOT)
from modman import ordering  # noqa: E402
from modman.conflicts import _MAX_SHARERS  # noqa: E402


def _norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _load_ground_truth(conn):
    """Parse conflicting_mods_file.txt into an ordered list of matched mod_ids
    (skipping [bracket] cluster labels). Returns (ordered_ids, unmatched_names)."""
    mods = conn.execute("SELECT mod_id, mod_name FROM mods WHERE status='ok'").fetchall()
    by_norm = {}
    for m in mods:
        by_norm.setdefault(_norm(m["mod_name"]), m["mod_id"])

    ordered, unmatched = [], []
    for line in open(GT_FILE):
        name = line.rstrip("\n")
        if not name.strip() or name.strip().startswith("["):
            continue
        n = _norm(name)
        mid = by_norm.get(n)
        if mid is None:  # loose substring fallback (guarded by length delta)
            for k, v in by_norm.items():
                if n and (n in k or k in n) and abs(len(n) - len(k)) < 8:
                    mid = v
                    break
        if mid is None:
            unmatched.append(name)
        else:
            ordered.append(mid)
    return ordered, unmatched


def _real_conflict_pairs(conn):
    """Set of {frozenset(a,b)} real file-overlap pairs (same cutoff as engine)."""
    rows = conn.execute(
        "WITH shared AS (SELECT mf.path FROM mod_files mf"
        " JOIN mods m ON m.file_id=mf.file_id AND m.status='ok'"
        " GROUP BY mf.path HAVING COUNT(DISTINCT m.mod_id) BETWEEN 2 AND ?)"
        " SELECT mf.path, m.mod_id FROM mod_files mf JOIN shared ON shared.path=mf.path"
        " JOIN mods m ON m.file_id=mf.file_id AND m.status='ok' GROUP BY mf.path, m.mod_id",
        (_MAX_SHARERS,),
    ).fetchall()
    by_path = {}
    for r in rows:
        by_path.setdefault(r["path"], []).append(r["mod_id"])
    pairs = set()
    for ids in by_path.values():
        ids = sorted(set(ids))
        if not (2 <= len(ids) <= _MAX_SHARERS):
            continue
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pairs.add((ids[i], ids[j]))
    return pairs


def _score(gt_ordered, engine_pos, restrict=None):
    """Fraction of ordered GT pairs (i before j) the engine keeps in order.
    restrict: if given, only pairs {a,b} in this set are scored."""
    ok = total = 0
    disagree = []
    for i in range(len(gt_ordered)):
        for j in range(i + 1, len(gt_ordered)):
            a, b = gt_ordered[i], gt_ordered[j]
            if a == b:
                continue
            key = (a, b) if a < b else (b, a)
            if restrict is not None and key not in restrict:
                continue
            total += 1
            # GT says a (earlier line) is lower priority -> engine must place a
            # before b (smaller rank)
            if engine_pos[a] < engine_pos[b]:
                ok += 1
            else:
                disagree.append((a, b))
    return ok, total, disagree


def main():
    verbose = "--verbose" in sys.argv
    scratch_dir = tempfile.mkdtemp(prefix="modman-eval-")
    scratch_db = os.path.join(scratch_dir, "mods.db")
    try:
        shutil.copy2(LIVE_DB, scratch_db)
        conn = sqlite3.connect(scratch_db)
        conn.row_factory = sqlite3.Row

        gt_ordered, unmatched = _load_ground_truth(conn)
        names = {
            r["mod_id"]: r["mod_name"]
            for r in conn.execute("SELECT mod_id, mod_name FROM mods WHERE status='ok'")
        }

        plan = ordering.compute(conn)
        engine_pos = {mid: i for i, mid in enumerate(plan["ordered_ids"])}
        band_of = plan["band_of"]

        real = _real_conflict_pairs(conn)
        gt_set = set(gt_ordered)
        real_gt = {p for p in real if p[0] in gt_set and p[1] in gt_set}

        ok_c, tot_c, dis_c = _score(gt_ordered, engine_pos, restrict=real_gt)
        ok_b, tot_b, dis_b = _score(gt_ordered, engine_pos)

        print(f"GT matched mods: {len(gt_ordered)}  unmatched: {len(unmatched)}")
        print(f"engine ordered:  {len(plan['ordered_ids'])} mods, {len(plan['pins'])} auto-pins")
        print()
        print(f"CONFLICT-PAIR agreement: {ok_c}/{tot_c} = "
              f"{100*ok_c/tot_c:.1f}%" if tot_c else "no real-conflict GT pairs")
        print(f"broad GT-pair agreement: {ok_b}/{tot_b} = {100*ok_b/tot_b:.1f}%")

        # unsorted-tail: GT mods that fell into NEW & UNSORTED (band mapping gap)
        unsorted = [m for m in gt_ordered if band_of.get(m) == ordering.separators.UNSORTED]
        if unsorted:
            print(f"\n{len(unsorted)} matched GT mods landed in NEW & UNSORTED "
                  f"(category->band gap):")
            for m in unsorted:
                print(f"    {names[m]}")

        if verbose:
            print(f"\n--- {len(dis_c)} conflict-pair DISAGREEMENTS "
                  f"(engine put overwriter before base) ---")
            for a, b in dis_c:
                print(f"  GT: {names[a]}  <  {names[b]}")
                print(f"      engine bands {band_of.get(a)} / {band_of.get(b)}, "
                      f"pos {engine_pos[a]} / {engine_pos[b]}")
        if unmatched:
            print(f"\n{len(unmatched)} unmatched GT names (not in library):")
            for n in unmatched:
                print(f"    {n}")
    finally:
        shutil.rmtree(scratch_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
