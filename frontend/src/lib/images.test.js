import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fullPhotoLink, isMirrored, mirrorSource, needsMirror, needsRepair, pickFrom } from './images.js'

const BUCKET = 'https://ref.supabase.co/storage/v1/object/public/recipe-images'
const OURS = `${BUCKET}/user-1/recipe-1-lg.jpg?v=5`
const OURS_V4 = `${BUCKET}/user-1/recipe-1-lg.jpg?v=4`
const OURS_V3 = `${BUCKET}/user-1/recipe-1-lg.jpg?v=3`
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

const IG = (image_url) => ({ source_type: 'instagram', image_url, source_url: POST })
const TT = (image_url) => ({ source_type: 'tiktok', image_url, source_url: 'https://www.tiktok.com/@a/video/1' })

test('every older Instagram photo is repaired, from the first pipeline to v4', () => {
  // v2 filled a large blurred circle over the play button and v3's disc came out
  // pale; the only way back is the post. v4 had no food pick (the retro pass).
  for (const url of [OURS_V1, OURS_V2, OURS_V3, OURS_V4]) assert.equal(needsRepair(IG(url)), true, url)
})

test('the retro pass reaches TikTok photos too', () => {
  for (const url of [OURS_V1, OURS_V3, OURS_V4]) assert.equal(needsRepair(TT(url)), true, url)
})

test('a repair needs the post to pick from', () => {
  assert.equal(needsRepair({ source_type: 'tiktok', image_url: OURS_V3 }), false)
  assert.equal(needsRepair({ source_type: 'instagram', image_url: OURS_V3 }), false)
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
  assert.equal(needsRepair(IG(OURS)), false)
  assert.equal(needsRepair(TT(OURS)), false)
})

test('a photo from a newer build is not redone back to this one', () => {
  // Staging and production share the database; `?v=50` must not read as v5 either.
  for (const v of [6, 50]) assert.equal(needsRepair(TT(`${BUCKET}/user-1/recipe-1-lg.jpg?v=${v}`)), false, v)
})

test('a photo the person uploaded is never repaired from the post, whatever its version', () => {
  const uploaded = `${BUCKET}/user-1/recipe-1-lg.jpg?v=2&u=1760000000`
  assert.equal(needsRepair(IG(uploaded)), false)
  assert.equal(needsRepair(TT(uploaded)), false)
})

test('a recipe site photo is never repaired', () => {
  // A photo is a photo; redoing it would be a re-upload that changes nothing.
  assert.equal(needsRepair({ source_type: 'web', image_url: OURS_V1, source_url: POST }), false)
  assert.equal(needsRepair({ image_url: OURS_V1, source_url: POST }), false)
})

test('no photo is not repaired: the tile is the design', () => {
  assert.equal(needsRepair(TT(null)), false)
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

test('a social first mirror and a repair pick the food from the post', () => {
  assert.equal(pickFrom({ source_type: 'instagram', image_url: THEIRS, source_url: POST }), POST)
  assert.equal(pickFrom({ source_type: 'tiktok', image_url: THEIRS, source_url: POST }), POST)
  assert.equal(pickFrom(IG(OURS_V2)), POST)
  // A current photo is done, and a site photo is never picked.
  assert.equal(pickFrom(IG(OURS)), undefined)
  assert.equal(pickFrom({ source_type: 'web', image_url: THEIRS, source_url: POST }), undefined)
  assert.equal(pickFrom({ source_type: 'tiktok', image_url: THEIRS }), undefined)
  assert.equal(pickFrom({ source_type: 'tiktok', source_url: POST }), undefined)
})

test('a photo we do not hold yet is a mirror, not a repair', () => {
  // Order matters where both could match: the first mirror already runs the
  // strip, so a repair on top of it would be immediate and pointless.
  const fresh = { source_type: 'instagram', image_url: THEIRS }
  assert.equal(needsMirror(fresh), true)
  assert.equal(needsRepair({ ...fresh, source_url: POST }), false)
})

// A photo link saved as a bare path (an old import from a site that writes og:image
// without the domain) is opened in the editor as the link it meant.
test('a bare path is resolved against the recipe\'s own source page', () => {
  const source = 'https://www.oliveandmango.com/apple-crumble-cheesecake-bars/'
  assert.equal(
    fullPhotoLink('/images/uploads/bars_1.jpg', source),
    'https://www.oliveandmango.com/images/uploads/bars_1.jpg',
  )
  assert.equal(fullPhotoLink('//cdn.example.com/a.jpg', source), 'https://cdn.example.com/a.jpg')
  assert.equal(fullPhotoLink('bars.jpg', source), 'https://www.oliveandmango.com/apple-crumble-cheesecake-bars/bars.jpg')
})

test('a full link, an empty one, and one that cannot be resolved come back as they were', () => {
  const source = 'https://example.com/r/'
  assert.equal(fullPhotoLink('https://img.example.com/a.jpg', source), 'https://img.example.com/a.jpg')
  assert.equal(fullPhotoLink('', source), '')
  assert.equal(fullPhotoLink(null, source), '')
  assert.equal(fullPhotoLink('/a.jpg', undefined), '/a.jpg')
  assert.equal(fullPhotoLink('/a.jpg', 'not a url'), '/a.jpg')
  assert.equal(fullPhotoLink('data:image/png;base64,AAAA', source), 'data:image/png;base64,AAAA')
  assert.equal(fullPhotoLink('javascript:alert(1)', source), 'javascript:alert(1)')
})
