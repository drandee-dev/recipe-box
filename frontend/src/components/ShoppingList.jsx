// Shopping list for the planned week. Derived lines come from the plan and are
// merged and grouped by aisle; manual items sit in their own section at the end
// since they have no ingredient text to categorise from.
//
// Presentational, like Planner: App owns the rows and the store calls.

import { useMemo, useState } from 'react'
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

  function submitManual(e) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    onAddManual(text)
    setDraft('')
  }

  return (
    <div className="shopping">
      <div className="planner-weeknav">
        <button className="planner-nav" onClick={() => onWeekChange(-1)} aria-label="Previous week">
          ‹
        </button>
        <div className="planner-weeklabel">
          <strong>{weekRangeLabel(weekStart)}</strong>
          {totalCount > 0 && (
            <span className="shopping-progress">
              {doneCount} of {totalCount} picked up
            </span>
          )}
        </div>
        <button className="planner-nav" onClick={() => onWeekChange(1)} aria-label="Next week">
          ›
        </button>
      </div>

      <form className="shopping-add" onSubmit={submitManual}>
        <input
          type="text"
          placeholder="Add an item (milk, coffee…)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          enterKeyHint="done"
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      {totalCount === 0 && (
        <p className="rb-empty">
          Nothing planned for this week yet. Add meals on the Planner tab and their
          ingredients show up here.
        </p>
      )}

      {groups.map(({ aisle, entries }) => (
        <section key={aisle} className="shopping-aisle">
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

      {manual.length > 0 && (
        <section className="shopping-aisle">
          <h3>Added by you</h3>
          <ul>
            {manual.map((row) => (
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
                  className="planner-remove"
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
