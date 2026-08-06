import { useState } from 'react'
import { TagGlyph, glyphNameFor, monogramColor, monogramLetter } from '../lib/glyphs.jsx'

// The image box for a recipe card.
//
// Three states, and the second one is why this is a component rather than an
// <img> tag: photo, failed photo, no photo. These URLs point at whatever site the
// recipe was saved from, so failure is normal — signed CDN URLs from Instagram
// and TikTok expire, origins turn on hotlink protection, and a "200 OK" HTML
// error page fires the same error event as a 404. When that happens we render the
// fallback element instead of an img, which removes the broken-image icon
// entirely rather than swapping one source for another.
//
// `priority` marks the first couple of cards. Those load eagerly at high fetch
// priority; everything below stays lazy. Lazy-loading the largest image in the
// viewport is a measured regression, not a saving.
//
// `size="sm"` is the row-sized variant used by the planner's picker. Same three
// states, since a picker row has exactly the same problem a card does.
const SIZES = { md: { w: 128, h: 96 }, sm: { w: 56, h: 42 } }

export default function RecipeThumb({ recipe, priority = false, size = 'md' }) {
  const [failed, setFailed] = useState(false)

  const src = recipe.image_url
  const showPhoto = Boolean(src) && !failed
  const box = SIZES[size] || SIZES.md
  const cls = size === 'md' ? 'recipes-thumb' : `recipes-thumb recipes-thumb-${size}`

  if (showPhoto) {
    return (
      <div className={cls}>
        <img
          src={src}
          alt=""
          width={box.w}
          height={box.h}
          decoding="async"
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          // Not onerror-swaps-the-src: a fallback src that also fails would loop.
          // A state flag renders a different element and can only fire once.
          onError={() => setFailed(true)}
        />
      </div>
    )
  }

  // Both fallbacks share one treatment: a solid tile in a colour derived from the
  // title, with a light mark on top. Seen side by side in a list, a pale glyph
  // next to a saturated monogram reads as two unrelated systems, and the glyph is
  // meant to be extra information on the same tile rather than a different tile.
  const glyph = glyphNameFor(recipe.tags)
  return (
    <div className={cls}>
      <div
        className={
          glyph
            ? 'recipes-thumb-fallback recipes-thumb-glyph'
            : 'recipes-thumb-fallback recipes-thumb-mono'
        }
        style={{ background: monogramColor(recipe.title) }}
        aria-hidden="true"
      >
        {glyph ? <TagGlyph name={glyph} /> : monogramLetter(recipe.title)}
      </div>
    </div>
  )
}
