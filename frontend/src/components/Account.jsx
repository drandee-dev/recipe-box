// Magic-link account control (mtg-web pattern). Renders nothing when Supabase
// isn't configured — the app then runs local-only.

import { useState } from 'react'
import { supabase, supabaseEnabled } from '../lib/supabase.js'

export default function Account({ session }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  if (!supabaseEnabled) return null

  async function sendLink(e) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr || busy) return
    setBusy(true)
    setStatus('')
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: addr,
        options: { emailRedirectTo: `${window.location.origin}/?auth_callback=1` },
      })
      if (error) throw error
      setStatus('Check your email for the sign-in link.')
      setEmail('')
      setOpen(false)
    } catch (err) {
      setStatus(`Sign-in failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (session) {
    return (
      <div className="rb-account">
        <div className="rb-account-row">
          <span className="rb-account-email">{session.user.email}</span>
          <button className="rb-account-btn" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rb-account">
      <div className="rb-account-row">
        {open ? (
          <form className="rb-account-form" onSubmit={sendLink}>
            <input
              type="email"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </form>
        ) : (
          <button className="rb-account-btn" onClick={() => setOpen(true)}>
            Sign in
          </button>
        )}
      </div>
      {status && <p className="rb-account-status">{status}</p>}
    </div>
  )
}
