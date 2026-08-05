import { useMemo, useState } from 'react'
import { TAG_VOCABULARY, filterRecipes, normalizeTag, tagCounts } from '../lib/tags.js'

// How many tag chips to show before the "more" toggle. Enough to cover a normal
// box; the toggle exists so a heavily-tagged collection doesn't push the list
// itself off the screen.
const CHIP_LIMIT = 8

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
              <button type="button" className="recipes-clear" onClick={onClearFilters}>
                Clear
              </button>
            </p>
          )}
        </div>
      )}

      {recipes.length > 0 && visible.length === 0 && (
        <p className="rb-empty">
          Nothing matches that. Try fewer words, or clear the filters above.
        </p>
      )}

      {recipes.length === 0 && !loading && (
        <p className="rb-empty">
          No recipes yet. Paste a recipe link above, or copy a post link in Instagram or TikTok
          and tap Paste copied link.
        </p>
      )}

      <ul className="recipes-list">
        {visible.map((r) => {
          const open = openId === r.id
          const tags = r.tags || []
          return (
            <li key={r.id} className="recipes-card">
              <div className="recipes-card-row">
                <button className="recipes-card-head" onClick={() => onOpen(open ? null : r.id)}>
                  {r.image_url && <img src={r.image_url} alt="" loading="lazy" />}
                  <div>
                    <h2>{r.title}</h2>
                    <p className="recipes-meta">
                      {r.ingredients.length > 0
                        ? `${r.ingredients.length} ingredients`
                        : 'Saved link'}
                      {r.total_min ? ` · ${r.total_min} min` : ''}
                      {r.source_url
                        ? ` · ${new URL(r.source_url).hostname.replace('www.', '')}`
                        : ''}
                    </p>
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
                </button>
                {/* A sibling of the open button, not a child: nesting buttons is
                    invalid, and on touch the two targets need their own hit
                    areas anyway. */}
                <button
                  type="button"
                  className={r.favorite ? 'recipes-fav recipes-fav-on' : 'recipes-fav'}
                  aria-pressed={Boolean(r.favorite)}
                  aria-label={r.favorite ? `Unfavorite ${r.title}` : `Favorite ${r.title}`}
                  onClick={() => onToggleFavorite(r)}
                >
                  {r.favorite ? '★' : '☆'}
                </button>
              </div>

              {open && (
                <div className="recipes-detail">
                  {r.ingredients.length === 0 && r.instructions.length === 0 ? (
                    <>
                      {r.description && <p className="recipes-caption">{r.description}</p>}
                      <p className="recipes-meta">
                        No recipe was readable from this post. Open the source and paste the text
                        into Paste recipe text to fill it in.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3>Ingredients</h3>
                      <ul>
                        {r.ingredients.map((ing, i) => (
                          <li key={i}>{ing.raw}</li>
                        ))}
                      </ul>
                      <h3>Steps</h3>
                      <ol>
                        {r.instructions.map((step, i) => (
                          <li key={i}>{step}</li>
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
                        list="recipes-tag-options"
                        placeholder="Add a tag"
                        value={tagDraft}
                        onChange={(e) => setTagDraft(e.target.value)}
                        aria-label="Add a tag"
                      />
                      <button type="submit" disabled={!normalizeTag(tagDraft)}>
                        Add
                      </button>
                    </form>
                  </div>

                  <div className="recipes-actions">
                    {r.source_url && (
                      <a href={r.source_url} target="_blank" rel="noreferrer">
                        View source
                      </a>
                    )}
                    <button className="rb-danger" onClick={() => onDelete(r.id)}>
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
