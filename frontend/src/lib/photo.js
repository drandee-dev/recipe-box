// Turning a picked or captured photo into something worth sending.
//
// A phone camera hands over 3–5 MB at 4000px on the long edge, and none of that
// survives the trip: the model downscales anything past 1568px itself, and
// Vercel refuses a request body over 4.5 MB before the function even runs. So
// the shrink happens here, on the device, where it costs one canvas draw instead
// of a slow upload over whatever signal a kitchen has.
//
// The long edge is capped rather than the width, the same rule image_for_vision
// follows on the backend, and for the same reason: a recipe written down the
// side of a portrait photo is the case this exists for.

const PHOTO_MAX_EDGE = 1600
const PHOTO_QUALITY = 0.82
// Well under the endpoint's own 4 MB ceiling on the base64, which is itself
// under Vercel's body limit. Something this size after the shrink above is a
// panorama or a scan, not a page.
const PHOTO_MAX_BYTES = 2_500_000

export class PhotoError extends Error {}

// Decoded through an <img> rather than createImageBitmap, which is not a style
// preference. Browsers have applied EXIF orientation to <img> rendering by
// default for years (`image-orientation: from-image`), so drawing one to a
// canvas gives correctly rotated pixels and `naturalWidth`/`naturalHeight` are
// already the oriented dimensions. createImageBitmap only rotates when passed
// `imageOrientation: 'from-image'`, whose Safari support is newer than the rest
// of this app assumes — and getting it wrong means a sideways photo of a page,
// silently, on the one platform the user is actually holding.
function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({ img, url })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      // HEIC lands here on anything that isn't Safari. iOS converts to JPEG
      // when it hands a file to an `accept="image/*"` input, so this is mostly
      // a desktop path, but it must say something rather than hang.
      reject(new PhotoError("That file isn't an image this browser can read."))
    }
    img.src = url
  })
}

/**
 * Read a File into what the structure-image endpoint wants.
 *
 * Returns `{ base64, preview, width, height }`. `preview` is an object URL for
 * the shrunk copy — the caller owns it and must revoke it, which is why the
 * original's URL is released here and this one isn't.
 */
export async function readPhoto(file) {
  if (!file || !file.type.startsWith('image/')) {
    throw new PhotoError('Pick a photo to read.')
  }

  const { img, url } = await decode(file)
  try {
    const { naturalWidth: w, naturalHeight: h } = img
    if (!w || !h) throw new PhotoError('That photo could not be read.')

    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', PHOTO_QUALITY),
    )
    if (!blob) throw new PhotoError('That photo could not be read.')
    if (blob.size > PHOTO_MAX_BYTES) {
      throw new PhotoError('That photo is too big. Try a closer shot of the recipe.')
    }

    return {
      base64: await toBase64(blob),
      preview: URL.createObjectURL(blob),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

// FileReader rather than a loop over the bytes: a 400 KB JPEG is 400,000 calls
// to String.fromCharCode, which is long enough to drop frames on a phone.
function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      // Strip the `data:image/jpeg;base64,` prefix. The endpoint takes bare
      // base64, so that it can decode with `validate=True` and reject anything
      // that isn't what it says it is.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new PhotoError('That photo could not be read.'))
    reader.readAsDataURL(blob)
  })
}
