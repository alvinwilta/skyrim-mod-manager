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
            <b>Show deleted</b> reveals soft-deleted rows again.
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
            <b>Check for drift</b> — flags mods whose current group disagrees with the last sorter's opinion (usually
            means a manual drag moved it out of where Sort/Refine put it); highlights those rows red in the table.
            Result in the <b>Check for drift</b> tab.
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
