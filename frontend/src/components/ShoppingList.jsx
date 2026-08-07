// Shopping list for the planned week. Derived lines come from the plan and are
// merged and grouped by aisle; manual items sit in their own section at the end
// since they have no ingredient text to categorise from.
//
// Presentational, like Planner: App owns the rows and the store calls.

import { useEffect, useMemo, useState } from 'react'
import { buildShoppingList, formatQuantity, formatSource, groupByAisle } from '../lib/ingredients.js'
import { addDays, toISODate, weekRangeLabel } from '../lib/dates.js'

function DerivedItem({ item, checked, onToggle }) {
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
          <span className="shopping-item-from">
            {item.sources.map(formatSource).join(' · ')}
          </span>
        </span>
      </label>
    </li>
  )
}

export default function ShoppingList({
  weekStart,
  plan,
  recipes,
  overlay,
  onWeekChange,
  onToggleDerived,
  onToggleManual,
  onAddManual,
  onRemoveManual,
}) {
  const [draft, setDraft] = useState('')

  // App fetches a week at a time, so these arrays are normally this week's rows
  // already. Filtering anyway is what keeps last week's list off the screen when
  // a week change couldn't be fetched — offline with no cached copy of the week
  // being navigated to, the old rows are still in state. Planner never showed
  // this because it buckets entries by exact date.
  const week = toISODate(weekStart)
  const weekEnd = toISODate(addDays(weekStart, 6))
  const thisWeek = useMemo(
    () => plan.filter((e) => e.plan_date >= week && e.plan_date <= weekEnd),
    [plan, week, weekEnd],
  )
  const rows = useMemo(() => overlay.filter((r) => r.week_start === week), [overlay, week])

  const derived = useMemo(() => buildShoppingList(thisWeek, recipes), [thisWeek, recipes])
  const groups = useMemo(() => groupByAisle(derived), [derived])

  const checkedKeys = useMemo(() => {
    const set = new Set()
    for (const row of rows) if (row.kind === 'check' && row.checked) set.add(row.name)
    return set
  }, [rows])

  const manual = rows.filter((row) => row.kind === 'manual')

  const totalCount = derived.length + manual.length
  const doneCount =
    derived.filter((item) => checkedKeys.has(item.key)).length +
    manual.filter((row) => row.checked).length

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
            <strong>{weekRangeLabel(weekStart)}</strong>
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

      {totalCount === 0 && (
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
          <ul>
            {entries.map((entry) =>
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
                />
              ),
            )}
          </ul>
        </section>
      ))}

      {visibleManual.length > 0 && (
        <section className="shopping-aisle">
          <h3>Added by you</h3>
          <ul>
            {visibleManual.map((row) => (
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
                  <span className="shopping-item-text">{row.name}</span>
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
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
