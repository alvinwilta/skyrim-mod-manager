"""Editable ordering rules, loaded from ``order_rules.toml``.

Externalizes the four tunable tables the ordering engine consults: the
Nexus-category -> band map, the keyword-bucket fallback, the forced head-priority
mod ids, and the keyword classification rules. Kept a dependency-free LEAF module
(imports nothing from the rest of the package) so both ``separators`` and
``ordering`` can import it without a cycle.

The public tables are module-level *containers mutated in place* by ``reload()``
(never rebound), so a caller that did ``from . import rules`` and reads
``rules.CATEGORY_BAND`` -- or aliased it once (``CATEGORY_SEPARATOR =
rules.CATEGORY_BAND``) -- always sees the current values after a reload.
``ordering.compute`` calls ``reload()`` on every run, so editing the TOML takes
effect without restarting the backend.
"""

import re
import tomllib
from pathlib import Path

_RULES_FILE = Path(__file__).parent.parent / "data" / "order_rules.toml"

# within-band position keywords -> the engine's POS_TOP/MID/BOTTOM ints
_POS = {"top": 0, "mid": 1, "bottom": 2}

# Public tables (mutated in place by reload(), never rebound).
CATEGORY_BAND = {}       # {category name: band id}
BUCKET_BAND = {}         # {STEP bucket int: band id}
HEAD_PRIORITY_IDS = []   # [mod_id, ...] forced to the top, in order
RULES = []               # [(parents|None, pos int, band int, compiled regex), ...]


class RulesError(ValueError):
    """Raised when order_rules.toml is malformed -- surfaced instead of a bare
    KeyError/regex error so a typo in the file names itself."""


def _load():
    try:
        with open(_RULES_FILE, "rb") as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise RulesError(f"cannot read {_RULES_FILE.name}: {e}") from e

    category = {str(k): int(v) for k, v in data.get("category", {}).items()}
    # bucket keys are TOML strings ("1".."20"); the engine keys by int bucket
    bucket = {int(k): int(v) for k, v in data.get("bucket", {}).items()}
    head = [int(x) for x in data.get("head", [])]

    rules = []
    for i, r in enumerate(data.get("rules", [])):
        try:
            parents_raw = r["parents"]
            parents = None if parents_raw == "*" else frozenset(int(p) for p in parents_raw)
            pos = _POS[str(r.get("pos", "mid")).lower()]
            band = int(r["band"])
            rx = re.compile(r["re"], re.I)
        except (KeyError, ValueError, re.error) as e:
            raise RulesError(f"rule #{i + 1} in {_RULES_FILE.name} is invalid: {e}") from e
        rules.append((parents, pos, band, rx))
    return category, bucket, head, rules


def reload():
    """Re-read the TOML and update the public tables IN PLACE (so existing
    aliases stay valid). Returns nothing; raises RulesError on a bad file."""
    category, bucket, head, rules = _load()
    CATEGORY_BAND.clear()
    CATEGORY_BAND.update(category)
    BUCKET_BAND.clear()
    BUCKET_BAND.update(bucket)
    HEAD_PRIORITY_IDS[:] = head
    RULES[:] = rules


reload()
