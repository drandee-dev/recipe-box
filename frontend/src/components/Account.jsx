// Account control. Renders nothing when Supabase isn't configured — the app
// then runs local-only.
//
// Sign-in offers a 6-digit code alongside the magic link. The link alone can't
// sign you into the installed home-screen app: iOS opens links from Mail in
// Safari, so the tokens land in Safari's storage and the app never sees them.
// A code is typed into whichever surface you're already standing in, which is
// the only way to hold a session in both.

import { useState } from 'react'
import { supabase, supabaseEnabled } from '../lib/supabase.js'

export default function Account({ session }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  if (!supabaseEnabled) return null

  function reset() {
    setOpen(false)
    setSent(false)
    setEmail('')
    setCode('')
    setStatus('')
  }

  async function sendCode(e) {
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
      // The address is kept, not cleared — verifyOtp needs it to match the code.
      setSent(true)
      setStatus('Check your email. Enter the 6-digit code, or tap the link if you are in Safari.')
    } catch (err) {
      setStatus(`Sign-in failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(e) {
    e.preventDefault()
    const token = code.replace(/\D/g, '')
    if (token.length !== 6 || busy) return
    setBusy(true)
    setStatus('')
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token,
        type: 'email',
      })
      if (error) throw error
      reset()
    } catch {
      setStatus('That code did not work. Check it, or send a new one.')
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
        {!open && (
          <button className="rb-account-btn" onClick={() => setOpen(true)}>
            Sign in
          </button>
        )}
        {open && !sent && (
          <form className="rb-account-form" onSubmit={sendCode}>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send code'}
            </button>
          </form>
        )}
        {open && sent && (
          <form className="rb-account-form" onSubmit={verifyCode}>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={busy || code.replace(/\D/g, '').length !== 6}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
          </form>
        )}
      </div>
      {status && <p className="rb-account-status">{status}</p>}
      {open && (
        <p className="rb-account-status">
          <button className="rb-account-link" onClick={reset}>
            {sent ? 'Use a different email' : 'Cancel'}
          </button>
        </p>
      )}
    </div>
  )
}
