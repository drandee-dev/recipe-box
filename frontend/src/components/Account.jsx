// Account control. Renders nothing when Supabase isn't configured — the app
// then runs local-only.
//
// Password is the primary sign-in because it is the only one that reaches the
// installed home-screen app. iOS opens links from Mail in Safari, so a magic
// link always signs in Safari, and the installed app keeps separate storage and
// never sees those tokens. A 6-digit code would solve it too, but the emailed
// body can't carry one without custom SMTP on the Supabase project.
//
// The link is kept as a way in for an account that has no password set yet.

import { useState } from 'react'
import { supabase, supabaseEnabled } from '../lib/supabase.js'

const MIN_PASSWORD = 8

export default function Account({ session }) {
  const [mode, setMode] = useState('closed') // closed | password | link | setpw
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  if (!supabaseEnabled) return null

  function reset(next = 'closed') {
    setMode(next)
    setPassword('')
    setStatus('')
  }

  async function signIn(e) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr || !password || busy) return
    setBusy(true)
    setStatus('')
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: addr, password })
      if (error) throw error
      reset()
      setEmail('')
    } catch {
      setStatus('That email and password did not match. Use the link below if you have not set a password yet.')
    } finally {
      setBusy(false)
    }
  }

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
      setStatus('Check your email. The link opens in Safari, so set a password there to sign in here too.')
    } catch (err) {
      setStatus(`Could not send the link: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function savePassword(e) {
    e.preventDefault()
    if (password.length < MIN_PASSWORD || busy) return
    setBusy(true)
    setStatus('')
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      setPassword('')
      setMode('closed')
      setStatus('Password saved. Use it to sign in on your other devices.')
    } catch (err) {
      setStatus(`Could not save the password: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  if (session) {
    return (
      <div className="rb-account">
        <div className="rb-account-row">
          {mode === 'setpw' ? (
            <form className="rb-account-form" onSubmit={savePassword}>
              {/* Hidden username so iOS Keychain files the password under the
                  right account instead of prompting to overwrite another one. */}
              <input type="email" autoComplete="username" value={session.user.email} readOnly hidden />
              <input
                type="password"
                autoComplete="new-password"
                placeholder={`New password (${MIN_PASSWORD}+ characters)`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <button type="submit" disabled={busy || password.length < MIN_PASSWORD}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </form>
          ) : (
            <>
              <span className="rb-account-email">{session.user.email}</span>
              <button className="rb-account-btn" onClick={() => reset('setpw')}>
                Set password
              </button>
              <button className="rb-account-btn" onClick={() => supabase.auth.signOut()}>
                Sign out
              </button>
            </>
          )}
        </div>
        {status && <p className="rb-account-status">{status}</p>}
        {mode === 'setpw' && (
          <p className="rb-account-status">
            <button className="rb-account-link" onClick={() => reset()}>
              Cancel
            </button>
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="rb-account">
      <div className="rb-account-row">
        {mode === 'closed' && (
          <button className="rb-account-btn" onClick={() => setMode('password')}>
            Sign in
          </button>
        )}
        {mode === 'password' && (
          <form className="rb-account-form" onSubmit={signIn}>
            <input
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="submit" disabled={busy || !email.trim() || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        {mode === 'link' && (
          <form className="rb-account-form" onSubmit={sendLink}>
            <input
              type="email"
              inputMode="email"
              autoComplete="username"
              placeholder="you@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
          </form>
        )}
      </div>
      {status && <p className="rb-account-status">{status}</p>}
      {mode !== 'closed' && (
        <p className="rb-account-status">
          <button
            className="rb-account-link"
            onClick={() => reset(mode === 'password' ? 'link' : 'password')}
          >
            {mode === 'password' ? 'Email me a sign-in link instead' : 'Use a password instead'}
          </button>
          {' · '}
          <button className="rb-account-link" onClick={() => reset()}>
            Cancel
          </button>
        </p>
      )}
    </div>
  )
}
