import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { filterRecipes, tagCounts } from '../lib/tags.js'
import { usePendingCommit } from '../lib/usePendingCommit.js'
import { groupByRecency, metaParts } from '../lib/recipes.js'
import RecipeDetail from './RecipeDetail.jsx'
import RecipeThumb from './RecipeThumb.jsx'

// The first cards load their photos eagerly at high priority. Everything below
// stays lazy: lazy-loading the largest image in the viewport delays it rather
// than saving anything. Two columns put two cells per row, so this covers the
// first two rows — all of which are above the fold on a 390×844 phone.
const EAGER_CARDS = 4

// Same window the planner's meal removal uses, and for the same reason: long
// enough to notice the toast, short enough that you aren't left wondering
// whether the delete happened.

export default function RecipeList({
  recipes,
  loading,
  query,
  onQueryChange,
  activeTags,
  onToggleTag,
  favoritesOnly,
  onToggleFavoritesOnly,
  onClearFilters,
  openId,
  onOpen,
  onDelete,
  onToggleFavorite,
  onAssign,
  onEdit,
  onWrite,
}) {
  // Deleting is the one action here whose failure mode is losing a recipe, so it
  // gets an undo window rather than a confirm dialog — undo costs one tap and
  // only when you were wrong, a dialog costs one every time you were right
  // (finding 14). App is told nothing until the window lapses, so undo is a
  // cancelled timer rather than a re-insert that has to get the row's position
  // and id back. The window itself — flush-on-second, commit-on-unmount — lives
  // in usePendingCommit, shared with the planner's meal removal.
  const {
    pending: pendingDelete,
    start: startPendingDelete,
    undo: undoDelete,
  } = usePendingCommit(useCallback((recipe) => onDelete(recipe.id), [onDelete]))

  function startDelete(recipe) {
    onOpen(null)
    startPendingDelete(recipe)
  }

  // Everything below counts from `shown`, never `recipes`: a recipe inside its
  // undo window is gone as far as the list, the chip counts and the empty state
  // are concerned. It is still in App's state, which is what makes undo free.
  const shown = useMemo(
    () => (pendingDelete ? recipes.filter((r) => r.id !== pendingDelete.id) : recipes),
    [recipes, pendingDelete],
  )

  const chips = useMemo(() => tagCounts(shown), [shown])
  const favoriteCount = useMemo(() => shown.filter((r) => r.favorite).length, [shown])

  const visible = useMemo(
    () => filterRecipes(shown, { query, tags: activeTags, favoritesOnly }),
    [shown, query, activeTags, favoritesOnly],
  )

  const filtering = query.trim().length > 0 || activeTags.length > 0 || favoritesOnly
  const open = shown.find((r) => r.id === openId) || null

  // Ruled section labels over the grid, and only when they earn their place.
  // Filtering drops them because three headings over a result of four recipes
  // is worse than none, and "when did I save this" is not what a search is
  // asking. A single band drops them too: one label over the entire list is a
  // title for the screen, which the wordmark already is.
  const sections = useMemo(() => {
    if (filtering) return [{ label: null, recipes: visible }]
    const groups = groupByRecency(visible)
    return groups.length > 1 ? groups : [{ label: null, recipes: visible }]
  }, [visible, filtering])

  // Eagerness counts down the whole grid, not each section: the first two rows
  // are above the fold whichever band they fall in, and a per-section index
  // would make every band's first cells eager however far down the page it sat.
  const order = useMemo(() => new Map(visible.map((r, i) => [r.id, i])), [visible])

  return (
    <>
      {shown.length > 0 && (
        <div className="recipes-filters">
          <div className="recipes-search">
            <input
              type="search"
              placeholder="Search recipes, ingredients, tags"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              aria-label="Search recipes"
            />
          </div>
          <div className="recipes-chips">
            {favoriteCount > 0 && (
              <button
                type="button"
                className={favoritesOnly ? 'recipes-chip recipes-chip-on' : 'recipes-chip'}
                aria-pressed={favoritesOnly}
                onClick={onToggleFavoritesOnly}
              >
                ★ Favorites <span className="recipes-chip-count">{favoriteCount}</span>
              </button>
            )}
            {chips.map(({ tag, count }) => {
              const on = activeTags.includes(tag)
              return (
                <button
                  key={tag}
                  type="button"
                  className={on ? 'recipes-chip recipes-chip-on' : 'recipes-chip'}
                  aria-pressed={on}
                  onClick={() => onToggleTag(tag)}
                >
                  {tag}
                  <span className="recipes-chip-count">{count}</span>
                </button>
              )
            })}
          </div>
          {filtering && (
            <p className="recipes-count">
              {visible.length} of {shown.length}
              <button type="button" className="btn btn-quiet" onClick={onClearFilters}>
                Clear
              </button>
            </p>
          )}
        </div>
      )}

      {shown.length > 0 && visible.length === 0 && (
        <p className="rb-empty">
          <strong>Nothing matches that</strong>
          Try fewer words, or clear the filters above.
        </p>
      )}

      {shown.length === 0 && !loading && (
        <p className="rb-empty">
          <strong>The box is empty</strong>
          Tap the + button to paste a link, paste recipe text, or write one in.
          <button type="button" className="btn btn-secondary btn-sm" onClick={onWrite}>
            Write one yourself
          </button>
        </p>
      )}

      {sections.map(({ label, recipes: inSection }) => (
        <Fragment key={label || 'all'}>
          {/* Decorative, and deliberately not a heading. A heading here would
              have to sit between the wordmark's h1 and each cell's h2, which
              means either demoting every title to h3 or skipping a level on the
              filtered view that has no rules at all. The list carries the name
              instead: a screen reader reads "Recently saved, list, 4 items",
              which is what the rule is saying visually, said once. */}
          {label && (
            <p className="recipes-rule" aria-hidden="true">
              <span>{label}</span>
            </p>
          )}
          <ul className="recipes-grid" aria-label={label || undefined}>
            {inSection.map((r) => (
              /* The cell is a plain container with an overlay button stretched
                 across it, rather than a button wrapping everything. A button may
                 only contain phrasing content, so wrapping an h2 in one is
                 invalid and screen readers lose the heading and read the whole
                 cell as one label. This keeps the real h2 and keeps the whole
                 cell tappable. */
              <li key={r.id} className="recipes-cell">
                <RecipeThumb recipe={r} priority={(order.get(r.id) ?? 99) < EAGER_CARDS} />
                {/* A state, not a control — tapping a favourite here should open
                    the recipe like any other cell, and un-favouriting lives in
                    the sheet's head where it did before. So it is marked
                    aria-hidden and the fact is folded into the overlay button's
                    label instead, which is the thing a screen reader announces. */}
                {r.favorite && (
                  <span className="recipes-cell-star" aria-hidden="true">
                    ★
                  </span>
                )}
                <h2 className="recipes-cell-title">{r.title}</h2>
                <p className="recipes-meta">
                  {/* Fragment, not a wrapping span: the separator dot is sized
                      as a flex item, so it has to be a direct child of the flex
                      container or its width and height are ignored. */}
                  {metaParts(r).map((part, n) => (
                    <Fragment key={part}>
                      {n > 0 && <span className="recipes-meta-dot" />}
                      <span>{part}</span>
                    </Fragment>
                  ))}
                </p>
                {/* aria-haspopup, not aria-expanded: this opens a dialog over the
                    page now rather than expanding a region inside the cell, and
                    aria-expanded would promise content that appears in place. */}
                <button
                  type="button"
                  className="recipes-cell-toggle"
                  aria-haspopup="dialog"
                  onClick={() => onOpen(r.id)}
                >
                  <span className="rb-offscreen">
                    Open {r.title}
                    {r.favorite ? ', favourite' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Fragment>
      ))}

      {open && (
        <RecipeDetail
          // Keyed by recipe: opening a different recipe must not inherit the
          // last one's ticked ingredients or a half-filled plan slot.
          key={open.id}
          recipe={open}
          onClose={() => onOpen(null)}
          onEdit={onEdit}
          onDelete={() => startDelete(open)}
          onToggleFavorite={onToggleFavorite}
          onAssign={onAssign}
        />
      )}

      {pendingDelete && (
        <div className="rb-toast" role="status">
          <span>Deleted {pendingDelete.title}</span>
          <button type="button" className="rb-toast-undo" onClick={undoDelete}>
            Undo
          </button>
        </div>
      )}
    </>
  )
}
