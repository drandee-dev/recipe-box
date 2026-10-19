import { applyPendingUpdate, dismissUpdate, useUpdateReady } from '../lib/pwa.js'

// "A new version is ready", shown by the version that is RUNNING when a newer
// service worker is waiting. In flow under the header, not fixed: the bottom
// already holds the tab bar, toast, install card and add button, and a fixed top
// bar covers the header's Timers and Sign in.
//
// Under the message, up to three short lines on what changed, read from the new
// build's version.json (lib/pwa.js). Nothing more: it is a glance, and the full
// list is in What's new once the update is in.
//
// Reload is held while a capture is in progress (`busy`): a reload would throw
// away a half-pasted recipe, so the text says to finish first.
export default function UpdateBar() {
  const { show, busy, highlights } = useUpdateReady()
  if (!show) return null

  return (
    <div className="rb-update" role="status">
      <span className="rb-update-text">
        {busy ? 'A new version is ready. Finish what you are saving first.' : 'A new version is ready.'}
      </span>
      <button type="button" className="rb-update-reload" disabled={busy} onClick={applyPendingUpdate}>
        Reload
      </button>
      <button type="button" className="rb-update-later" onClick={dismissUpdate}>
        Later
      </button>
      {highlights.length > 0 && (
        <ul className="rb-update-list" aria-label="What is new">
          {highlights.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
