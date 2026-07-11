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
              <b>Import</b> tab: paste the collection URL → <b>Fetch from Nexus</b>. Diffed against your library;
              curator rules get registered.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">2</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Download</div>
            <div className="guide-hflow-desc">
              Tick the files you want → <b>Download selected</b>.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">3</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Watch</div>
            <div className="guide-hflow-desc">
              <b>Progress</b> tab. Free Nexus throttles to ~0.5–2 MB/s — big collections take a while.
            </div>
          </div>
          <div className="guide-hflow-step">
            <div className="guide-hflow-top">
              <span className="guide-pipe-num">4</span>
              <span className="guide-hflow-line" aria-hidden="true" />
            </div>
            <div className="guide-hflow-name">Order</div>
            <div className="guide-hflow-desc">
              <b>Install Order</b> tab: <b>Sort</b> → optional Claude refines → <b>collection rules</b>. Drag what's
              wrong, lock what must never move.
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
              Install archives in prefix order, then <b>Check vs MO2 order</b>. Revert the commit before changing
              anything.
            </div>
          </div>
        </div>
      </Card>

      <Card icon="📚" title="Library">
        <ul>
          <li>Search by name, author, or category.</li>
          <li>
            Select rows to <b>Validate</b> (size check, no redownload), <b>Redownload</b>, or <b>Delete</b>{' '}
            (soft-delete — record kept so it doesn't resurface as "new" on the next import).
          </li>
          <li>
            <b>Import from disk</b> — adopts archives already in the downloads folder (downloaded via MO2 or other
            sites) using their <code>.meta</code> sidecars. Nothing guessed:
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
          </li>
          <li>
            <b>Show deleted</b> — deleted-only view where Delete becomes <b>Purge</b>: permanent, unrecoverable.
          </li>
          <li>
            <b>Source</b> column — which collection(s) a mod came from, or <span className="dim">manual</span>.
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
            <b>Sort (heuristic)</b> — name keywords first, Nexus category as fallback, A→Z within each group.
            <div className="guide-visual">
              <div className="guide-demo">
                <div className="guide-demo-row">
                  <span className="guide-demo-name">SkyUI</span>
                  <span className="guide-demo-note">name keyword "UI"</span>
                  <span className="arr">→</span>
                  <span className="guide-pill">15 · Interface</span>
                </div>
                <div className="guide-demo-row">
                  <span className="guide-demo-name">Some Obscure Mod</span>
                  <span className="guide-demo-note">no keyword hit → its Nexus category</span>
                  <span className="arr">→</span>
                  <span className="guide-pill">16 · Locations</span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <b>Refine with Claude</b> — Claude replies with corrections only; unmentioned mods stay put. Reply
            "correcting" &gt;40% is rejected outright.
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
                  <span className="guide-demo-note">reply "corrects" &gt; 40% of what it saw?</span>
                  <span className="guide-pill red">whole reply rejected</span>
                </div>
              </div>
            </div>
          </li>
          <li>
            <b>Refine uncertain</b> — second pass over <span className="dim">UNCERTAIN</span> mods only, with each
            mod's real Nexus description as extra signal.
          </li>
          <li>
            <b>Apply collection order rules</b> — repositions only mods violating a curator before/after rule. Locked
            targets are skipped &amp; logged; contradicting rules dropped &amp; logged.
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
              </div>
            </div>
          </li>
          <li>
            <b>Model</b> dropdown — Haiku = fastest/cheapest, Opus = most careful; applies to both Refine buttons.
          </li>
          <li>
            <b>Claude prompt</b> (collapsible) — the exact prompt sent; edit to override, reset brings back the stock
            prompt.
          </li>
        </ul>

        <h3>Analysis row — read-only, changes nothing by itself</h3>
        <ul>
          <li>
            <b>Scan archives</b> — real file-path overlaps between archives (via <code>7z</code>), not a guess →{' '}
            <b>Conflicts</b> tab.
          </li>
          <li>
            <b>Sync requirements</b> — flags Nexus "requires" mods missing from your library → <b>Requirements</b> tab.
          </li>
          <li>
            <b>Check for drift</b> — flags mods no longer where the last sort put them (manual drag since) with a{' '}
            <b>WRONG SPOT</b> badge → <b>Check for drift</b> tab.
          </li>
          <li>
            <b>Check vs MO2 order</b> — compares against what MO2 actually has installed (active profile's{' '}
            <code>modlist.txt</code> + each mod's <code>meta.ini</code>): out of order, in MO2 but not listed, listed
            but not installed → <b>vs MO2</b> tab. Available only after committing the order to disk.
          </li>
        </ul>

        <h3>Commit order to disk — the one button that changes real files</h3>
        <div className="guide-callout">
          <ul>
            <li>
              Physically renames every archive (+ its <code>.meta</code>) with an install-order prefix:
              <div className="guide-visual" style={{ background: '#171308' }}>
                <div className="guide-rename">
                  <span>SkyUI_5-2-SE.7z</span>
                  <span className="arr">→</span>
                  <span>
                    <b>0042__</b>SkyUI_5-2-SE.7z
                  </span>
                </div>
              </div>
            </li>
            <li>
              While committed: reordering frozen, downloads/imports blocked. Filters and Analysis stay usable.
            </li>
            <li>
              The button becomes <b>🔒 Committed to disk — click to revert</b> — renames everything back and unfreezes.
              Survives restarts (stored in the database).
            </li>
            <li>Failures roll back automatically; files missing on disk are skipped, not fatal.</li>
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
            <b>Drag anywhere on a row</b> to reorder, or click the position number to type an exact position. Keyboard:
            Enter/Space picks a focused row up, arrows move it.
          </li>
          <li>
            Click rows to select (shift-click for ranges) — the floating toolbar then <b>Lock</b>/<b>Unlock</b>,{' '}
            <b>Move</b>, <b>Top</b>/<b>Bottom</b>, or <b>Move to group…</b> the whole block.
          </li>
          <li>🔒 pins a mod — no sort/refine/rule pass will ever move it.</li>
          <li>
            <b>Highlights</b> chips toggle row tints; the <b>🔒 Locked</b> chip also shows/hides locked rows:
            <div className="guide-visual" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="guide-chip" style={{ background: '#1d2a45', color: 'var(--blue)' }}>🔒 Locked</span>
              <span className="guide-chip" style={{ background: '#3a2b12', color: 'var(--amber)' }}>Conflicts</span>
              <span className="guide-chip" style={{ background: '#3a1214', color: 'var(--red)' }}>Duplicates</span>
              <span className="guide-chip" style={{ background: '#241d0f', color: 'var(--amber)' }}>Moved</span>
              <span className="guide-chip" style={{ background: '#232833', color: 'var(--dim)' }}>Uncertain</span>
              <span className="guide-chip" style={{ background: '#2a1215', color: 'var(--red)' }}>Wrong spot</span>
            </div>
          </li>
          <li>
            <span className="badge b-bsa">BSA-only</span> — no loose files (packed BSA/BA2 + plugin); its exact
            position barely matters.
          </li>
        </ul>
      </Card>

      <Card icon="🗂️" title="Collections">
        <ul>
          <li>
            Every collection you've fetched — count shown is <span className="dim">downloaded / total</span>.
          </li>
          <li>
            The checkbox excludes a collection's order rules from <b>Apply collection order rules</b>; nothing is
            deleted.
          </li>
          <li>
            <b>view order</b> expands its mods in your current install order; dimmed rows aren't downloaded yet.
          </li>
        </ul>
      </Card>

      <Card icon="📥" title="Import">
        <ul>
          <li>
            Paste a collection URL or mod page URL → <b>Fetch from Nexus</b>, or paste/upload a{' '}
            <code>modlist.json</code> → <b>Diff against DB</b>.
          </li>
          <li>
            Result is diffed into new / updated / downgrade / unchanged — tick what you want →{' '}
            <b>Download selected</b>. An updated or downgraded file replaces the older archive it supersedes
            (old file soft-deleted); downgrades are unchecked by default.
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
