import { Fragment, useMemo, useState } from 'react'
import { TAG_VOCABULARY, filterRecipes, normalizeTag, tagCounts } from '../lib/tags.js'
import RecipeThumb from './RecipeThumb.jsx'

// How many tag chips to show before the "more" toggle. Enough to cover a normal
// box; the toggle exists so a heavily-tagged collection doesn't push the list
// itself off the screen.
const CHIP_LIMIT = 8

// The first cards load their photos eagerly at high priority. Everything below
// stays lazy: lazy-loading the largest image in the viewport delays it rather
// than saving anything.
const EAGER_CARDS = 2

function hostOf(url) {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace('www.', '')
  } catch {
    // A stored URL that no longer parses shouldn't break the card.
    return ''
  }
}

// Time first, then servings. That's the order every comparable app uses, and it
// matches what you're deciding at six o'clock. Ingredient count moved out: it
// answers "how much shopping", which belongs on the planner.
function metaParts(recipe) {
  const parts = []
  if (recipe.total_min) parts.push(`${recipe.total_min} min`)
  if (recipe.servings) {
    const raw = String(recipe.servings).trim()
    parts.push(/serv|portion|makes/i.test(raw) ? raw : `Serves ${raw}`)
  }
  // A link card has neither, and an empty meta line reads as a rendering bug.
  if (parts.length === 0) {
    parts.push(recipe.ingredients?.length > 0 ? `${recipe.ingredients.length} ingredients` : 'Saved link')
  }
  return parts
}

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
  onSetTags,
  onEdit,
  onWrite,
}) {
  const [allChips, setAllChips] = useState(false)
  const [tagDraft, setTagDraft] = useState('')

  const chips = useMemo(() => tagCounts(recipes), [recipes])
  const shown = allChips ? chips : chips.slice(0, CHIP_LIMIT)
  const favoriteCount = useMemo(() => recipes.filter((r) => r.favorite).length, [recipes])

  const visible = useMemo(
    () => filterRecipes(recipes, { query, tags: activeTags, favoritesOnly }),
    [recipes, query, activeTags, favoritesOnly],
  )

  // An active tag stays visible even once it falls outside the chip limit —
  // otherwise a filter could be on with no way to see or clear it.
  const hiddenActive = activeTags.filter((tag) => !shown.some((c) => c.tag === tag))
  const filtering = query.trim().length > 0 || activeTags.length > 0 || favoritesOnly

  function addTag(recipe, raw) {
    const tag = normalizeTag(raw)
    if (!tag || (recipe.tags || []).includes(tag)) return
    onSetTags(recipe, [...(recipe.tags || []), tag])
  }

  function removeTag(recipe, tag) {
    onSetTags(
      recipe,
      (recipe.tags || []).filter((t) => t !== tag),
    )
  }

  return (
    <>
      {recipes.length > 0 && (
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
            {[...shown, ...hiddenActive.map((tag) => ({ tag, count: null }))].map(
              ({ tag, count }) => {
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
                    {count !== null && <span className="recipes-chip-count">{count}</span>}
                  </button>
                )
              },
            )}
            {chips.length > CHIP_LIMIT && (
              <button
                type="button"
                className="recipes-chip recipes-chip-more"
                onClick={() => setAllChips((v) => !v)}
              >
                {allChips ? 'Fewer tags' : `+${chips.length - CHIP_LIMIT} more`}
              </button>
            )}
          </div>
          {filtering && (
            <p className="recipes-count">
              {visible.length} of {recipes.length}
              <button type="button" className="btn btn-quiet" onClick={onClearFilters}>
                Clear
              </button>
            </p>
          )}
        </div>
      )}

      {recipes.length > 0 && visible.length === 0 && (
        <p className="rb-empty">
          <strong>Nothing matches that</strong>
          Try fewer words, or clear the filters above.
        </p>
      )}

      {recipes.length === 0 && !loading && (
        <p className="rb-empty">
          <strong>The box is empty</strong>
          Paste a recipe link above, or copy a post link in Instagram or TikTok and tap
          Paste copied link.
          <button type="button" className="btn btn-secondary btn-sm" onClick={onWrite}>
            Write one yourself
          </button>
        </p>
      )}

      <ul className="recipes-list">
        {visible.map((r, i) => {
          const open = openId === r.id
          const tags = r.tags || []
          const detailId = `recipe-detail-${r.id}`
          const host = hostOf(r.source_url)
          return (
            <li key={r.id} className="recipes-card">
              {/* The head is a plain container with an overlay button stretched
                  across it, rather than a button wrapping everything. A button may
                  only contain phrasing content, so the old markup — a div holding
                  an h2 and two paragraphs — was invalid, and screen readers lost
                  the heading and read the whole card as one label. This keeps the
                  real h2, keeps the whole row tappable, and puts aria-expanded
                  where it belongs. */}
              <div className="recipes-card-head">
                <RecipeThumb recipe={r} priority={i < EAGER_CARDS} />
                <div className="recipes-card-text">
                  <h2 className="recipes-card-title">{r.title}</h2>
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
                  {host && <span className="recipes-card-src">{host}</span>}
                  {/* Only when there's no photo. With one, the picture says what
                      the dish is; without one the row needs something to say. */}
                  {!r.image_url && r.description && (
                    <p className="recipes-card-desc">{r.description}</p>
                  )}
                  {tags.length > 0 && (
                    <p className="recipes-card-tags">
                      {tags.map((tag) => (
                        <span key={tag} className="recipes-tag">
                          {tag}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  className="recipes-card-toggle"
                  aria-expanded={open}
                  aria-controls={detailId}
                  onClick={() => onOpen(open ? null : r.id)}
                >
                  <span className="rb-offscreen">
                    {open ? `Hide ${r.title}` : `Show ${r.title}`}
                  </span>
                </button>
              </div>

              {open && (
                <div className="recipes-detail" id={detailId}>
                  {r.ingredients.length === 0 && r.instructions.length === 0 ? (
                    <>
                      {r.description && <p className="recipes-caption">{r.description}</p>}
                      <p className="recipes-meta">
                        No recipe was readable from this post. Fill it in by hand with Edit below,
                        or open the source and paste the text into Paste recipe text.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3>Ingredients</h3>
                      <ul>
                        {r.ingredients.map((ing, n) => (
                          <li key={n}>{ing.raw}</li>
                        ))}
                      </ul>
                      <h3>Steps</h3>
                      <ol>
                        {r.instructions.map((step, n) => (
                          <li key={n}>{step}</li>
                        ))}
                      </ol>
                    </>
                  )}

                  <h3>Tags</h3>
                  <div className="recipes-tag-edit">
                    {tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="recipes-tag recipes-tag-remove"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => removeTag(r, tag)}
                      >
                        {tag} <span aria-hidden="true">×</span>
                      </button>
                    ))}
                    <form
                      className="recipes-tag-add"
                      onSubmit={(e) => {
                        e.preventDefault()
                        addTag(r, tagDraft)
                        setTagDraft('')
                      }}
                    >
                      {/* datalist gives the vocabulary as suggestions without
                          preventing anything else being typed. */}
                      <input
                        className="field"
                        list="recipes-tag-options"
                        placeholder="Add a tag"
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        aria-label="Add a tag"
                      />
                      <button
                        type="submit"
                        className="btn btn-secondary btn-sm"
                        disabled={!normalizeTag(tagDraft)}
                      >
                        Add
                      </button>
                    </form>
                  </div>

                  <div className="recipes-actions">
                    {/* Favouriting moved off the card face and in here. It's a
                        once-per-recipe action, and none of the comparable apps
                        spends a control on every row for it — they all rely on a
                        saved filter, which the Favorites chip already is. */}
                    <button
                      type="button"
                      className={r.favorite ? 'recipes-fav recipes-fav-on' : 'recipes-fav'}
                      aria-pressed={Boolean(r.favorite)}
                      onClick={() => onToggleFavorite(r)}
                    >
                      <span className="recipes-fav-star" aria-hidden="true">
                        {r.favorite ? '★' : '☆'}
                      </span>
                      {r.favorite ? 'Favorited' : 'Favorite'}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(r)}>
                      Edit
                    </button>
                    {r.source_url && (
                      <a
                        className="btn btn-secondary btn-sm"
                        href={r.source_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View source
                      </a>
                    )}
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => onDelete(r.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <datalist id="recipes-tag-options">
        {TAG_VOCABULARY.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </>
  )
}
