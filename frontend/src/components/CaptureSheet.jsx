// The single entry point for getting a recipe into the box (audit finding 1).
// Used to be four things stacked above the list on every visit to the Recipes
// tab — the import field and three buttons, 194px of chrome for something done
// a few times a week, ahead of a list that's read every time. Collapsed behind
// one "+" trigger, whose sheet is where the three routes finally get the
// explanatory subtitle a stacked button never had room for.

import { useRef, useState } from 'react'
import Sheet from './Sheet.jsx'
import ShortcutSetup from './ShortcutSetup.jsx'
import { isIos } from '../lib/platform.js'

const ICONS = {
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 12.6 4.9a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5 11.4 19.1a3.5 3.5 0 0 1-5-5L8 12.5" />
    </>
  ),
  text: <path d="M5 6.5h14M5 12h14M5 17.5h9" />,
  camera: (
    <>
      <path d="M3.5 8.5h3.2l1.4-2h7.8l1.4 2h3.2v11h-17z" />
      <circle cx="12" cy="13.5" r="3.4" />
    </>
  ),
  library: (
    <>
      <path d="M3.5 5.5h17v13h-17z" />
      <path d="m3.5 15 4.5-4.2 4.2 3.9 3.1-2.8 5.2 4.6" />
      <circle cx="8.6" cy="9.2" r="1.2" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4.2L19.8 8.4a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8z" />
      <path d="M14.5 5.5 18.5 9.5" />
    </>
  ),
  // The share glyph, because that is the thing this route is about joining.
  share: (
    <>
      <path d="M12 3.5v11" />
      <path d="M8.5 7 12 3.5 15.5 7" />
      <path d="M6.5 11.5H5.5v9h13v-9h-1" />
    </>
  ),
}

// Sniffed once per mount rather than per render: a user agent does not change
// while a sheet is open, and this decides whether a whole route exists.
const IOS = isIos()

// Same 24-viewBox / stroke-only convention as TabBar's icons, so a route glyph
// and a tab glyph read as the same family of mark.
function RouteIcon({ name }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  )
}

function Route({ icon, title, subtitle, onClick }) {
  return (
    <button type="button" className="capture-route" onClick={onClick}>
      <span className="capture-route-icon">
        <RouteIcon name={icon} />
      </span>
      <span className="capture-route-text">
        <span className="capture-route-title">{title}</span>
        <span className="capture-route-subtitle">{subtitle}</span>
      </span>
    </button>
  )
}

export default function CaptureSheet({
  importUrl,
  onImportUrlChange,
  onImportPaste,
  onImportSubmit,
  importing,
  canPaste,
  onPasteLink,
  pasteOpen,
  onOpenPasteText,
  onClosePasteText,
  pasteText,
  onPasteTextChange,
  onPasteTextSubmit,
  photo,
  onPickPhoto,
  onClearPhoto,
  onWrite,
  onClose,
  error,
  inputRef,
}) {
  const [shortcutOpen, setShortcutOpen] = useState(false)
  // Two inputs rather than one, because the difference between them is a single
  // attribute the user cannot change afterwards. `capture` opens the camera
  // directly; without it iOS offers its own Take Photo / Photo Library sheet,
  // which is one tap further from the camera and the reason both exist.
  const cameraRef = useRef(null)
  const libraryRef = useRef(null)

  // The reset is not tidying. A file input holds its selection, so choosing the
  // same photo again after backing out fires no change event at all and the
  // button reads as broken — which is exactly what "Use different photo" then
  // "the same one after all" does.
  function handlePicked(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPickPhoto(file)
  }

  // A view swap inside the sheet, the same shape the paste-text form uses,
  // rather than a second sheet on top. Setup is a detour off the capture
  // question, not a new question, and the app stays at one modal.
  //
  // `closeLabel` is Close rather than the default Cancel: nothing here is in
  // progress to abandon, and it has to read differently from the Back at the
  // foot, which returns to the routes rather than leaving the sheet.
  if (shortcutOpen) {
    return (
      <Sheet title="iPhone sharing" closeLabel="Close" onClose={onClose}>
        <ShortcutSetup onBack={() => setShortcutOpen(false)} />
      </Sheet>
    )
  }

  // A photo takes the whole sheet, the same way setup does, and this is not a
  // style choice — it was built inside the paste view first and the screenshot
  // is what caught it. A portrait photo is taller than the routes it appears
  // under, so the import field and three capture routes stayed on screen while
  // both the picture and the button that reads it sat below the fold. There is
  // one question left at this point and it is not "how would you like to add a
  // recipe".
  //
  // Dismissing the sheet from here keeps the photo, deliberately, for the same
  // reason it keeps a half-pasted draft: a stray tap on the backdrop should not
  // cost a picture that may have been taken at somebody else's kitchen table.
  if (photo) {
    return (
      <Sheet title="Read this photo" onClose={onClose}>
        {error && (
          <p className="rb-error" role="alert">
            {error}
          </p>
        )}
        <form className="rb-photo" onSubmit={onPasteTextSubmit}>
          <img className="rb-photo-shot" src={photo.preview} alt="The photo you picked" />
          <div className="rb-paste-text-actions">
            <button type="button" className="btn btn-quiet" onClick={onClearPhoto}>
              Use another
            </button>
            <button type="submit" className="btn btn-primary" disabled={importing}>
              {importing ? 'Reading…' : 'Read this photo'}
            </button>
          </div>
        </form>
      </Sheet>
    )
  }

  return (
    <Sheet title="Add a recipe" onClose={onClose}>
      {error && (
        <p className="rb-error" role="alert">
          {error}
        </p>
      )}

      <form className="rb-import" onSubmit={onImportSubmit}>
        <input
          ref={inputRef}
          className="field"
          type="url"
          placeholder="Paste a recipe link"
          value={importUrl}
          onChange={(e) => onImportUrlChange(e.target.value)}
          onPaste={onImportPaste}
          autoFocus
        />
        <button type="submit" className="btn btn-primary btn-lg" disabled={importing}>
          {importing ? 'Importing…' : 'Import'}
        </button>
      </form>

      <div className="capture-routes">
        {canPaste && (
          <Route
            icon="link"
            title="Paste copied link"
            subtitle="From the Instagram or TikTok share sheet"
            onClick={onPasteLink}
          />
        )}
        {!pasteOpen && (
          <Route
            icon="text"
            title="Paste text or a photo"
            subtitle="A caption, an email, a photo of a page"
            onClick={onOpenPasteText}
          />
        )}
        <Route
          icon="pencil"
          title="Write a recipe"
          subtitle="For the ones that only exist in a notebook"
          onClick={onWrite}
        />
        {/* iOS only, because there is nothing here for anyone else to do: every
            other platform either has a real share target or has no share sheet
            to join. It sits last as the only route that is setup rather than
            capture — done once, then never again. */}
        {IOS && (
          <Route
            icon="share"
            title="Add to iPhone share sheet"
            subtitle="One-time setup, then share straight from Instagram"
            onClick={() => setShortcutOpen(true)}
          />
        )}
      </div>

      {pasteOpen && (
        <form className="rb-paste-text" onSubmit={onPasteTextSubmit}>
          <textarea
            className="field"
            rows={6}
            placeholder="Paste a recipe here — ingredients, steps, a caption, anything."
            value={pasteText}
            onChange={(e) => onPasteTextChange(e.target.value)}
            autoFocus
          />
          <div className="rb-photo-pick">
            {/* Hidden but real, and clicked through a button rather than
                wrapped in a label: a label is not focusable, and an input
                hidden well enough not to show is hidden well enough not to
                be tabbed to either. */}
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={handlePicked}
            />
            <input ref={libraryRef} type="file" accept="image/*" hidden onChange={handlePicked} />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => cameraRef.current?.click()}
            >
              <RouteIcon name="camera" />
              Take a photo
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => libraryRef.current?.click()}
            >
              <RouteIcon name="library" />
              Choose a photo
            </button>
          </div>
          <div className="rb-paste-text-actions">
            <button type="button" className="btn btn-quiet" onClick={onClosePasteText}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={importing || pasteText.trim().length < 20}
            >
              {importing ? 'Reading…' : 'Save recipe'}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  )
}
