// Which photos we own, and how to render one.
//
// A recipe's image_url is one of two things: a URL at whatever origin served the
// recipe, which will stop working eventually, or a URL in our own storage bucket,
// which won't. Everything in phase 7 turns the first into the second.
//
// Ownership is read off the URL rather than stored in a flag. A flag can disagree
// with the column beside it — a mirror that half-succeeded, a row restored from
// an old backup — and then the backfill either skips a recipe that still needs
// doing or redoes one that doesn't. The URL cannot be wrong about where it points.

const BUCKET_PATH = '/storage/v1/object/public/recipe-images/'

// Concurrency for the backfill. Each item is a full download, resize and upload
// on the backend, so this is about not queueing thirty serverless invocations at
// once, not about the browser's connection limit.
export const MIRROR_CONCURRENCY = 2

export function isMirrored(recipe) {
  return typeof recipe?.image_url === 'string' && recipe.image_url.includes(BUCKET_PATH)
}

// Worth a mirror attempt: there's a photo, and it isn't ours yet. A recipe with
// no photo at all is not a failure to fix — RecipeThumb's tile is the design.
export function needsMirror(recipe) {
  return Boolean(recipe?.image_url) && !isMirrored(recipe)
}

// srcset only exists for mirrored recipes, since a borrowed URL comes in exactly
// one size. `sizes` is the rendered box width: the browser multiplies it by the
// device pixel ratio and picks, so a 128px box on a 2x phone takes the 320w file
// and stops pulling a 960px hero down a mobile connection for a thumbnail.
//
// `box` is a number of CSS pixels for the fixed boxes (card thumb, picker row),
// or a ready-made `sizes` string for one that isn't fixed — the detail sheet's
// hero is as wide as the sheet, which is the viewport up to 640px, and there is
// no single number that describes it.
export function thumbSources(recipe, box) {
  const full = recipe?.image_url
  const small = recipe?.image_thumb_url
  if (!full) return null
  if (!small) return { src: full, srcSet: undefined, sizes: undefined }
  return {
    src: small,
    srcSet: `${small} 320w, ${full} 960w`,
    sizes: typeof box === 'number' ? `${box}px` : box,
  }
}
