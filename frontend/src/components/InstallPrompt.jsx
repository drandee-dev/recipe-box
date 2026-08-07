import { useEffect, useState } from 'react'
import { isIos, isStandalone } from '../lib/platform.js'

// Install prompt, in the two shapes the platforms allow.
//
// Android/Chrome fires `beforeinstallprompt`. Calling preventDefault suppresses
// the browser's own mini-infobar and hands us the event, which can be prompted
// exactly once, and only from inside a user gesture — hence a button rather
// than showing the dialog on arrival.
//
// iOS has no such event and never will. Add to Home Screen only exists in the
// share sheet, so the best available version is telling someone where to look.
// That matters more here than on Android: iOS captures go through Safari, and
// the installed app is a separate surface with its own storage.

const DISMISS_KEY = 'recipebox:installDismissed'

export default function InstallPrompt({ ready }) {
  const [event, setEvent] = useState(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    function onPrompt(e) {
      // Without this the browser shows its own bar as well as ours.
      e.preventDefault()
      setEvent(e)
    }
    // Fires when the install completes, including from the browser's own menu
    // rather than our button.
    function onInstalled() {
      setEvent(null)
      setDismissed(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Then it comes back next visit. Not worth handling further.
    }
  }

  async function install() {
    if (!event) return
    // Resolves once the dialog is answered either way. A dismissal isn't
    // remembered: the event won't fire again this page load, so the bar goes
    // regardless, and a later visit gets another chance.
    await event.prompt()
    setEvent(null)
  }

  // `ready` holds this back until there is something in the box worth coming
  // back to. An install bar over an empty app is asking for a commitment before
  // showing anything for it.
  if (!ready || dismissed || isStandalone()) return null

  const ios = isIos()
  if (!event && !ios) return null

  return (
    <div className="rb-install" role="complementary" aria-label="Install Recipe Box">
      <div className="rb-install-text">
        <strong>{ios ? 'Add Recipe Box to your home screen' : 'Install Recipe Box'}</strong>
        <span>
          {ios
            ? 'Tap the Share button below, then “Add to Home Screen”.'
            : 'Opens full screen, and your recipes are there when you have no signal.'}
        </span>
      </div>
      <div className="rb-install-actions">
        {!ios && (
          <button type="button" className="btn btn-primary btn-sm" onClick={install}>
            Install
          </button>
        )}
        <button type="button" className="btn btn-quiet rb-install-close" onClick={dismiss}>
          {ios ? 'Got it' : 'Not now'}
        </button>
      </div>
    </div>
  )
}
