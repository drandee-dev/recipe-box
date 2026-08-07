// The single entry point for getting a recipe into the box (audit finding 1).
// Used to be four things stacked above the list on every visit to the Recipes
// tab — the import field and three buttons, 194px of chrome for something done
// a few times a week, ahead of a list that's read every time. Collapsed behind
// one "+" trigger, whose sheet is where the three routes finally get the
// explanatory subtitle a stacked button never had room for.

import Sheet from './Sheet.jsx'

const ICONS = {
  link: (
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 12.6 4.9a3.5 3.5 0 0 1 5 5L16 11.5" />
      <path d="M13 17.5 11.4 19.1a3.5 3.5 0 0 1-5-5L8 12.5" />
    </>
  ),
  text: <path d="M5 6.5h14M5 12h14M5 17.5h9" />,
  pencil: (
    <>
      <path d="M4 20h4.2L19.8 8.4a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8z" />
      <path d="M14.5 5.5 18.5 9.5" />
    </>
  ),
}

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
  onWrite,
  onClose,
  error,
  inputRef,
}) {
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
            title="Paste recipe text"
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
