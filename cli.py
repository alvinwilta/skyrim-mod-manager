"""Download a Nexus collection from the command line.

Usage:
    python cli.py <collection-url | modlist.json> [--include-unchanged]

Diffs the modlist against mods.db and downloads new + updated files.
Requires a Chromium-family browser running with --remote-debugging-port=9223
and a logged-in nexusmods.com session.
"""

import argparse
import json
import logging
import sys

from modman import commit, db, engine, nexus


def load_modlist(source):
    if source.startswith("https://"):
        fetch = nexus.fetch_collection if "/collections/" in source else nexus.fetch_mod
        return fetch(source)
    with open(source) as f:
        return json.load(f)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="collection url or path to a modlist json")
    parser.add_argument("--include-unchanged", action="store_true",
                        help="also re-download files already recorded in the db")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    db.init_db()

    # same gate as every webapp download path: downloading while archives
    # carry install-order prefixes would repoint db rows at unprefixed names
    # and orphan the committed files
    if commit.is_committed():
        print("Install order is committed to disk — revert it (Install Order tab) before downloading.")
        return 1

    modfiles = engine.parse_modlist(load_modlist(args.source))
    diff = engine.diff_modlist(modfiles)
    print(f"{len(modfiles)} files in modlist: "
          f"{len(diff['new'])} new, {len(diff['updated'])} updated, {len(diff['unchanged'])} unchanged")

    groups = ["new", "updated"] + (["unchanged"] if args.include_unchanged else [])
    file_ids = [item["file_id"] for g in groups for item in diff[g]]
    if not file_ids:
        print("Nothing to download.")
        return 0

    total_mb = sum(item["size"] for g in groups for item in diff[g]) / 1e6
    print(f"Downloading {len(file_ids)} files ({total_mb:.0f} MB)...")

    result = engine.run_job(modfiles, file_ids)
    print(f"Done: {result['done']} downloaded, {result['failed']} failed.")
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
