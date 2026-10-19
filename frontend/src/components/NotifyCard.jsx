import { useEffect, useState } from 'react'
import { notifyCardOffer, currentPushState, readAnnounce, setAnnounce } from '../lib/push.js'
import { isStandalone } from '../lib/platform.js'
import { useTimers } from '../lib/useTimers.jsx'

// A one-time offer of the notifications a person can turn on, so they hear about
// them without having to open the account sheet. Reuses the news banner's card.
//
// Shown at most once: either button closes it for good, and the same switches
// stay in the account sheet. Only in the installed app, signed in, and only for
// what is still off (lib/push.js notifyCardOffer). A "no" from the phone's own
// permission prompt is the phone's to undo, so the card does not come back.
const DISMISS_KEY = 'recipebox:notifyCardDismissed'

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export default function NotifyCard({ signedIn, ready }) {
  const { turnOnAlerts } = useTimers()
  const [dismissed, setDismissed] = useState(readDismissed)
  const [announce, setAnnounceState] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const state = currentPushState(signedIn)

  // Read once, and only when the card could be shown, so the card is never up for
  // someone who already turned it on.
  useEffect(() => {
    let live = true
    if (signedIn && !dismissed && state === 'on') {
      readAnnounce().then((value) => live && setAnnounceState(value === true))
    } else if (state !== 'on') {
      setAnnounceState(false)
    }
    return () => {
      live = false
    }
  }, [signedIn, dismissed, state])

  const offer = notifyCardOffer({
    state,
    announce,
    dismissed,
    standalone: isStandalone(),
    signedIn,
    ready,
  })
  if (!offer) return null

  function close() {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* it may come back next launch, which is acceptable */
    }
    setDismissed(true)
  }

  // From the tap: the permission prompt is the first thing asked, with nothing
  // awaited before it (turnOnAlerts calls it synchronously). The second step then
  // finds permission already settled and only saves the switch.
  async function turnOn() {
    if (busy) return
    setBusy(true)
    if (offer.timers) await turnOnAlerts()
    await setAnnounce(true, true, false)
    setBusy(false)
    close()
  }

  const heading = offer.timers ? 'Get notified' : 'Hear about new versions'
  const text = offer.timers
    ? 'Timers that ring on a locked phone, and one heads-up when a new version of Recipe Box is ready. You can change this any time in the account menu.'
    : 'One notification when a new version of Recipe Box is ready. You can change this any time in the account menu.'

  return (
    <section className="rb-news rb-news-update" aria-labelledby="rb-notify-title">
      <h2 id="rb-notify-title" className="rb-news-update-title">
        {heading}
      </h2>
      <p className="rb-news-update-text">{text}</p>
      <div className="rb-news-update-actions">
        <button type="button" className="btn btn-primary btn-lg" onClick={turnOn} disabled={busy}>
          Turn on
        </button>
        <button type="button" className="btn btn-quiet" onClick={close}>
          Not now
        </button>
      </div>
    </section>
  )
}
