import { useState } from 'react'
import { TagGlyph, glyphNameFor, monogramLetter, tileTint } from '../lib/glyphs.jsx'
import { thumbSources } from '../lib/images.js'

// The image box for a recipe card.
//
// Three states, and the second one is why this is a component rather than an
// <img> tag: photo, failed photo, no photo. Since phase 7 most photos are ours,
// fetched at import and stored in our own bucket, so failure is rarer than it
// was — but a recipe saved before the mirror ran, or one whose photo the mirror
// could not fetch, still points at the origin. Those URLs go away: signed CDN
// URLs from Instagram and TikTok expire, origins turn on hotlink protection, and
// a "200 OK" HTML error page fires the same error event as a 404. When that
// happens we render the fallback element instead of an img, which removes the
// broken-image icon entirely rather than swapping one source for another.
//
// `priority` marks the first couple of cards. Those load eagerly at high fetch
// priority; everything below stays lazy. Lazy-loading the largest image in the
// viewport is a measured regression, not a saving.
//
// `size="sm"` is the row-sized variant used by the planner's picker, and
// `size="hero"` is the full-bleed one at the top of the detail sheet. Same three
// states in all of them, since a picker row and a hero have exactly the same
// problem a card does.
//
// `md` stopped being a fixed 128px box in pass 3: it is a grid cell now, one of
// two across the content column, so like the hero it carries a `sizes` string
// rather than a width. The column is `.rb-app` — 640px capped, 16px of padding
// each side — and the grid's gap is 13px, so a cell is (608 − 13) / 2 = 298px at
// full width and (100vw − 45) / 2 below that. `w`/`h` stay to give the <img> its
// intrinsic 4:3 ratio.
const SIZES = {
  md: { w: 320, h: 240, sizes: '(min-width: 640px) 298px, calc(50vw - 22px)' },
  sm: { w: 56, h: 42 },
  hero: { w: 640, h: 360, sizes: 'min(100vw, 640px)' },
}

export default function RecipeThumb({ recipe, priority = false, size = 'md' }) {
  const [failed, setFailed] = useState(false)

  const box = SIZES[size] || SIZES.md
  const photo = thumbSources(recipe, box.sizes || box.w)
  const showPhoto = Boolean(photo) && !failed
  const cls = size === 'md' ? 'recipes-thumb' : `recipes-thumb recipes-thumb-${size}`

  if (showPhoto) {
    return (
      <div
        className={cls}
        // A ~20px JPEG of the photo itself, inlined in the row. The box already
        // held its space; this is so what it holds resembles the picture that is
        // about to arrive rather than a flat grey rectangle. Only mirrored
        // recipes have one, so this is undefined for the rest and the tinted
        // background stays.
        style={recipe.image_blur ? { backgroundImage: `url("${recipe.image_blur}")` } : undefined}
      >
        <img
          src={photo.src}
          srcSet={photo.srcSet}
          sizes={photo.sizes}
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

  // Both fallbacks share one treatment: a tinted tile in a colour derived from
  // the title, with a dark mark on top. Seen side by side in a list, a pale glyph
  // next to a saturated monogram reads as two unrelated systems, and the glyph is
  // meant to be extra information on the same tile rather than a different tile.
  // The tint is a tint of the page ground rather than a saturated block since
  // finding 8 — a photo-less recipe should recede beside the photographed ones,
  // not outshout them.
  const glyph = glyphNameFor(recipe.tags)
  return (
    <div className={cls}>
      <div
        className={
          glyph
            ? 'recipes-thumb-fallback recipes-thumb-glyph'
            : 'recipes-thumb-fallback recipes-thumb-mono'
        }
        style={{ background: tileTint(recipe.title) }}
        aria-hidden="true"
      >
        {glyph ? <TagGlyph name={glyph} /> : monogramLetter(recipe.title)}
      </div>
    </div>
  )
}
