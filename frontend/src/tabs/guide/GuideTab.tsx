// Static help text. Content mirrors the actual UI — update it when tabs gain
// or change behavior (whole-row drag, bulk move-to-group, hide-locked, …).

import type { ReactNode } from 'react'

function Card({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
  return (
    <div className="guide-card">
      <h2>
        <span className="guide-icon" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </div>
  )
}

function Chain({ items }: { items: string[] }) {
  return (
    <div className="guide-chain">
      {items.map((it, i) => (
        <span key={it} className="guide-chain-item">
          <span className="guide-chain-pill">{it}</span>
          {i < items.length - 1 && (
            <span className="guide-chain-arrow" aria-hidden="true">
              ›
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

export function GuideTab() {
  return (
    <section className="guide">
      <p className="dim">What each tab does, and — for Install Order — how the sorting actually works.</p>

      <Card icon="🧭" title="The normal flow — downloading a collection">
        <div className="guide-hflow">
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">1</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Fetch</div>
            <div className="guide-hflow-desc">
              <b>Import</b> tab: paste the collection URL → <b>Fetch from Nexus</b>. Modlist is diffed against your
              library; the collection + its curator rules get registered.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">2</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Download</div>
            <div className="guide-hflow-desc">
              Tick the new/updated files you want → <b>Download selected</b>.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">3</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Watch</div>
            <div className="guide-hflow-desc">
              <b>Progress</b> tab: per-file progress, speed, failures. Free Nexus throttles to ~0.5–2 MB/s total —
              big collections take a while.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">4</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Order</div>
            <div className="guide-hflow-desc">
              <b>Install Order</b> tab: <b>Sort</b> → optional Claude refines → <b>collection rules</b>. Sanity-check
              with the Analysis row; drag what's wrong, lock what must never move.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">5</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Commit</div>
            <div className="guide-hflow-desc">
              <b>Commit order to disk</b> — archives get <code>0001__</code> prefixes so they physically sort in
              install order.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">6</span>
            </div>
            <div className="guide-hflow-name">Install in MO2</div>
            <div className="guide-hflow-desc">
              Install archives in prefix order, then <b>Check vs MO2 order</b>. Revert the commit before reshuffling
              or downloading more.
            </div>
          </div>
        </div>
      </Card>

      <Card icon="📚" title="Library">
        <ul>
          <li>Search by name, author, or category.</li>
          <li>
            Select rows to <b>Validate</b> (re-checks file size against Nexus, doesn't redownload), <b>Redownload</b>,
            or <b>Delete</b> (soft-delete — keeps the record, marked <span className="dim">deleted</span>, so it
            doesn't resurface as "new" on the next import unless you redownload it).
          </li>
          <li>
            <b>Import from disk</b> — adopts archives already in the downloads folder that aren't in the library yet:
            files you downloaded straight through MO2, or from other sites. It reads each archive's <code>.meta</code>{' '}
            sidecar for identity and enriches from Nexus where it can, then records them like a normal download so
            they show up in Install Order, conflicts, and commit. Three cases, nothing guessed — blocked while the
            order is committed to disk:
            <table className="guide-table guide-matrix">
              <thead>
                <tr className="guide-matrix-groups">
                  <th colSpan={2}>Archive state</th>
                  <th colSpan={3} className="sep">
                    What you get
                  </th>
                </tr>
                <tr>
                  <th>
                    Nexus <code>.meta</code>
                  </th>
                  <th>Mod still on Nexus</th>
                  <th className="sep">Full metadata</th>
                  <th>Link / Redownload</th>
                  <th>Name comes from</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="tick-y">✓</td>
                  <td className="tick-y">✓</td>
                  <td className="tick-y sep">✓ fetched live</td>
                  <td className="tick-y">✓</td>
                  <td>Nexus</td>
                </tr>
                <tr>
                  <td className="tick-y">✓</td>
                  <td className="tick-n">✗ removed</td>
                  <td className="tick-p sep">~ real IDs + what the .meta records</td>
                  <td className="tick-n">✗</td>
                  <td>
                    the <code>.meta</code>
                  </td>
                </tr>
                <tr>
                  <td className="tick-n">✗ none, or non-Nexus</td>
                  <td className="tick-dim">—</td>
                  <td className="tick-n sep">✗ size from disk only</td>
                  <td className="tick-n">✗</td>
                  <td>the filename</td>
                </tr>
              </tbody>
            </table>
            If the archive had no <code>.meta</code> at all, a minimal truthful one is written so MO2 still recognizes
            it.
          </li>
          <li>
            <b>Show deleted</b> switches to a deleted-only view (just the soft-deleted rows); toggle off to return to
            the live library. In that view the Delete button becomes <b>Purge</b> — it permanently removes the record
            from the database (soft-delete only marks it; purge is the real, unrecoverable delete).
          </li>
          <li>
            <b>Source</b> column: which collection(s) a mod came from, or <span className="dim">manual</span> if you
            added it yourself. More than 2 collections collapses to two badges + a <span className="dim">+N</span>{' '}
            badge — hover it for the rest.
          </li>
        </ul>
      </Card>

      <Card icon="🧩" title="Install Order">
        <p className="guide-lede">
          MO2 left-panel <i>install</i> order — which mod's files overwrite which on disk. Not plugin load order
          (that's LOOT's job). Bottom of the list wins on a shared file:
        </p>
        <div className="guide-visual">
          <div className="guide-stack">
            <div className="guide-stack-row">
              <span className="guide-stack-pos">1</span>
              <span className="guide-stack-name">Foundation texture pack</span>
              <span className="guide-stack-note">installed first</span>
            </div>
            <div className="guide-stack-row">
              <span className="guide-stack-pos">2</span>
              <span className="guide-stack-name">City overhaul</span>
              <span className="guide-stack-note">overwrites 1 where they share files</span>
            </div>
            <div className="guide-stack-row winner">
              <span className="guide-stack-pos">3</span>
              <span className="guide-stack-name">Compatibility patch</span>
              <span className="guide-stack-note">bottom — wins every shared file ✓</span>
            </div>
          </div>
        </div>

        <h3>Ordering row</h3>
        <div className="guide-visual">
          <div className="guide-pipe">
            <div className="guide-pipe-step">
              <span className="guide-pipe-num">1</span>
              <span className="guide-pipe-name">Sort (heuristic)</span>
              <span className="guide-pipe-sub">instant, no AI — 20 STEP groups</span>
            </div>
            <span className="guide-pipe-arrow" aria-hidden="true">→</span>
            <div className="guide-pipe-step">
              <span className="guide-pipe-num">2</span>
              <span className="guide-pipe-name">Refine with Claude</span>
              <span className="guide-pipe-sub">sparse corrections only</span>
            </div>
            <span className="guide-pipe-arrow" aria-hidden="true">→</span>
            <div className="guide-pipe-step">
              <span className="guide-pipe-num">3</span>
              <span className="guide-pipe-name">Refine uncertain</span>
              <span className="guide-pipe-sub">re-checks UNCERTAIN mods</span>
            </div>
            <span className="guide-pipe-arrow" aria-hidden="true">→</span>
            <div className="guide-pipe-step">
              <span className="guide-pipe-num">4</span>
              <span className="guide-pipe-name">Collection rules</span>
              <span className="guide-pipe-sub">curator before/after, last word</span>
            </div>
          </div>
          <div className="guide-pipe-note">
            Each pass only refines what the previous one left — locked mods never move, and steps 2–4 are optional.
          </div>
        </div>
        <ul>
          <li>
            <b>Sort (heuristic)</b> — instant, no AI. Classifies every <i>unlocked</i> mod into one of 20 STEP-guide
            groups (Extenders, Resources, Foundation, ... Post-Processing) by matching its name against a keyword list
            first, falling back to its Nexus category, then sorts alphabetically within each group. Result shows in
            the <b>Sort</b> log tab below.
            <div className="guide-visual">
              <div className="guide-demo">
                <div className="guide-demo-row">
                  <span className="guide-demo-name">SkyUI</span>
                  <span className="guide-demo-note">name keyword "UI"</span>
                  <span className="arr">→</span>
                  <span className="guide-pill">15 · Interface</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-name">Ordinator — Perks of Skyrim</span>
                  <span className="guide-demo-note">name keyword "perk"</span>
                  <span className="arr">→</span>
                  <span className="guide-pill">14 · Gameplay — Skills &amp; Perks</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-name">Some Obscure Mod</span>
                  <span className="guide-demo-note">no keyword hit → falls back to its Nexus category</span>
                  <span className="arr">→</span>
                  <span className="guide-pill">16 · Locations</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-note">then A→Z inside each group</span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <b>Refine with Claude</b> — sends every unlocked mod (under its current group heading) plus any <i>real</i>{' '}
            scanned file conflicts to Claude, and asks for corrections only: a mod not mentioned in the reply stays
            exactly where it was (sparse diff, not a full reshuffle). If Claude tries to "correct" more than 40% of
            what it's shown, the whole reply is rejected as a safety valve. Also collects any conflict notes Claude
            calls out. Result in the <b>Refine with Claude</b> tab.
            <div className="guide-visual">
              <div className="guide-demo">
                <div className="guide-demo-row">
                  <span className="guide-demo-name">Static Mesh Improvement Mod</span>
                  <span className="guide-pill gray">not mentioned — stays put</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-name">Lux</span>
                  <span className="guide-pill amber">correction</span>
                  <span className="arr">→</span>
                  <span className="guide-pill">17 · Lighting &amp; Weather</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-name">Embers XD</span>
                  <span className="guide-pill gray">not mentioned — stays put</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-note">reply "corrects" &gt; 40% of what it saw?</span>
                  <span className="guide-pill red">whole reply rejected</span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <b>Refine uncertain</b> — a second, smaller pass: only re-checks mods still flagged{' '}
            <span className="dim">UNCERTAIN</span> by the pass above, this time with each mod's real Nexus description
            fetched as extra signal. Same sparse-correction mechanism. Result in the <b>Refine uncertain</b> tab.
            <div className="guide-visual">
              <div className="guide-demo">
                <div className="guide-demo-row">
                  <span className="guide-pill gray">UNCERTAIN</span>
                  <span className="guide-demo-name">Wildcat — Combat of Skyrim</span>
                  <span className="guide-demo-note">+ its Nexus description fetched</span>
                  <span className="arr">→</span>
                  <span className="guide-pill green">10 · Gameplay — AI &amp; Combat</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-note">everything not flagged UNCERTAIN isn't even sent</span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <b>Apply collection order rules</b> — repositions only mods that violate a curator-authored
            before/after/requires rule pulled from an imported collection's own manifest (real data — see Collections
            below), reusing the same move as a manual drag. Result in the <b>Collection rules</b> tab, including any
            locked-mod skips or conflicting-rule drops that would otherwise be invisible.
            <div className="guide-visual">
              <div className="guide-demo">
                <div className="guide-demo-row">
                  <span className="guide-demo-note">curator rule:</span>
                  <span className="guide-demo-name">Embers XD</span>
                  <span className="guide-pill">before</span>
                  <span className="guide-demo-name">Lux</span>
                  <span className="guide-pill red">violated ✗</span>
                </div>
                <div className="guide-demo-row">
                  <span className="arr">→</span>
                  <span className="guide-demo-name">Lux</span>
                  <span className="guide-demo-note">repositioned below</span>
                  <span className="guide-demo-name">Embers XD</span>
                  <span className="guide-pill green">rule satisfied ✓</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-note">
                    🔒 locked target → skipped &amp; logged · two rules that contradict → dropped &amp; logged
                  </span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <b>Model</b> dropdown picks which Claude model (Haiku/Sonnet/Opus) the two Claude buttons use.
            <div className="guide-visual">
              <div className="guide-demo-row">
                <span className="guide-demo-note">Model:</span>
                <span className="guide-pill">Sonnet ▾</span>
                <span className="guide-demo-note">
                  Haiku = fastest/cheapest · Opus = most careful — applies to both Refine buttons
                </span>
              </div>
            </div>
          </li>
          <li>
            <b>Claude prompt</b> (collapsible) — the exact prompt <b>Refine with Claude</b> sends; editable and
            resettable to default.
            <div className="guide-visual">
              <div className="guide-demo">
                <div className="guide-demo-row">
                  <span className="guide-demo-name">▸ Claude prompt</span>
                  <span className="guide-demo-note">click to expand</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-note">
                    edit it → your version is saved and used from then on · <span className="guide-pill gray">Reset to default</span>{' '}
                    brings back the stock prompt
                  </span>
                </div>
              </div>
            </div>
          </li>
        </ul>

        <h3>Analysis row — read-only, informational, changes nothing by itself</h3>
        <ul>
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
            always a manual drag or a "move to position" — so it no longer sits where the sorter put it. Those rows
            turn red and get a <b>WRONG SPOT → group</b> badge naming the group the sorter expected; drag them back or
            re-run Sort to re-place. Result in the <b>Check for drift</b> tab.
          </li>
          <li>
            <b>Check vs MO2 order</b> — compares your list against what MO2 <i>actually</i> has installed and enabled
            on disk, read from the active profile's <code>modlist.txt</code> and each installed mod's{' '}
            <code>meta.ini</code> (real data, not a guess). Flags three things in the <b>vs MO2</b> tab: mods{' '}
            <b>out of order</b> (a different relative position than MO2 has them — those rows turn red with an{' '}
            <b>MO2 ORDER</b> badge), mods <b>installed in MO2 but not in your list</b>, and mods{' '}
            <b>in your list but not yet installed</b> in MO2. Enabled-only; disabled mods count as not installed. The
            button is only available <b>after you commit the order to disk</b> — MO2 only sees this order once the
            archives carry their install-order prefixes, so comparing before then is meaningless.
          </li>
        </ul>

        <h3>Commit order to disk — the one button that changes real files</h3>
        <div className="guide-callout">
          <ul>
            <li>
              <b>Commit order to disk</b> physically renames every downloaded archive to add a zero-padded
              install-order prefix so they sort in install order in any file browser or when you drag them into MO2:
              <div className="guide-visual" style={{ background: '#171308' }}>
                <div className="guide-rename">
                  <span>SkyUI_5-2-SE.7z</span>
                  <span className="arr">→</span>
                  <span>
                    <b>0042__</b>SkyUI_5-2-SE.7z
                  </span>
                  <span className="dim">(+ its .meta sidecar, so install state survives)</span>
                </div>
              </div>
              The number is padded to the mod count so it sorts correctly (0010 after 0002).
            </li>
            <li>
              While committed, <b>all reordering is frozen</b> (drag, sort, refine, move, lock) and{' '}
              <b>downloads/imports are blocked</b> — a redownload would write the un-prefixed name and fight the
              prefix. Filters and the whole Analysis row stay usable.
            </li>
            <li>
              The button turns into <b>🔒 Committed to disk — click to revert</b>. Reverting renames everything back
              to the original names and unfreezes everything. This is the escape hatch and is always available, even
              after a restart — the committed state is stored in the database, not in memory.
            </li>
            <li>
              Renaming runs behind a blocking overlay; don't close the tab until it finishes. If anything fails partway
              it rolls back automatically, and any error shows in red under the buttons. A mod whose file is missing on
              disk is skipped, not treated as a failure.
            </li>
          </ul>
        </div>

        <h3>When signals disagree</h3>
        <Chain items={['Locked position', 'Manual drag / move', 'Collection curated rule', 'Claude correction', 'Heuristic guess']} />
        <p className="guide-lede" style={{ marginTop: 6 }}>
          Higher-priority sources are never overwritten by lower ones.
        </p>

        <h3>The table itself</h3>
        <ul>
          <li>
            <b>Drag anywhere on a row</b> to reorder — the ≡ handle just marks the row as draggable. Rows are also
            keyboard-draggable: focus a row, then Enter/Space picks it up and the arrow keys move it.
          </li>
          <li>
            Select rows by clicking (each click toggles the row in or out, shift-click selects a range) — then the
            floating toolbar can <b>Lock</b>/<b>Unlock</b> the block, <b>Move</b> it to an exact position, send it to{' '}
            <b>Top</b>/<b>Bottom</b>, or <b>Move to group…</b> (inserts at the end of the chosen group). Dragging any
            selected row carries the whole block.
          </li>
          <li>Click the position number to type an exact position instead.</li>
          <li>🔒 lock icon pins a mod — no sort/refine/collection-rule pass will ever move it.</li>
          <li>
            Filter by category or group. The <b>Highlights</b> chip bar toggles row tints:
            <div className="guide-visual" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="guide-chip" style={{ background: '#1d2a45', color: 'var(--blue)' }}>🔒 Locked</span>
              <span className="guide-chip" style={{ background: '#3a2b12', color: 'var(--amber)' }}>Conflicts</span>
              <span className="guide-chip" style={{ background: '#3a1214', color: 'var(--red)' }}>Duplicates</span>
              <span className="guide-chip" style={{ background: '#241d0f', color: 'var(--amber)' }}>Moved</span>
              <span className="guide-chip" style={{ background: '#232833', color: 'var(--dim)' }}>Uncertain</span>
              <span className="guide-chip" style={{ background: '#2a1215', color: 'var(--red)' }}>Wrong spot</span>
            </div>
            The <b>🔒 Locked</b> chip shows/hides locked rows — hidden locked rows keep their place, so moving other
            mods stays relative to them.
          </li>
          <li>
            <span className="badge b-bsa">BSA-only</span> — archive has no loose files, just packed BSA/BA2 + a
            plugin; its exact position barely matters for real file conflicts.
          </li>
        </ul>
      </Card>

      <Card icon="🗂️" title="Collections">
        <ul>
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
      </Card>

      <Card icon="📥" title="Import">
        <ul>
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
      </Card>

      <Card icon="⏳" title="Progress">
        <p className="guide-lede" style={{ margin: 0 }}>
          Live status of the current download job — phase, per-file progress, transfer speed, ETA, and any failures.
        </p>
      </Card>
    </section>
  )
}
