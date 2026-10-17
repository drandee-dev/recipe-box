// The news banner, the What's new sheet, and the feedback sheet the banner
// points at. One file because they are one feature; the entries themselves are
// in lib/news.js.

import { useState } from 'react'
import Sheet from './Sheet.jsx'
import { APP_VERSION, NEWS } from '../lib/news.js'
import { fromISODate } from '../lib/dates.js'
import { getSupabase } from '../lib/supabase.js'

const FEEDBACK_MAX = 2000

// Kept outside the component so a stray backdrop tap doesn't cost what was
// typed: closing the sheet unmounts it, and the draft is still here when it
// reopens. Cleared only once a report is actually sent.
let draft = ''

function longDate(iso) {
  // fromISODate, not new Date(iso): the latter is a UTC instant and shows the
  // day before west of Greenwich (see dates.js).
  return fromISODate(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
}

// One slim row: the whole text is the button that opens What's new, and the
// close is the other control. It was a heading, a paragraph and two buttons
// (182px at 390, pushing the first photo to y=434); the full text and the
// feedback button live in the What's new sheet, one tap away.
export function NewsBanner({ entry, onWhatsNew, onDismiss }) {
  return (
    <section className="rb-news" aria-label="News">
      <button type="button" className="rb-news-main" onClick={onWhatsNew}>
        <span className="rb-news-title">{entry.title}</span>
        {entry.body && <span className="rb-news-body">{entry.body}</span>}
      </button>
      <button
        type="button"
        className="btn btn-quiet btn-icon rb-news-close"
        aria-label="Close this notice"
        onClick={onDismiss}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </section>
  )
}

export function WhatsNewSheet({ onClose, onFeedback }) {
  return (
    <Sheet title="What's new" closeLabel="Done" onClose={onClose}>
      <ol className="rb-whatsnew">
        {NEWS.map((entry) => (
          <li key={entry.id} className="rb-whatsnew-entry">
            <h3 className="rb-whatsnew-title">{entry.kind === 'upcoming' ? 'Coming soon' : entry.title}</h3>
            <p className="rb-whatsnew-date">{longDate(entry.date)}</p>
            {entry.body && <p className="rb-whatsnew-body">{entry.body}</p>}
            {entry.notes?.length > 0 && (
              <ul className="rb-whatsnew-notes">
                {entry.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-secondary btn-block" onClick={onFeedback}>
        Send feedback
      </button>
      <p className="rb-whatsnew-version">You're on version {APP_VERSION}.</p>
    </Sheet>
  )
}

export function FeedbackSheet({ signedIn, onClose }) {
  const [kind, setKind] = useState('idea')
  const [body, setBody] = useState(draft)
  const [state, setState] = useState('idle') // idle | sending | sent | failed
  const text = body.trim()

  function edit(value) {
    draft = value
    setBody(value)
    if (state === 'failed') setState('idle')
  }

  async function submit(e) {
    e.preventDefault()
    if (!text || state === 'sending') return
    setState('sending')
    try {
      const supabase = await getSupabase()
      // No .select() after the insert: the table has no read policy, so asking
      // for the row back would fail an insert that actually worked.
      const { error } = await supabase.from('feedback').insert({
        kind,
        body: text,
        app_version: APP_VERSION,
        user_agent: navigator.userAgent.slice(0, 400),
      })
      if (error) throw error
      draft = ''
      setBody('')
      setState('sent')
    } catch (err) {
      // The typing stays in the field; the message says it didn't go.
      console.error('feedback insert failed', err)
      setState('failed')
    }
  }

  if (!signedIn) {
    return (
      <Sheet title="Send feedback" closeLabel="Done" onClose={onClose}>
        <p className="account-note">
          Sign in to send feedback. Tap the round account button at the top of the screen.
        </p>
      </Sheet>
    )
  }

  if (state === 'sent') {
    return (
      <Sheet title="Send feedback" closeLabel="Done" onClose={onClose}>
        <p className="rb-feedback-sent" role="status">
          Thanks, got it.
        </p>
        <button type="button" className="btn btn-secondary btn-block" onClick={() => setState('idle')}>
          Send another
        </button>
      </Sheet>
    )
  }

  return (
    <Sheet title="Send feedback" onClose={onClose}>
      <form className="account-form" onSubmit={submit}>
        <div className="account-modes" role="group" aria-label="What kind of feedback">
          <button
            type="button"
            className={kind === 'idea' ? 'account-mode account-mode-on' : 'account-mode'}
            aria-pressed={kind === 'idea'}
            onClick={() => setKind('idea')}
          >
            Suggestion
          </button>
          <button
            type="button"
            className={kind === 'bug' ? 'account-mode account-mode-on' : 'account-mode'}
            aria-pressed={kind === 'bug'}
            onClick={() => setKind('bug')}
          >
            Bug
          </button>
        </div>

        <label className="account-label" htmlFor="rb-feedback-body">
          {kind === 'bug' ? 'What went wrong, and what were you doing?' : 'What would make Recipe Box better?'}
        </label>
        <textarea
          id="rb-feedback-body"
          name="feedback"
          autoComplete="off"
          className="field"
          rows={6}
          maxLength={FEEDBACK_MAX}
          value={body}
          onChange={(e) => edit(e.target.value)}
          aria-describedby="rb-feedback-meta"
        />
        <p id="rb-feedback-meta" className="account-hint rb-feedback-meta">
          <span>Your app version and device type are sent with it.</span>
          <span>
            {body.length}/{FEEDBACK_MAX}
          </span>
        </p>

        {state === 'failed' && (
          <p className="rb-error" role="alert">
            It didn't send. Your text is still here; check your connection and try again.
          </p>
        )}

        <button type="submit" className="btn btn-primary btn-block" disabled={!text || state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </form>
    </Sheet>
  )
}
