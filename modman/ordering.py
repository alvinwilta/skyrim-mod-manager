"""Phase 3 ordering engine: generate the MO2 install order deterministically
from category + real file conflicts + family clustering, NOT from the input
rank. This is the rework's core -- the old heuristic drove order *from* the
STEP bucket (category); this drives it from the two independent axes the plan
locks:

- **Band (separator) = coarse layering.** Each mod's Nexus category maps to a
  numbered separator band (separators.CATEGORY_SEPARATOR); band id ascending =
  install order = overwrite layering. This alone resolves the vast majority of
  real conflicts (a texture in band 04 is overwritten by a late-graphics mod in
  band 08 for free).
- **Within a band, order is mostly free** -- cluster families adjacent (reuse
  order_store's clustering) and let name signals break ties so a "X - Patch"
  lands just after its "X" base.

The only place real conflicts force a non-free placement is when a file overlap
needs a direction that band order resolves *backwards* (a Fix in an early band
that must overwrite a texture in a later band). Those get an explicit
**auto-pin** with a stored `pin_reason` (the shared path) -- rare, and every one
is explainable.

Pure computation: `compute(conn)` reads and returns; `apply(conn, plan)` writes.
Nothing here touches the live db on its own -- the eval harness runs `compute`
on a scratch copy and scores it against `conflicting_mods_file.txt`.
"""

import re

from . import buckets, order_store, rules, separators

# The category->band map, keyword-bucket fallback, keyword rules, and forced
# head-priority ids all live in the editable `order_rules.toml` (loaded by
# `rules.py`, re-read on every compute()). See that file for the tables.

# Name signals for within-band / cross-band overwrite direction. A mod whose
# name marks it as a patch/fix/compatibility layer is meant to overwrite the
# thing it patches -- so it sorts LATER (higher priority) than its base. Tiers
# are additive-max, not summed: the strongest matching signal wins.
_TIER_PATCH = 3     # explicit patch/fix/compatibility for another mod
_TIER_ADDON = 2     # an add-on / extension built on a base
_TIER_SETTINGS = 1  # settings/config/MCM loader (loads after the thing it configures)
_TIER_BASE = 0

_PATCH_RE = re.compile(
    r"\b(patch(es|ed)?|hotfix|compat(ibility)?|fix(es|ed)?|tweaks?|override)\b", re.I
)
_ADDON_RE = re.compile(r"\b(add-?on|addons?|extension|expansion|support|plugin)\b", re.I)
_SETTINGS_RE = re.compile(r"\b(settings?|config(uration)?|mcm|preset)\s*(loader)?\b", re.I)

# Max size of a conflict group we'll physically glue together + pin. Bigger =
# a hub (broad multi-mod patch), left to band order instead.
_MAX_GLUE = 5


def _tier(name):
    n = name or ""
    if _PATCH_RE.search(n):
        return _TIER_PATCH
    if _ADDON_RE.search(n):
        return _TIER_ADDON
    if _SETTINGS_RE.search(n):
        return _TIER_SETTINGS
    return _TIER_BASE


# Within-band position: TOP loads first in its band (frameworks/foundations
# everything else in the band builds on), BOTTOM loads last (band-specific late
# loaders), MID = ordinary. This is the second axis the user asked for: signals
# decide not just WHICH band but WHERE in it.
POS_TOP, POS_MID, POS_BOTTOM = 0, 1, 2

# Head-priority (SKSE, Address Library, ...) is keyed by NEXUS MOD ID -- exact +
# rename-proof. The id list lives in `order_rules.toml` (`head = [...]`); list
# order == forced rank, every other mod sorts after (index == len).
def _head_priority(mod_id):
    try:
        return rules.HEAD_PRIORITY_IDS.index(mod_id)
    except ValueError:
        return len(rules.HEAD_PRIORITY_IDS)


def _classify(name, category, valid):
    """(band, position) for a mod. Start from the Nexus category (keyword-bucket
    fallback for blank/unmapped), then let the first matching rule override the
    band and set the within-band position. STRONG rules (parents None) reclassify
    regardless of category; REFINE rules only fire within their parent bands. The
    category map, bucket fallback, and rule table all come from `rules` (loaded
    from the editable order_rules.toml)."""
    band = rules.CATEGORY_BAND.get((category or "").strip(), separators.UNSORTED)
    if band == separators.UNSORTED:
        bucket, _ = buckets.classify(name, category)
        band = rules.BUCKET_BAND.get(bucket, separators.UNSORTED)
    pos = POS_MID
    n = name or ""
    for parents, rpos, rband, rx in rules.RULES:
        if parents is not None and band not in parents:
            continue
        if rband not in valid:
            continue
        if rx.search(n):
            band, pos = rband, rpos
            break
    return (band if band in valid else separators.UNSORTED), pos


# Generic leading words that are NOT a brand -- mods sharing one ("Immersive
# Armors" / "Immersive Wenches") are separate mods, not one family, so they must
# not be regrouped by lead word. A COINED brand (Ordinator, Legacy, SkyUI)
# isn't here, so its variants do group.
_GENERIC_LEAD = {
    "immersive", "better", "enhanced", "realistic", "simple", "dynamic", "true",
    "complete", "ultimate", "improved", "extended", "expanded", "cathedral",
    "unofficial", "more", "less", "faster", "smooth", "vanilla", "modern",
    "practical", "gritty", "rustic", "northern", "medieval", "ancient", "royal",
    "beautiful", "amazing", "epic", "legendary", "quality", "high", "classic",
}


_EDITION_SUFFIX = re.compile(
    r"\s+(se|sse|ae|ng|le|special edition|anniversary edition|legendary edition"
    r"|redux|remastered|remaster|edition)$", re.I
)


def _stem(name):
    """The base TITLE of a mod name: everything up to the first ' - '/':' (the
    part before a variant/patch suffix), minus a trailing edition token. So
    "True Directional Movement - Modernized ..." and the no-dash "True Directional
    Movement Lock-on Fixes" both relate to the stem "true directional movement"."""
    head = re.split(r"\s*[-:–—]\s*", name, 1)[0]
    return _EDITION_SUFFIX.sub("", head).strip().lower()


def _acronym_tokens(name):
    """ALL-CAPS acronym words >=4 chars (FISSES, ADXP, SPID, XPMSSE). These are
    brand codes, not English words, so a shared one is a strong family signal --
    unlike a distinctive-but-generic word ("framework", "normal") that could
    coincidentally have a single base and over-merge."""
    return {
        w.lower()
        for w in order_store._words(name)
        if len(w) >= 4 and w.isupper() and w.lower() not in order_store._GENERIC_WORDS
    }


def _base_key(tier_of, m):
    """Ordering key to pick a family's BASE: lowest tier (plain mod, not a
    patch/loader), then earliest upload (lowest positive id); local negative-id
    adoptions last (no upload order)."""
    return (tier_of[m], 0, m) if m > 0 else (tier_of[m], 1, -m)


def _regroup_families(band_of, name_of, tier_of):
    """Pull split families back together across bands so a patch/addon rejoins its
    base's band (out of the Misc Patches dump). Mutates band_of in place. Two
    complementary signals, both conservative:

    A. Stem-prefix: mods whose name begins with a distinctive base TITLE stem
       (multi-word, or a coined single word) join that stem's family -- catches
       "True Directional Movement Lock-on Fixes" -> the TDM base. Because the
       stem is the full title, "Immersive Armors" and "Immersive Wenches" have
       DIFFERENT stems and never merge.
    B. Single-base acronym: an ALL-CAPS brand code (FISSES, ADXP) shared by
       exactly ONE tier-0 base and one-or-more higher-tier dependents -- the
       dependents adopt that base's band. Acronyms only (not general words) +
       the single-base guard keeps this from merging unrelated mods.

    Each family re-bands to its base = _base_key (lowest tier, earliest upload)."""
    stem_of = {m: _stem(name_of[m]) for m in band_of}
    lower = {m: name_of[m].lower() for m in band_of}
    tokens = {m: _acronym_tokens(name_of[m]) for m in band_of}

    # --- A. stem-prefix families ---
    groups = {}
    for m in band_of:
        if len(stem_of[m]) >= 6:
            groups.setdefault(stem_of[m], set()).add(m)
    stems = list(groups)
    for m in band_of:
        nm = lower[m]
        for s in stems:
            if s == stem_of[m]:
                continue
            # nm starts with the base stem at a word boundary
            if nm.startswith(s) and (len(nm) == len(s) or not nm[len(s)].isalnum()):
                groups[s].add(m)

    # --- B. single-base token families ---
    tok_bases, tok_deps = {}, {}
    for m in band_of:
        for t in tokens[m]:
            (tok_bases if tier_of[m] == 0 else tok_deps).setdefault(t, []).append(m)
    for t, deps in tok_deps.items():
        bases = tok_bases.get(t)
        if bases and len(bases) == 1:
            groups.setdefault(f"tok:{t}", set()).update(bases + deps)

    for members in groups.values():
        if len(members) < 2 or len({band_of[m] for m in members}) < 2:
            continue
        base = min(members, key=lambda m: _base_key(tier_of, m))
        for m in members:
            band_of[m] = band_of[base]


def _name_related(a, b):
    """True if two mod names look like the same family -- one contains the
    other verbatim, they share a distinctive word (>=3 chars, non-generic:
    "MCO", "FISSES", "Ordinator"), or a leading acronym matches the other's
    initials. Used to gate conflict gluing: two mods that share a real file but
    have NOTHING in common by name (a follower framework and an optimised-scripts
    pack both shipping one common .pex) are an incidental overlap, not a
    patch-of relationship, so they must not be pinned together."""
    if order_store._contains_whole_name(a, b):
        return True
    wa = {w.lower() for w in order_store._words(a) if len(w) >= 3 and w.lower() not in order_store._GENERIC_WORDS}
    wb = {w.lower() for w in order_store._words(b) if len(w) >= 3 and w.lower() not in order_store._GENERIC_WORDS}
    if wa & wb:
        return True
    aa, ab = order_store._leading_acronym(a), order_store._leading_acronym(b)
    ia, ib = order_store._initials(a), order_store._initials(b)
    return bool((aa and aa == ib) or (ab and ab == ia))


def _real_conflict_pairs(conn):
    """{(a,b): [shared paths]} for every ok mod pair sharing a real
    Data-relative file path, a<b. Mirrors conflicts.pairs() SQL (bounded by the
    same _MAX_SHARERS redistributed-utility cutoff) but returns raw id pairs --
    the engine needs the edge set, not the UI's per-pair bucket annotations."""
    from .conflicts import _MAX_SHARERS, INCIDENTAL_PATH_SQL

    rows = conn.execute(
        "WITH shared AS ("
        "  SELECT mf.path FROM mod_files mf"
        "  JOIN mods m ON m.file_id = mf.file_id AND m.status = 'ok'"
        "  WHERE 1 = 1" + INCIDENTAL_PATH_SQL +
        "  GROUP BY mf.path HAVING COUNT(DISTINCT m.mod_id) BETWEEN 2 AND ?)"
        " SELECT mf.path, m.mod_id FROM mod_files mf"
        " JOIN shared ON shared.path = mf.path"
        " JOIN mods m ON m.file_id = mf.file_id AND m.status = 'ok'"
        " GROUP BY mf.path, m.mod_id",
        (_MAX_SHARERS,),
    ).fetchall()
    by_path = {}
    for r in rows:
        by_path.setdefault(r["path"], []).append(r["mod_id"])
    pairs = {}
    for path, ids in by_path.items():
        if not (2 <= len(ids) <= _MAX_SHARERS):
            continue
        ids = sorted(ids)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pairs.setdefault((ids[i], ids[j]), []).append(path)
    return pairs


def compute(conn):
    """Deterministic order for every ok mod. Returns a plan dict:
      - ordered_ids: mod_ids in install order (rank 0 = top = lowest priority)
      - band_of: {mod_id: separator_id}
      - pins: {mod_id: reason} for cross-band auto-pins (conflict_pin rows)
    Locked mods keep their band; the engine still ranks around them (apply()
    re-pins them via order_store._write_ranks, same as every other rewrite)."""
    rules.reload()  # pick up any edits to order_rules.toml without a restart
    separators.seed(conn)
    valid = {r["id"] for r in conn.execute("SELECT id FROM separator")}
    rows = conn.execute(
        "SELECT m.mod_id, m.mod_name, m.category, s.file_type"
        " FROM mods m LEFT JOIN mod_sort s ON s.mod_id = m.mod_id"
        " WHERE m.status = 'ok' GROUP BY m.mod_id"
    ).fetchall()

    band_of, pos_of = {}, {}
    for r in rows:
        band_of[r["mod_id"]], pos_of[r["mod_id"]] = _classify(r["mod_name"], r["category"], valid)
    name_of = {r["mod_id"]: r["mod_name"] or "" for r in rows}
    tier_of = {r["mod_id"]: _tier(r["mod_name"]) for r in rows}

    # pull split families back together across bands (Ordinator/LOTD patches
    # stranded in Misc Patches rejoin their base's band) BEFORE clustering, so
    # they cluster + sit adjacent there.
    _regroup_families(band_of, name_of, tier_of)

    # Family clustering, but keyed by BAND (not bucket): reuse order_store's
    # DSU clustering by feeding band-as-bucket so families never merge across
    # bands and each family anchors at its base member's upload position.
    family_of = order_store._cluster_families(
        conn, [(band_of[r["mod_id"]], r["mod_id"], name_of[r["mod_id"]]) for r in rows]
    )
    head_prio = {mid: _head_priority(mid) for mid in band_of}

    def sort_key(mid):
        # band -> within-band position (TOP frameworks first) -> family anchor
        # (keeps a family together at its base's upload slot) -> tier (base
        # before its patches/addons) -> upload order. Position is PER-MOD, not
        # per-family: family clustering over-groups within a band (many
        # "... Animation" mods share a word), so a family-level position would
        # let one framework drag an unrelated blob to the top. A framework's real
        # addons match the same rule, so they still get TOP and stay adjacent.
        return (
            band_of[mid],
            head_prio[mid],  # SKSE, then Address Library, forced to the very top
            pos_of[mid],
            family_of[mid],
            tier_of[mid],
            order_store._family_member_key(mid, name_of[mid]),
        )

    # --- Conflict grouping (the "pin"): mods that share a REAL file are pulled
    # physically together, stacked base -> overwriter (later overwrites earlier),
    # and re-banded into ONE band so the grouped display shows them adjacent.
    # Every member is flagged conflict_pin with a reason naming the group. This
    # is what makes "pinned" mean something visible: the conflicting mods sit
    # exactly on top of each other instead of scattered across their categories.
    pairs = _real_conflict_pairs(conn)
    parent = {}

    def _find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a, b):
        ra, rb = _find(a), _find(b)
        if ra != rb:
            parent[ra] = rb

    # Glue a pair only when it's a real patch-of relationship, and only WITHIN a
    # band. Three gates:
    #  - same band: a pin only reorders mods to sit adjacent inside a section; it
    #    never re-bands across sections. (Without this, a cluster bridged across
    #    bands -- a base mod's *camera config* addon linking that mod's framework
    #    to Improved Camera -- would drag the framework out of its band into
    #    Camera.)
    #  - different name tier: a base and its patch/loader/addon (overwrite dir).
    #  - name-related: shared brand/word, not just an incidental shared file.
    # Cross-band real conflicts are left to band order (later band overwrites).
    for (a, b) in pairs:
        if (a in band_of and b in band_of and band_of[a] == band_of[b]
                and tier_of[a] != tier_of[b] and _name_related(name_of[a], name_of[b])):
            _union(a, b)

    clusters = {}
    for mid in list(parent):
        clusters.setdefault(_find(mid), []).append(mid)

    pins = {}
    glued = []  # each: a member list already in install (overwrite) order
    for members in clusters.values():
        # a group of 2..MAX is a real dedicated patch/loader set worth gluing; a
        # bigger one is a hub (a broad multi-mod patch) -- leave those to band
        # order rather than yanking a dozen mods out of their sections.
        if not (2 <= len(members) <= _MAX_GLUE):
            continue
        # base (lowest tier = the plain mod) first; patches/loaders/addons after
        # it so they overwrite; stable by upload order within a tier.
        members.sort(key=lambda m: (tier_of[m], order_store._family_member_key(m, name_of[m])))
        anchor_band = band_of[members[0]]
        for m in members:
            band_of[m] = anchor_band  # one band -> the display groups them together
        shown = ", ".join(name_of[m] for m in members[:6]) + (" …" if len(members) > 6 else "")
        reason = f"conflict group — share real files, installed together so lower overwrites upper: {shown}"
        for m in members:
            pins[m] = reason
        glued.append(members)

    # rebuild order with the re-banded members, then splice each glued cluster
    # contiguous at its earliest member's natural slot (keeps the group as one
    # block, in overwrite order, inside its band)
    ordered = sorted(band_of, key=sort_key)
    if glued:
        pos = {mid: i for i, mid in enumerate(ordered)}
        glued.sort(key=lambda ms: min(pos[m] for m in ms))
        for members in glued:
            mset = set(members)
            anchor = min(pos[m] for m in members)
            ordered = [m for m in ordered if m not in mset]
            insert_at = sum(1 for m in ordered if pos[m] < anchor)
            ordered[insert_at:insert_at] = members
            pos = {m: i for i, m in enumerate(ordered)}

    return {"ordered_ids": ordered, "band_of": band_of, "pins": pins}


def apply(conn, plan):
    """Persist a compute() plan: stamp separator_id + conflict_pin/pin_reason,
    then rank via order_store._write_ranks so locked mods keep their slots.
    Caller holds order_store._rank_lock."""
    for mid, band in plan["band_of"].items():
        conn.execute(
            "INSERT INTO mod_sort (mod_id, separator_id) VALUES (?, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET separator_id = excluded.separator_id",
            (mid, band),
        )
    # clear stale pins, then set the current ones
    conn.execute("UPDATE mod_sort SET conflict_pin = 0, pin_reason = NULL")
    for mid, reason in plan["pins"].items():
        conn.execute(
            "INSERT INTO mod_sort (mod_id, conflict_pin, pin_reason) VALUES (?, 1, ?)"
            " ON CONFLICT(mod_id) DO UPDATE SET conflict_pin = 1, pin_reason = excluded.pin_reason",
            (mid, reason),
        )
    locked = {
        r["mod_id"]
        for r in conn.execute("SELECT mod_id FROM mod_sort WHERE locked = 1")
    }
    unlocked = [mid for mid in plan["ordered_ids"] if mid not in locked]
    order_store._write_ranks(conn, unlocked)


def generate():
    """Run the engine against the live db and persist. Serializes on the rank
    lock like every other multi-statement rank rewrite."""
    from . import db

    with order_store._rank_lock, db.connect() as conn:
        plan = compute(conn)
        apply(conn, plan)
    return {"ordered": len(plan["ordered_ids"]), "pins": len(plan["pins"])}
