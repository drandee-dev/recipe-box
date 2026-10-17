// Shopping list for the planned week. Derived lines come from the plan and are
// merged and grouped by aisle; manual items sit in their own section at the end
// since they have no ingredient text to categorise from.
//
// Presentational, like Planner: App owns the rows and the store calls.
//
// Pass C added three layers over the derived lines, all of them display only:
// staples (folded away), a moved aisle, and your shop's aisle order. They live in
// `prefs` and are applied in `applyPrefs`; none of them touches a line's key, so
// a tick means the same thing with or without them.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AISLE_ORDER,
  applyPrefs,
  buildShoppingList,
  formatQuantity,
  formatSource,
  formatSources,
  groupByAisle,
  shoppingText,
} from '../lib/ingredients.js'
import { addDays, toISODate, weekRangeLabel } from '../lib/dates.js'
import { useUnits } from '../lib/useUnits.js'
import { usePendingCommit } from '../lib/usePendingCommit.js'
import { effectiveAisleOrder, moveAisle, setAisle, toggleStaple } from '../lib/prefs.js'
import Sheet from './Sheet.jsx'

function DerivedItem({ item, checked, onToggle, onMore }) {
  return (
    <li className={checked ? 'shopping-item shopping-item-done' : 'shopping-item'}>
      <label>
        <input type="checkbox" checked={checked} onChange={() => onToggle(item.key, !checked)} />
        <span className="shopping-item-text">
          {/* An unparsed line keeps its original wording, since guessing at a
              tidier name would be inventing detail. */}
          {item.parsed ? (
            <>
              {formatQuantity(item.qty, item.unit) && (
                <strong>{formatQuantity(item.qty, item.unit)} </strong>
              )}
              {item.name}
            </>
          ) : (
            item.raw
          )}
          <span className="shopping-item-from">{formatSources(item.sources)}</span>
        </span>
      </label>
      {/* Only a line with a name to remember gets the menu. An unparsed line
          merges with nothing, so a staple or an aisle for it would match only
          itself. */}
      {onMore && item.nameKey && (
        <button
          type="button"
          className="btn btn-quiet btn-icon shopping-more"
          onClick={() => onMore(item)}
          aria-label={`Aisle and staple settings for ${item.name}`}
        >
          ⋯
        </button>
      )}
    </li>
  )
}

// One item's settings: whether it is a staple, and which aisle it lives in. Both
// are remembered for every week, which is why they are here and not on the row.
function ItemSheet({ item, prefs, onChangePrefs, onClose }) {
  const order = effectiveAisleOrder(prefs)
  const isStaple = prefs.staples.includes(item.nameKey)
  return (
    <Sheet title={item.name} closeLabel="Done" onClose={onClose}>
      {/* The row shows the first recipe and "+N"; the whole list is here. */}
      <p className="shopping-sheet-from">
        <strong>On the list for</strong> {item.sources.map(formatSource).join(' · ')}
      </p>
      <p className="shopping-sheet-note">
        These are remembered for every week. They change where the item is shown, never what
        is on the list.
      </p>
      <button
        type="button"
        className="btn btn-secondary btn-block"
        aria-pressed={isStaple}
        onClick={() => onChangePrefs(toggleStaple(prefs, item.nameKey))}
      >
        {isStaple ? 'Not a staple any more' : 'I always have this (staple)'}
      </button>
      <h3 className="shopping-sheet-heading">Aisle</h3>
      <div className="shopping-aisle-chips">
        {order.map((aisle) => (
          <button
            key={aisle}
            type="button"
            className={aisle === item.aisle ? 'planner-chip planner-chip-active' : 'planner-chip'}
            aria-pressed={aisle === item.aisle}
            onClick={() => onChangePrefs(setAisle(prefs, item.nameKey, aisle, item.defaultAisle))}
          >
            {aisle}
          </button>
        ))}
      </div>
      {item.aisle !== item.defaultAisle && (
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => onChangePrefs(setAisle(prefs, item.nameKey, item.defaultAisle, item.defaultAisle))}
        >
          Put it back in {item.defaultAisle}
        </button>
      )}
    </Sheet>
  )
}

// Your shop's order. Up and down buttons rather than a drag: a drag list needs a
// library or a gesture of its own, and seven rows are quick to place by hand.
function AisleOrderSheet({ prefs, onChangePrefs, onClose }) {
  const order = effectiveAisleOrder(prefs)
  return (
    <Sheet title="Aisle order" closeLabel="Done" onClose={onClose}>
      <p className="shopping-sheet-note">
        Put the aisles in the order you walk your shop. The list follows it every week.
      </p>
      <ol className="shopping-order">
        {order.map((aisle, n) => (
          <li key={aisle}>
            <span>{aisle}</span>
            <button
              type="button"
              className="btn btn-quiet btn-icon"
              disabled={n === 0}
              onClick={() => onChangePrefs(moveAisle(prefs, aisle, -1))}
              aria-label={`Move ${aisle} up`}
            >
              ↑
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-icon"
              disabled={n === order.length - 1}
              onClick={() => onChangePrefs(moveAisle(prefs, aisle, 1))}
              aria-label={`Move ${aisle} down`}
            >
              ↓
            </button>
          </li>
        ))}
      </ol>
      {prefs.aisle_order.length > 0 && (
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => onChangePrefs({ ...prefs, aisle_order: [] })}
        >
          Use the standard order
        </button>
      )}
    </Sheet>
  )
}

export default function ShoppingList({
  weekStart,
  plan,
  recipes,
  overlay,
  prefs,
  onChangePrefs,
  onWeekChange,
  onToggleDerived,
  onToggleManual,
  onAddManual,
  onRemoveManual,
  onUnassign,
}) {
  const [draft, setDraft] = useState('')
  const [itemOpen, setItemOpen] = useState(null)
  const [orderOpen, setOrderOpen] = useState(false)
  const [shareNote, setShareNote] = useState('')

  // The strip's ✕ takes a recipe's meals off the plan, which is destructive, so it
  // gets the same undo window a swiped-away meal has. The rows are hidden at
  // once; the plan is only told when the window lapses.
  const {
    pending: pendingRemoval,
    start: startRemoval,
    undo: undoRemoval,
  } = usePendingCommit(
    useCallback(
      ({ entryIds, rowIds }) => {
        entryIds.forEach((id) => onUnassign(id))
        rowIds.forEach((id) => onRemoveManual(id))
      },
      [onUnassign, onRemoveManual],
    ),
  )

  // App fetches a week at a time, so these arrays are normally this week's rows
  // already. Filtering anyway is what keeps last week's list off the screen when
  // a week change couldn't be fetched — offline with no cached copy of the week
  // being navigated to, the old rows are still in state. Planner never showed
  // this because it buckets entries by exact date.
  const week = toISODate(weekStart)
  const weekEnd = toISODate(addDays(weekStart, 6))
  const thisWeek = useMemo(
    () =>
      plan.filter(
        (e) => e.plan_date >= week && e.plan_date <= weekEnd && !pendingRemoval?.entryIds.includes(e.id),
      ),
    [plan, week, weekEnd, pendingRemoval],
  )
  const rows = useMemo(
    () => overlay.filter((r) => r.week_start === week && !pendingRemoval?.rowIds.includes(r.id)),
    [overlay, week, pendingRemoval],
  )

  // The list is written in the standing unit setting (account sheet). Per-recipe
  // flips on the recipe sheet do not reach it: a shopping list is one list.
  const units = useUnits()
  const derived = useMemo(
    () => applyPrefs(buildShoppingList(thisWeek, recipes, units), prefs),
    [thisWeek, recipes, units, prefs],
  )
  const order = useMemo(() => (prefs ? effectiveAisleOrder(prefs) : AISLE_ORDER), [prefs])
  const stapleItems = useMemo(() => derived.filter((i) => i.staple), [derived])
  const groups = useMemo(() => groupByAisle(derived.filter((i) => !i.staple), order), [derived, order])

  const checkedKeys = useMemo(() => {
    const set = new Set()
    for (const row of rows) if (row.kind === 'check' && row.checked) set.add(row.name)
    return set
  }, [rows])

  const manual = rows.filter((row) => row.kind === 'manual')

  // Staples are things you already have; counting them would hold the bar short
  // of full for a list you have finished.
  const counted = derived.filter((item) => !item.staple)
  const totalCount = counted.length + manual.length
  const doneCount =
    counted.filter((item) => checkedKeys.has(item.key)).length +
    manual.filter((row) => row.checked).length

  // The recipes behind this list, with how many meals each is (strip, ReciMe's
  // pattern). A recipe appears if it is planned this week or if lines were added
  // from it with "To list".
  const sourceStrip = useMemo(() => {
    const byRecipe = new Map()
    const touch = (id) => {
      if (!byRecipe.has(id)) {
        byRecipe.set(id, { recipeId: id, title: recipes.find((r) => r.id === id)?.title, meals: 0, entryIds: [], rowIds: [] })
      }
      return byRecipe.get(id)
    }
    for (const entry of thisWeek) {
      // A leftovers meal puts nothing on this list, so its recipe is not one of
      // the recipes behind it.
      if (entry.leftover) continue
      const s = touch(entry.recipe_id)
      s.meals += 1
      s.entryIds.push(entry.id)
    }
    for (const row of manual) {
      if (!row.recipe_id) continue
      const s = touch(row.recipe_id)
      s.rowIds.push(row.id)
    }
    return [...byRecipe.values()].filter((s) => s.title)
  }, [thisWeek, manual, recipes])

  // "Clear picked" (finding 22) never deletes or unchecks anything — a picked
  // item is still picked next time this week's list is opened. It only hides
  // already-checked rows from view, client-side, so the trip stays legible
  // without reordering rows under a moving finger (which is what causes
  // mistaps). A fresh week starts with nothing to hide anyway, but reset
  // explicitly so a stale hide from last week's session can't carry over.
  const [hideDone, setHideDone] = useState(false)
  useEffect(() => setHideDone(false), [week])

  const visibleGroups = useMemo(() => {
    if (!hideDone) return groups
    return groups
      .map((g) => ({
        aisle: g.aisle,
        entries: g.entries
          .map((entry) =>
            entry.type === 'group'
              ? { ...entry, items: entry.items.filter((item) => !checkedKeys.has(item.key)) }
              : entry,
          )
          .filter((entry) =>
            entry.type === 'group' ? entry.items.length > 0 : !checkedKeys.has(entry.item.key),
          ),
      }))
      .filter((g) => g.entries.length > 0)
  }, [groups, hideDone, checkedKeys])

  const visibleManual = hideDone ? manual.filter((row) => !row.checked) : manual

  function submitManual(e) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onAddManual(text)
    setDraft('')
  }

  // What is still to buy, as text, through the share sheet where there is one
  // and the clipboard where there is not. Not a household list: it sends a copy,
  // and whoever gets it ticks their own.
  const canShare = typeof navigator !== 'undefined' && Boolean(navigator.share || navigator.clipboard?.writeText)
  async function share() {
    const text = shoppingText({
      label: `Shopping list, ${weekRangeLabel(weekStart)}`,
      groups,
      manual,
      isPicked: (key) => checkedKeys.has(key),
    })
    if (!text) {
      setShareNote('Nothing left to share.')
      return
    }
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Shopping list', text })
        setShareNote('')
      } else {
        await navigator.clipboard.writeText(text)
        setShareNote('Copied. Paste it into a message.')
      }
    } catch (err) {
      // Closing the share sheet is a cancel, not a failure.
      if (err?.name === 'AbortError') return
      setShareNote("Couldn't share the list. Try again.")
    }
  }
  useEffect(() => {
    if (!shareNote) return undefined
    const t = setTimeout(() => setShareNote(''), 4000)
    return () => clearTimeout(t)
  }, [shareNote])

  const editable = Boolean(prefs)
  const openMenu = editable ? setItemOpen : undefined
  // The sheet reads the item from the live list so a toggle shows at once.
  const sheetItem = itemOpen ? derived.find((i) => i.key === itemOpen) : null

  function renderEntries(entries) {
    return entries.map((entry) =>
      entry.type === 'group' ? (
        // Variants stay separately checkable: they are separate things
        // to pick up, and no total is shown across them.
        <li key={entry.key} className="shopping-group">
          <span className="shopping-group-head">{entry.base}</span>
          <ul>
            {entry.items.map((item) => (
              <DerivedItem
                key={item.key}
                item={item}
                checked={checkedKeys.has(item.key)}
                onToggle={onToggleDerived}
                onMore={openMenu && ((it) => openMenu(it.key))}
              />
            ))}
          </ul>
        </li>
      ) : (
        <DerivedItem
          key={entry.key}
          item={entry.item}
          checked={checkedKeys.has(entry.item.key)}
          onToggle={onToggleDerived}
          onMore={openMenu && ((it) => openMenu(it.key))}
        />
      ),
    )
  }

  return (
    <div className="shopping">
      {/* Sticky (finding 23): pinned at the top of the scroll rather than
          scrolling away with the list, the same treatment .recipes-filters
          uses — the header above it isn't itself sticky, so this just takes
          over the top edge once it scrolls past. */}
      <div className="shopping-header">
        <div className="planner-weeknav">
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            onClick={() => onWeekChange(-1)}
            aria-label="Previous week"
          >
            ‹
          </button>
          <div className="planner-weeklabel">
            <strong className="week-label">{weekRangeLabel(weekStart)}</strong>
            {/* Riding beside the thin bar below would drag it up to .btn's
                44px floor along with it (a real bug caught mid-pass: a fixed
                --shopping-header-h undershot the actual content and the
                overflow quietly hid under the next sticky aisle heading).
                Nested here instead, same spot Planner's "This week" link
                uses — the row's height already budgets for a second line. */}
            {doneCount > 0 && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setHideDone((v) => !v)}
              >
                {hideDone ? `Show ${doneCount} picked up` : 'Clear picked'}
              </button>
            )}
          </div>
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            onClick={() => onWeekChange(1)}
            aria-label="Next week"
          >
            ›
          </button>
        </div>

        {totalCount > 0 && (
          <div
            className="shopping-progress-bar"
            role="progressbar"
            aria-valuenow={doneCount}
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-label={`${doneCount} of ${totalCount} picked up`}
          >
            <div
              className="shopping-progress-fill"
              style={{ width: `${(doneCount / totalCount) * 100}%` }}
            />
          </div>
        )}
      </div>

      <form className="shopping-add" onSubmit={submitManual}>
        <input
          className="field"
          type="text"
          placeholder="Add an item (milk, coffee…)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          enterKeyHint="done"
        />
        <button type="submit" className="btn btn-primary btn-lg" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      {/* One scrolling bar: the list's two tools, then the recipes behind it. It
          was two rows (the tools, then the strip), 120px before the first item. */}
      {(canShare || editable || sourceStrip.length > 0) && (
        <div className="shopping-tools">
          {canShare && (
            <button type="button" className="btn btn-secondary" onClick={share}>
              Share list
            </button>
          )}
          {editable && (
            <button type="button" className="btn btn-quiet" onClick={() => setOrderOpen(true)}>
              Aisle order
            </button>
          )}
          {sourceStrip.length > 0 && (
            <ul className="shopping-strip" aria-label="Recipes on this list">
              {sourceStrip.map((s) => (
                <li key={s.recipeId} className="shopping-strip-chip">
                  <span className="shopping-strip-title">
                    {s.title}
                    {s.meals > 1 ? ` ×${s.meals}` : ''}
                  </span>
                  <button
                    type="button"
                    className="shopping-strip-x"
                    onClick={() => startRemoval({ title: s.title, entryIds: s.entryIds, rowIds: s.rowIds })}
                    aria-label={`Take ${s.title} off this week`}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Outside the scrolling bar, so the answer to Share is never scrolled out of
          sight. Only present for the few seconds it is true. */}
      {shareNote && (
        <p className="shopping-tools-note" role="status">
          {shareNote}
        </p>
      )}

      {totalCount === 0 && stapleItems.length === 0 && (
        <p className="rb-empty">
          <strong>No list for this week</strong>
          Add meals on the Planner tab and their ingredients gather here, merged and
          sorted by aisle. You can also type anything you need into the box above.
        </p>
      )}

      {totalCount > 0 && hideDone && visibleGroups.length === 0 && visibleManual.length === 0 && (
        <p className="rb-empty">
          <strong>Everything's picked up</strong>
          <button type="button" className="btn btn-quiet" onClick={() => setHideDone(false)}>
            Show the {doneCount} you already checked
          </button>
        </p>
      )}

      {visibleGroups.map(({ aisle, entries }) => (
        <section key={aisle} className="shopping-aisle">
          {/* Sticky (finding 23): the aisle you're standing in front of stays
              named at the top instead of scrolling off, offset by
              --shopping-header-h so it settles in below the week nav and
              progress bar rather than under them. */}
          <h3>{aisle}</h3>
          <ul>{renderEntries(entries)}</ul>
        </section>
      ))}

      {visibleManual.length > 0 && (
        <section className="shopping-aisle">
          <h3>Added by you</h3>
          <ul>
            {visibleManual.map((row) => {
              const from = row.recipe_id ? recipes.find((r) => r.id === row.recipe_id)?.title : null
              return (
                <li
                  key={row.id}
                  className={row.checked ? 'shopping-item shopping-item-done' : 'shopping-item'}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={row.checked}
                      onChange={() => onToggleManual(row.id, !row.checked)}
                    />
                    <span className="shopping-item-text">
                      {row.name}
                      {from && <span className="shopping-item-from">{from}</span>}
                    </span>
                  </label>
                  <button
                    type="button"
                    className="btn btn-danger btn-icon"
                    onClick={() => onRemoveManual(row.id)}
                    aria-label={`Remove ${row.name}`}
                  >
                    ×
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* Folded, not hidden: you can still open it and pick something up that
          turns out to be low. Native <details>, so it needs no state of its own. */}
      {stapleItems.length > 0 && (
        <details className="shopping-staples">
          <summary>
            Staples <span className="shopping-staples-count">{stapleItems.length}</span>
          </summary>
          <ul>
            {stapleItems.map((item) => (
              <DerivedItem
                key={item.key}
                item={item}
                checked={checkedKeys.has(item.key)}
                onToggle={onToggleDerived}
                onMore={openMenu && ((it) => openMenu(it.key))}
              />
            ))}
          </ul>
        </details>
      )}

      {pendingRemoval && (
        <div className="rb-toast" role="status">
          <span>Took {pendingRemoval.title} off this week</span>
          <button type="button" className="rb-toast-undo" onClick={undoRemoval}>
            Undo
          </button>
        </div>
      )}

      {sheetItem && prefs && (
        <ItemSheet item={sheetItem} prefs={prefs} onChangePrefs={onChangePrefs} onClose={() => setItemOpen(null)} />
      )}
      {orderOpen && prefs && (
        <AisleOrderSheet prefs={prefs} onChangePrefs={onChangePrefs} onClose={() => setOrderOpen(false)} />
      )}
    </div>
  )
}
