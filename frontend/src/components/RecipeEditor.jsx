// Write a recipe by hand, or repair one an import got wrong.
//
// The second job is the reason this exists. Before it, a caption the model read
// badly could only be fixed by deleting the recipe and importing it again, which
// throws away the tags, the favourite and any plan entry pointing at it — and
// re-runs an extraction that already failed once. Editing keeps the row and its
// id, so everything hanging off the recipe survives being corrected.
//
// One line per ingredient, not three fields. `readIngredient` in lib/ingredients
// already reads a plain line when the structured fields are absent, so a typed
// line loses nothing; three inputs per row would be three taps per ingredient on
// a phone and a wall of boxes for a sixteen-line recipe.

import { useMemo, useRef, useState } from 'react'
import Sheet from './Sheet.jsx'
import RecipeThumb from './RecipeThumb.jsx'
import { TAG_VOCABULARY, normalizeTag } from '../lib/tags.js'

// Rows carry their own key. Using the array index would be fine until the first
// removal, at which point every row below shifts onto a new index, React reuses
// the wrong DOM node, and the caret jumps out of the field being typed in.
let rowSeq = 0
function makeRow(text, original = null) {
  rowSeq += 1
  return { key: `row-${rowSeq}`, text, original }
}

// An ingredient's line is what the user typed if it was ever typed, and the
// import's `raw` otherwise. `item` is the fallback for a structured line that
// somehow arrived without one.
function ingredientText(ing) {
  if (typeof ing === 'string') return ing
  return ing?.raw || ing?.item || ''
}

function minutesField(value) {
  return value === null || value === undefined ? '' : String(value)
}

function toMinutes(value) {
  const n = Number.parseInt(String(value).trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function isImageLink(value) {
  if (!value) return true
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function initialForm(recipe) {
  return {
    title: recipe?.title || '',
    description: recipe?.description || '',
    image_url: recipe?.image_url || '',
    source_url: recipe?.source_url || '',
    servings: recipe?.servings || '',
    prep_min: minutesField(recipe?.prep_min),
    cook_min: minutesField(recipe?.cook_min),
    total_min: minutesField(recipe?.total_min),
  }
}

// What the dirty check compares. Row keys are excluded on purpose: they are
// identity for React, not content, and a row added then removed would otherwise
// leave the form looking changed when it isn't.
function snapshot(form, ingredients, steps, tags) {
  return JSON.stringify({
    form,
    ingredients: ingredients.map((r) => r.text),
    steps: steps.map((r) => r.text),
    tags,
  })
}

export default function RecipeEditor({ recipe, onSave, onClose }) {
  const editing = Boolean(recipe)

  const [form, setForm] = useState(() => initialForm(recipe))
  const [ingredients, setIngredients] = useState(() =>
    (recipe?.ingredients || []).map((ing) => makeRow(ingredientText(ing), ing)),
  )
  const [steps, setSteps] = useState(() =>
    (recipe?.instructions || []).map((step) => makeRow(String(step || ''), step)),
  )
  const [tags, setTags] = useState(() => [...(recipe?.tags || [])])
  const [tagDraft, setTagDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const formId = useRef(`editor-${Math.random().toString(36).slice(2, 9)}`)
  const initial = useRef(snapshot(initialForm(recipe), ingredients, steps, tags))
  const dirty = snapshot(form, ingredients, steps, tags) !== initial.current

  const title = form.title.trim()
  const imageOk = isImageLink(form.image_url.trim())
  const canSave = title.length > 0 && imageOk && !saving

  // Only for the thumbnail beside the link field, so a pasted URL can be seen to
  // be the right photo before it is saved. RecipeThumb takes a recipe, and its
  // fallback tile is keyed off the title, which is exactly what should show
  // while the field is empty.
  const preview = useMemo(
    () => ({ ...recipe, title: title || 'New recipe', image_url: form.image_url.trim(), image_thumb_url: null }),
    [recipe, title, form.image_url],
  )

  function set(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  function updateRow(setRows, key, text) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, text } : row)))
  }

  function removeRow(setRows, key) {
    setRows((prev) => prev.filter((row) => row.key !== key))
  }

  function moveRow(setRows, key, direction) {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  function addTag(raw) {
    const tag = normalizeTag(raw)
    if (!tag || tags.includes(tag)) return
    setTags((prev) => [...prev, tag])
  }

  function requestClose() {
    if (dirty && !saving) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    setError('')

    const prep = toMinutes(form.prep_min)
    const cook = toMinutes(form.cook_min)
    const stated = toMinutes(form.total_min)

    const values = {
      title,
      description: form.description.trim() || null,
      image_url: form.image_url.trim() || null,
      source_url: form.source_url.trim() || null,
      servings: form.servings.trim() || null,
      prep_min: prep,
      cook_min: cook,
      // The card's meta line reads total_min, so a recipe with prep and cook
      // filled in and total left blank would render as untimed. Adding them is
      // what the person filling in the first two fields meant.
      total_min: stated ?? (prep !== null || cook !== null ? (prep || 0) + (cook || 0) : null),
      ingredients: ingredients
        .map((row) => {
          const text = row.text.trim()
          if (!text) return null
          // An untouched line keeps the object it arrived with, structured
          // fields and all. A changed one drops them: `readIngredient` prefers
          // `item`/`qty`/`unit` over the raw line, so leaving stale ones behind
          // would put the old ingredient on the shopping list under the new
          // line's name. Nulled, the parser reads the text — the same path
          // every recipe from a JSON-LD site already takes.
          if (row.original && typeof row.original === 'object' && ingredientText(row.original) === text) {
            return row.original
          }
          return { raw: text, item: null, qty: null, unit: null }
        })
        .filter(Boolean),
      instructions: steps.map((row) => row.text.trim()).filter(Boolean),
      tags,
    }

    try {
      await onSave(values)
      onClose()
    } catch (err) {
      setSaving(false)
      setError(err?.message || 'That could not be saved. Try again.')
    }
  }

  return (
    <Sheet
      title={editing ? 'Edit recipe' : 'New recipe'}
      onClose={requestClose}
      closeLabel={dirty ? 'Discard' : 'Cancel'}
      action={
        confirmDiscard ? null : (
          // Outside the <form> in the DOM, attached to it by id. That is what
          // lets the head hold the submit without the form having to wrap the
          // whole sheet, and it keeps Enter-to-submit working from any field.
          <button type="submit" form={formId.current} className="btn btn-primary btn-sm" disabled={!canSave}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )
      }
    >
      {confirmDiscard ? (
        <div className="editor-confirm" role="alertdialog" aria-label="Discard changes">
          <p>
            <strong>Discard your changes?</strong>
            Nothing here has been saved yet.
          </p>
          <div className="editor-confirm-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button type="button" className="btn btn-danger" onClick={onClose}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <form className="editor" id={formId.current} onSubmit={handleSubmit}>
          <label className="editor-field">
            <span className="editor-label">Title</span>
            <input
              className="field"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              placeholder="Nan's apple cake"
              autoFocus={!editing}
              required
            />
          </label>

          <div className="editor-photo">
            <RecipeThumb recipe={preview} size="sm" />
            <label className="editor-field editor-photo-field">
              <span className="editor-label">Photo link</span>
              <input
                className="field"
                inputMode="url"
                value={form.image_url}
                onChange={(e) => set('image_url', e.target.value)}
                placeholder="https://…"
                aria-invalid={!imageOk}
              />
              <span className="editor-hint">
                {imageOk
                  ? 'Saved into your own storage, so it keeps working if the link dies.'
                  : 'That needs to be a full link starting with http.'}
              </span>
            </label>
          </div>

          <label className="editor-field">
            <span className="editor-label">Description</span>
            <textarea
              className="field"
              rows={2}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="A line about it, if you want one."
            />
          </label>

          <div className="editor-row">
            <label className="editor-field">
              <span className="editor-label">Serves</span>
              <input
                className="field"
                value={form.servings}
                onChange={(e) => set('servings', e.target.value)}
                placeholder="4"
              />
            </label>
            <label className="editor-field">
              <span className="editor-label">Prep (min)</span>
              <input
                className="field"
                inputMode="numeric"
                value={form.prep_min}
                onChange={(e) => set('prep_min', e.target.value)}
              />
            </label>
            <label className="editor-field">
              <span className="editor-label">Cook (min)</span>
              <input
                className="field"
                inputMode="numeric"
                value={form.cook_min}
                onChange={(e) => set('cook_min', e.target.value)}
              />
            </label>
            <label className="editor-field">
              <span className="editor-label">Total (min)</span>
              <input
                className="field"
                inputMode="numeric"
                value={form.total_min}
                onChange={(e) => set('total_min', e.target.value)}
                placeholder="auto"
              />
            </label>
          </div>

          <EditableList
            legend="Ingredients"
            rows={ingredients}
            noun="ingredient"
            placeholder="1 lb shrimp, peeled"
            onChange={(key, text) => updateRow(setIngredients, key, text)}
            onRemove={(key) => removeRow(setIngredients, key)}
            onMove={(key, dir) => moveRow(setIngredients, key, dir)}
            onAdd={() => setIngredients((prev) => [...prev, makeRow('')])}
            hint="Written the way you'd read it out. The shopping list reads these lines."
          />

          <EditableList
            legend="Steps"
            rows={steps}
            noun="step"
            multiline
            placeholder="Melt the butter over medium heat."
            onChange={(key, text) => updateRow(setSteps, key, text)}
            onRemove={(key) => removeRow(setSteps, key)}
            onMove={(key, dir) => moveRow(setSteps, key, dir)}
            onAdd={() => setSteps((prev) => [...prev, makeRow('')])}
          />

          <fieldset className="editor-block">
            <legend className="editor-label">Tags</legend>
            <div className="recipes-tag-edit">
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="recipes-tag recipes-tag-remove"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                >
                  {tag} <span aria-hidden="true">×</span>
                </button>
              ))}
              <span className="recipes-tag-add">
                <input
                  className="field"
                  list="recipes-tag-options"
                  placeholder="Add a tag"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  // Enter inside a form submits it, which would save the recipe
                  // rather than add the tag being typed.
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    e.preventDefault()
                    addTag(tagDraft)
                    setTagDraft('')
                  }}
                  aria-label="Add a tag"
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!normalizeTag(tagDraft)}
                  onClick={() => {
                    addTag(tagDraft)
                    setTagDraft('')
                  }}
                >
                  Add
                </button>
              </span>
            </div>
          </fieldset>

          <label className="editor-field">
            <span className="editor-label">Source link</span>
            <input
              className="field"
              inputMode="url"
              value={form.source_url}
              onChange={(e) => set('source_url', e.target.value)}
              placeholder="https://…"
            />
          </label>

          {error && <p className="rb-error">{error}</p>}
        </form>
      )}
    </Sheet>
  )
}

// Ingredients and steps are the same widget: an ordered list of lines you can
// add to, reorder and remove. Order is the content in both cases, which is why
// the move controls are here rather than left to drag — a drag needs a pointer,
// a library and a keyboard equivalent anyway.
function EditableList({ legend, rows, noun, placeholder, multiline, hint, onChange, onRemove, onMove, onAdd }) {
  return (
    <fieldset className="editor-block">
      <legend className="editor-label">{legend}</legend>
      {hint && <p className="editor-hint">{hint}</p>}
      <ol className="editor-rows">
        {rows.map((row, i) => (
          <li key={row.key} className="editor-row-item">
            <span className="editor-row-num" aria-hidden="true">
              {i + 1}
            </span>
            {multiline ? (
              <textarea
                className="field editor-row-input"
                rows={2}
                value={row.text}
                placeholder={placeholder}
                aria-label={`${legend} ${i + 1}`}
                onChange={(e) => onChange(row.key, e.target.value)}
              />
            ) : (
              <input
                className="field editor-row-input"
                value={row.text}
                placeholder={placeholder}
                aria-label={`${legend} ${i + 1}`}
                onChange={(e) => onChange(row.key, e.target.value)}
              />
            )}
            <span className="editor-row-controls">
              <button
                type="button"
                className="btn btn-icon"
                aria-label={`Move ${noun} ${i + 1} up`}
                disabled={i === 0}
                onClick={() => onMove(row.key, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-icon"
                aria-label={`Move ${noun} ${i + 1} down`}
                disabled={i === rows.length - 1}
                onClick={() => onMove(row.key, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn btn-icon editor-row-remove"
                aria-label={`Remove ${noun} ${i + 1}`}
                onClick={() => onRemove(row.key)}
              >
                ×
              </button>
            </span>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onAdd}>
        Add {noun}
      </button>
    </fieldset>
  )
}
