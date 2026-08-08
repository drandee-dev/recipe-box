import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isMirrored, mirrorSource, needsGlyphRepair, needsMirror } from './images.js'

const BUCKET = 'https://ref.supabase.co/storage/v1/object/public/recipe-images'
const OURS = `${BUCKET}/user-1/recipe-1-lg.jpg?v=3`
const OURS_V2 = `${BUCKET}/user-1/recipe-1-lg.jpg?v=2`
const OURS_V1 = `${BUCKET}/user-1/recipe-1-lg.jpg`
const POST = 'https://www.instagram.com/reel/DQjVXGrkx8K/'
const THEIRS = 'https://scontent.cdninstagram.com/v/t51/573621817_115.jpg?stp=cmp1_dst-jpg'

test('a photo in our bucket is ours whatever version made it', () => {
  assert.equal(isMirrored({ image_url: OURS }), true)
  assert.equal(isMirrored({ image_url: OURS_V1 }), true)
  assert.equal(isMirrored({ image_url: THEIRS }), false)
  assert.equal(isMirrored({}), false)
})

test('only a borrowed photo needs a first mirror', () => {
  assert.equal(needsMirror({ image_url: THEIRS }), true)
  assert.equal(needsMirror({ image_url: OURS }), false)
  // No photo at all is not a failure to fix — the tile is the design.
  assert.equal(needsMirror({ image_url: null }), false)
})

test('an Instagram photo mirrored before the play-glyph strip is repaired', () => {
  assert.equal(needsGlyphRepair({ source_type: 'instagram', image_url: OURS_V1 }), true)
})

test('and so is one repaired by the pipeline that did it badly', () => {
  // v2 filled a large blurred circle over the play button. Those bytes are
  // worse than the ones they replaced, and the only way back is the post.
  assert.equal(needsGlyphRepair({ source_type: 'instagram', image_url: OURS_V2 }), true)
})

test('a repair goes back to the post, a first mirror does not', () => {
  // The load-bearing one. Re-mirroring a v2 photo from our own copy would run
  // the new strip over a blurred circle and change nothing, permanently.
  assert.equal(
    mirrorSource({ source_type: 'instagram', image_url: OURS_V2, source_url: POST }),
    POST,
  )
  assert.equal(
    mirrorSource({ source_type: 'instagram', image_url: THEIRS, source_url: POST }),
    THEIRS,
  )
})

test('a repair with no post to go back to falls back to our copy', () => {
  // A written recipe has no source URL, and fetching nothing is worse than
  // re-uploading the same bytes.
  assert.equal(mirrorSource({ source_type: 'instagram', image_url: OURS_V2 }), OURS_V2)
})

test('a repaired photo is not repaired again', () => {
  // What ends the pass. The backend versions the URL whether or not it found a
  // glyph, so a reel cover and an ordinary Instagram photo both come back
  // marked and neither is picked up on the next load.
  assert.equal(needsGlyphRepair({ source_type: 'instagram', image_url: OURS }), false)
})

test('only Instagram is repaired', () => {
  // TikTok's oEmbed thumbnail is a clean cover frame and a recipe site's photo
  // is a photo. Repairing those would be a re-upload that changes nothing.
  assert.equal(needsGlyphRepair({ source_type: 'tiktok', image_url: OURS_V1 }), false)
  assert.equal(needsGlyphRepair({ source_type: 'web', image_url: OURS_V1 }), false)
  assert.equal(needsGlyphRepair({ image_url: OURS_V1 }), false)
})

test('the version here matches MIRROR_VERSION in the backend', () => {
  // The same treatment tags.test.js gives ALLOWED_TAGS, and for the same
  // reason: "keep these two in step" is a comment until something checks it.
  // Drift here is silent in both directions — a frontend behind the backend
  // re-mirrors every Instagram recipe on every load, a frontend ahead of it
  // never repairs one.
  const source = readFileSync(
    fileURLToPath(new URL('../../../backend/app/images.py', import.meta.url)),
    'utf8',
  )
  const backend = source.match(/^MIRROR_VERSION\s*=\s*(\d+)/m)
  assert.ok(backend, 'MIRROR_VERSION not found in backend/app/images.py')

  const here = readFileSync(fileURLToPath(new URL('./images.js', import.meta.url)), 'utf8')
  const front = here.match(/^const MIRROR_VERSION\s*=\s*(\d+)/m)
  assert.ok(front, 'MIRROR_VERSION not found in lib/images.js')
  assert.equal(front[1], backend[1])
})

test('a photo we do not hold yet is a mirror, not a repair', () => {
  // Order matters where both could match: the first mirror already runs the
  // strip, so a repair on top of it would be immediate and pointless.
  const fresh = { source_type: 'instagram', image_url: THEIRS }
  assert.equal(needsMirror(fresh), true)
  assert.equal(needsGlyphRepair(fresh), false)
})
