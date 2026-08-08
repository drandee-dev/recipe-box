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

// Which version of the backend's image pipeline made the bytes at a mirrored
// URL. It is the `?v=N` the upload appends — `MIRROR_VERSION` in images.py, and
// the two have to move together. Same principle as isMirrored below: the URL
// says what it is, so there is no column that can disagree with it.
const MIRROR_VERSION = 2

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

// Ours already, but made by a pipeline older than the play-glyph strip.
//
// A reel's cover is served with a white play triangle composited into it, so
// every Instagram recipe saved before that fix has a play button sitting in the
// middle of its photo — including in our own bucket, since we faithfully
// mirrored what Instagram sent. Re-mirroring from the copy we hold is enough to
// repair it; the origin URL is long expired and isn't needed.
//
// Only Instagram, because it is the only source that does this: TikTok's oEmbed
// thumbnail is a clean cover frame, and a recipe site's photo is a photo. Every
// other source would be a re-upload that changes nothing.
//
// Recipes with no glyph still come back marked, which is what ends the loop:
// the backend versions the URL whether or not it found anything to strip, so
// this is one pass over the Instagram recipes in the box and then never again.
export function needsGlyphRepair(recipe) {
  if (recipe?.source_type !== 'instagram' || !isMirrored(recipe)) return false
  return !recipe.image_url.includes(`?v=${MIRROR_VERSION}`)
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
