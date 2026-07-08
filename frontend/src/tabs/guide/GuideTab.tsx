// Static help text, ported verbatim from the legacy #tab-guide section.

const h3Style = { fontSize: 13, marginTop: 14 }
const ulStyle = { margin: '0 0 0 20px' }

export function GuideTab() {
  return (
    <section>
      <p className="dim" style={{ marginBottom: 8 }}>
        What each tab does, and — for Install Order — how the sorting actually works.
      </p>

      <div className="grp">
        <h2>Library</h2>
        <ul style={ulStyle}>
          <li>Search by name, author, or category.</li>
          <li>
            Select rows to <b>Validate</b> (re-checks file size against Nexus, doesn't redownload), <b>Redownload</b>,
            or <b>Delete</b> (soft-delete — keeps the record, marked <span className="dim">deleted</span>, so it
            doesn't resurface as "new" on the next import unless you redownload it).
          </li>
          <li>
            <b>Import from disk</b> — adopts archives already in the downloads folder that aren't in the library yet:
            files you downloaded straight through MO2, or from other sites (LoversLab, GitHub, …). It reads each
            archive's <code>.meta</code> sidecar for identity and enriches from Nexus where it can, then records them
            like a normal download so they show up in Install Order, conflicts, and commit. Three cases, nothing
            guessed: a real Nexus <code>.meta</code> gets full metadata + link; a Nexus <code>.meta</code> whose mod is
            gone keeps its IDs with an empty link; anything else (no <code>.meta</code>, or a non-Nexus one) is adopted
            with the filename as its name, size from disk, and a blank link — and a minimal truthful <code>.meta</code>{' '}
            is written for it if it had none. Blocked while the order is committed to disk.
          </li>
          <li>
            <b>Show deleted</b> switches to a deleted-only view (just the soft-deleted rows); toggle off to return to the
            live library. In that view the Delete button becomes <b>Purge</b> — it permanently removes the record from
            the database (soft-delete only marks it; purge is the real, unrecoverable delete).
          </li>
          <li>
            <b>Source</b> column: which collection(s) a mod came from, or <span className="dim">manual</span> if you
            added it yourself. More than 2 collections collapses to two badges + a <span className="dim">+N</span>{' '}
            badge — hover it for the rest.
          </li>
        </ul>
      </div>

      <div className="grp">
        <h2>Install Order</h2>
        <p className="dim">
          MO2 left-panel <i>install</i> order — which mod's files overwrite which on disk. Not plugin load order
          (that's LOOT's job). Bottom of the list wins on a shared file.
        </p>

        <h3 style={h3Style}>Ordering row</h3>
        <ul style={ulStyle}>
          <li>
            <b>Sort (heuristic)</b> — instant, no AI. Classifies every <i>unlocked</i> mod into one of 20 STEP-guide
            groups (Extenders, Resources, Foundation, ... Post-Processing) by matching its name against a keyword list
            first, falling back to its Nexus category, then sorts alphabetically within each group. Result shows in
            the <b>Sort</b> log tab below.
          </li>
          <li>
            <b>Refine with Claude</b> — sends every unlocked mod (under its current group heading) plus any <i>real</i>{' '}
            scanned file conflicts to Claude, and asks for corrections only: a mod not mentioned in the reply stays
            exactly where it was (sparse diff, not a full reshuffle). If Claude tries to "correct" more than 40% of
            what it's shown, the whole reply is rejected as a safety valve. Also collects any conflict notes Claude
            calls out. Result in the <b>Refine with Claude</b> tab.
          </li>
          <li>
            <b>Refine uncertain</b> — a second, smaller pass: only re-checks mods still flagged{' '}
            <span className="dim">UNCERTAIN</span> by the pass above, this time with each mod's real Nexus description
            fetched as extra signal. Same sparse-correction mechanism. Result in the <b>Refine uncertain</b> tab.
          </li>
          <li>
            <b>Apply collection order rules</b> — repositions only mods that violate a curator-authored
            before/after/requires rule pulled from an imported collection's own manifest (real data — see Collections
            below), reusing the same move as a manual drag. Result in the <b>Collection rules</b> tab, including any
            locked-mod skips or conflicting-rule drops that would otherwise be invisible.
          </li>
          <li>
            <b>Model</b> dropdown picks which Claude model (Haiku/Sonnet/Opus) the two Claude buttons use.
          </li>
          <li>
            <b>Claude prompt</b> (collapsible) — the exact prompt <b>Refine with Claude</b> sends; editable and
            resettable to default.
          </li>
        </ul>

        <h3 style={h3Style}>Analysis row — read-only, informational, changes nothing by itself</h3>
        <ul style={ulStyle}>
          <li>
            <b>Scan archives</b> — lists every downloaded archive's actual file paths (via <code>7z</code>) and finds
            genuine path overlaps between mods, not a guess. Result in the <b>Conflicts</b> tab; overwrites from
            Foundation/Patches groups are collapsed separately since those groups exist specifically to be broadly
            overwritten.
          </li>
          <li>
            <b>Sync requirements</b> — pulls each mod's real Nexus "requires" data and flags anything required but
            missing from your library. Result in the <b>Requirements</b> tab.
          </li>
          <li>
            <b>Check for drift</b> — compares each mod's current group against the group the last Sort/Refine placed it
            in (its <code>expected_bucket</code>). A mismatch means something moved the mod after the sort — almost
            always a manual drag or a "move to position" — so it no longer sits where the sorter put it. Those rows turn
            red and get a <b>WRONG SPOT → group</b> badge naming the group the sorter expected; drag them back or re-run
            Sort to re-place. Result in the <b>Check for drift</b> tab.
          </li>
          <li>
            <b>Check vs MO2 order</b> — compares your list against what MO2 <i>actually</i> has installed and enabled on
            disk, read from the active profile's <code>modlist.txt</code> and each installed mod's{' '}
            <code>meta.ini</code> (real data, not a guess). Flags three things in the <b>vs MO2</b> tab: mods{' '}
            <b>out of order</b> (a different relative position than MO2 has them — those rows turn red with an{' '}
            <b>MO2 ORDER</b> badge), mods <b>installed in MO2 but not in your list</b>, and mods <b>in your list but not
            yet installed</b> in MO2. Enabled-only; disabled mods count as not installed. The button is only available{' '}
            <b>after you commit the order to disk</b> — MO2 only sees this order once the archives carry their{' '}
            install-order prefixes, so comparing before then is meaningless.
          </li>
        </ul>

        <h3 style={h3Style}>Commit order to disk — the one button that changes real files</h3>
        <ul style={ulStyle}>
          <li>
            <b>Commit order to disk</b> physically renames every downloaded archive to add a zero-padded install-order
            prefix — <code>0001__</code>, <code>0002__</code>, … — so they sort in install order in any file browser or
            when you drag them into MO2. The number is padded to the mod count so it sorts correctly (0010 after 0002).
            Each archive's MO2 <code>.meta</code> sidecar is renamed with it, so install state is preserved.
          </li>
          <li>
            While committed, <b>all reordering is frozen</b> (drag, sort, refine, move, lock) and{' '}
            <b>downloads/imports are blocked</b> — a redownload would write the un-prefixed name and fight the prefix.
            Filters and the whole Analysis row stay usable.
          </li>
          <li>
            The button turns into <b>🔒 Committed to disk — click to revert</b>. Reverting renames everything back to
            the original names and unfreezes everything. This is the escape hatch and is always available, even after a
            restart — the committed state is stored in the database, not in memory.
          </li>
          <li>
            Renaming runs behind a blocking overlay; don't close the tab until it finishes. If anything fails partway it
            rolls back automatically, and any error shows in red under the buttons. A mod whose file is missing on disk
            is skipped, not treated as a failure.
          </li>
        </ul>

        <h3 style={h3Style}>When signals disagree</h3>
        <p className="dim" style={{ margin: '0 0 0 20px' }}>
          Locked position &gt; manual drag/move &gt; collection curated rule &gt; Claude correction &gt; heuristic
          guess. Higher-priority sources are never overwritten by lower ones.
        </p>

        <h3 style={h3Style}>The table itself</h3>
        <ul style={ulStyle}>
          <li>
            Drag the ≡ handle to reorder. Select rows by clicking (ctrl toggles, shift ranges) or by dragging a box
            across rows — then use the selection toolbar to lock/unlock/move the whole block, or drag any selected
            row's handle to carry the block.
          </li>
          <li>Click the position number to type an exact position instead.</li>
          <li>🔒 lock icon pins a mod — no sort/refine/collection-rule pass will ever move it.</li>
          <li>Filter by category or group.</li>
          <li>
            <span className="badge b-bsa">BSA-only</span> — archive has no loose files, just packed BSA/BA2 + a
            plugin; its exact position barely matters for real file conflicts.
          </li>
        </ul>
      </div>

      <div className="grp">
        <h2>Collections</h2>
        <ul style={ulStyle}>
          <li>
            Every collection you've fetched from Nexus, whether or not you've downloaded everything it lists yet — the
            count shown is <span className="dim">downloaded / total</span>.
          </li>
          <li>
            The enable checkbox excludes that collection's curated order rules from <b>Apply collection order rules</b>{' '}
            without deleting anything — its provenance links and mod list stay intact either way.
          </li>
          <li>
            <b>view order</b> expands that collection's mods in your actual current install order; dimmed rows aren't
            downloaded yet.
          </li>
        </ul>
      </div>

      <div className="grp">
        <h2>Import</h2>
        <ul style={ulStyle}>
          <li>
            Paste a collection URL or a single mod page URL and click <b>Fetch from Nexus</b> — diffs it against your
            library (new / updated / unchanged). If it's a collection, its full modlist and curator rules are
            registered immediately (Collections tab), whether or not you end up downloading anything.
          </li>
          <li>
            Or paste/upload a <code>modlist.json</code> directly and <b>Diff against DB</b>.
          </li>
          <li>
            Select which new/updated files you actually want, then <b>Download selected</b>.
          </li>
        </ul>
      </div>

      <div className="grp">
        <h2>Progress</h2>
        <p className="dim" style={{ margin: '0 0 0 20px' }}>
          Live status of the current download job — phase, per-file progress, transfer speed, ETA, and any failures.
        </p>
      </div>
    </section>
  )
}
