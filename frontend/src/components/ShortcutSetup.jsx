// Getting the iPhone share sheet to reach Recipe Box.
//
// The background, because it looks like a workaround and is actually the only
// thing that works: iOS has no Web Share Target, so the PWA cannot appear in the
// share sheet at all. It also cannot be launched at a URL — an installed
// home-screen app always opens at `start_url` and the query string is discarded,
// which was tested and proven dead. So Safari is the permanent capture surface,
// a Shortcut is the only thing that can put "Recipe Box" in the share sheet, and
// what it does is open Safari on a URL carrying the shared text. `App.jsx`
// imports it on arrival and confirms with the recipe title, so the Safari tab is
// one press and done.
//
// Two consequences worth stating on the screen rather than leaving to be
// discovered: the capture lands in Safari, which has separate storage from the
// installed app, so Safari has to be signed in or the recipe never syncs; and
// `?text=` is used rather than `?url=` because share sheets routinely send prose
// wrapped around the link and `readShare()` regexes it back out.

import { useState } from 'react'

// The Shortcut as published from the author's own phone. An iCloud link is the
// only distribution iOS treats as trustworthy — a hosted .shortcut file is
// flagged as untrusted and the plist format is undocumented — and it is also the
// one thing here that can rot, since it lives in somebody's iCloud account
// rather than in this repo. Hence the written steps below it, which are not a
// fallback for the impatient: they are what this screen degrades to if the link
// ever stops resolving.
const SHORTCUT_URL = 'https://www.icloud.com/shortcuts/3494aa75bd674fc889a983f38190f6b4'

const BASE_URL = `${window.location.origin}/?text=`

export default function ShortcutSetup({ onBack }) {
  const [copied, setCopied] = useState(false)

  async function copyBase() {
    try {
      await navigator.clipboard.writeText(BASE_URL)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Denied clipboard permission is not worth an error state — the URL is
      // on screen and selectable, which is why it is rendered as text and not
      // hidden behind the button.
    }
  }

  return (
    <div className="shortcut">
      <p className="shortcut-lead">
        iOS won&rsquo;t let an installed app join the share sheet, so a Shortcut does it instead. Add
        it once and &ldquo;Recipe Box&rdquo; appears in Share on any Instagram or TikTok post.
      </p>

      <a className="btn btn-primary btn-block" href={SHORTCUT_URL} target="_blank" rel="noreferrer">
        Get the Shortcut
      </a>

      <ol className="shortcut-steps">
        <li>Open the link above on your iPhone and tap Add Shortcut.</li>
        <li>
          On a recipe post, tap Share, scroll the row of apps and tap Recipe Box. Safari opens and
          the recipe saves itself.
        </li>
        <li>
          Sign in <b>inside Safari</b> as well as in the app. They keep separate storage on iOS, and
          a capture made signed out of Safari never reaches your account.
        </li>
      </ol>

      <details className="shortcut-manual">
        <summary>Build it by hand instead</summary>
        <p>Three actions, in the Shortcuts app:</p>
        <ol>
          <li>
            <b>Receive</b> what&rsquo;s shared from the Share Sheet, with <b>Get Clipboard</b> as the
            no-input fallback.
          </li>
          <li>
            A <b>URL</b> action holding the address below, then the <b>Shortcut Input</b> variable
            straight after it. It has to be the URL action, not Text — a Text action scans its
            contents for links and opens two tabs, one of them the original post.
          </li>
          <li>
            <b>Open URLs</b>, fed from that URL action.
          </li>
        </ol>
        <p className="shortcut-url">{BASE_URL}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={copyBase}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
      </details>

      <div className="shortcut-actions">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  )
}
