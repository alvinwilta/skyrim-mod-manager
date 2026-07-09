"""Curator-authored ordering rules from a collection's own manifest
(collection.json's `modRules`) -- before/after/requires/conflicts/
recommends/provides between specific mods, written by a human while
assembling that collection. Real, not guessed: traced to Vortex's own
`ICollectionModRule` type. See modman/precedence.py for how before/after/
requires rules get applied as an actual ordering adjustment.

Each rule's `source`/`reference` is an IModReference (fileMD5/versionMatch/
logicalFileName/fileExpression) -- not a clean modId. Resolved by joining
against that *same manifest's* own `mods[]` array, each of which has a
`source: {modId, fileId, md5, logicalFilename}` when `type == 'nexus'`.
Verified against a real manifest this session: matching by `md5` finds
every match `logicalFilename`-matching also finds, plus more (some rule
sides reference mods outside the collection's own list, which just can't
be resolved) -- so md5 is the primary key, name a fallback for entries
missing an md5."""

from . import db, nexus


def _resolve_index(manifest):
    by_md5, by_name = {}, {}
    for m in manifest.get("mods", []):
        source = m.get("source") or {}
        if source.get("type") != "nexus" or not source.get("modId"):
            continue
        if source.get("md5"):
            by_md5[source["md5"]] = source["modId"]
        # a rule reference's logicalFileName matches the mod entry's own
        # source.logicalFilename, NOT its display name
        if source.get("logicalFilename"):
            by_name[source["logicalFilename"]] = source["modId"]
    return by_md5, by_name


def _resolve(ref, by_md5, by_name):
    return by_md5.get(ref.get("fileMD5")) or by_name.get(ref.get("logicalFileName"))


def sync(collection_id, download_link):
    """Fetch a collection's manifest and (re)store its resolvable rules.
    Returns the number of rules stored, or None if no API key is configured
    (config.NEXUS_API_KEY unset -- collection provenance tracking still
    works without this, only the ordering-rule data is unavailable)."""
    manifest = nexus.fetch_collection_manifest(download_link)
    if manifest is None:
        return None

    by_md5, by_name = _resolve_index(manifest)
    rows = []
    for rule in manifest.get("modRules", []):
        source_mod_id = _resolve(rule.get("source") or {}, by_md5, by_name)
        reference_mod_id = _resolve(rule.get("reference") or {}, by_md5, by_name)
        if source_mod_id and reference_mod_id:
            rows.append((collection_id, rule["type"], source_mod_id, reference_mod_id))

    with db.connect() as conn:
        conn.execute("DELETE FROM collection_mod_rules WHERE collection_id = ?", (collection_id,))
        conn.executemany(
            "INSERT INTO collection_mod_rules (collection_id, type, source_mod_id, reference_mod_id)"
            " VALUES (?, ?, ?, ?)",
            rows,
        )
    return len(rows)
