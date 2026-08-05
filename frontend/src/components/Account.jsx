// Account control. Renders nothing when Supabase isn't configured — the app
// then runs local-only.
//
// Same credential flows as mtg-web's AccountDropdown: sign in / create account
// tabs, remember-me that prefills the address, forgot-password, magic link as a
// fallback. Password is the primary path because it is the only one that
// reaches the installed home-screen app — iOS opens links from Mail in Safari,
// and the installed app keeps separate storage, so it never sees those tokens.
//
// Every field is typed for the device: type/inputMode/autoComplete together are
// what make iOS show the @ keyboard and offer a saved password, and the form
// wrapper is what makes Keychain associate the pair on submit.
//
// Autofill rules learned here, all easy to undo by accident:
//   - A field a password manager must see cannot use `hidden`, `display:none`
//     or `visibility:hidden`. Use `.rb-offscreen`, which keeps it rendered.
//   - No autoFocus on the email field. Focusing it as the form mounts pre-empts
//     the AutoFill bar on iOS, and it does not open the keyboard there anyway.
//   - Every input needs an id with a matching label. Safari leans on
//     autocomplete, but 1Password and Bitwarden score id/label heavily.

import { useState } from 'react'
import { supabase, supabaseEnabled } from '../lib/supabase.js'

const REMEMBER_EMAIL_KEY = 'recipebox:rememberedEmail'
const REMEMBER_ME_KEY = 'recipebox:rememberMe'
const MIN_PASSWORD = 8

// Shared across every address field so the keyboard, autofill and casing behave.
const EMAIL_FIELD = {
  type: 'email',
  name: 'email',
  inputMode: 'email',
  autoCapitalize: 'none',
  autoCorrect: 'off',
  spellCheck: false,
  placeholder: 'your@email.com',
}

export default function Account({ session }) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState('signin') // signin | signup | magic | forgot
  const [email, setEmail] = useState(() => localStorage.getItem(REMEMBER_EMAIL_KEY) || '')
  const [password, setPassword] = useState('')
  const [rememberMe, setRememberMe] = useState(
    () => localStorage.getItem(REMEMBER_ME_KEY) !== 'false',
  )
  const [settingPassword, setSettingPassword] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')

  if (!supabaseEnabled) return null

  function saveRememberMe(addr) {
    if (rememberMe) {
      localStorage.setItem(REMEMBER_EMAIL_KEY, addr)
      localStorage.setItem(REMEMBER_ME_KEY, 'true')
    } else {
      localStorage.removeItem(REMEMBER_EMAIL_KEY)
      localStorage.setItem(REMEMBER_ME_KEY, 'false')
    }
  }

  function go(next) {
    setMode(next)
    setPassword('')
    setStatus('')
  }

  function close() {
    setOpen(false)
    setPassword('')
    setStatus('')
    setMode('signin')
  }

  async function handlePasswordAuth(e) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr || !password || busy) return
    setBusy(true)
    setStatus('')
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email: addr,
          password,
          options: { emailRedirectTo: `${window.location.origin}/?auth_callback=1` },
        })
        if (error) throw error
        saveRememberMe(addr)
        setStatus('Check your email to confirm your account.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: addr, password })
        if (error) throw error
        saveRememberMe(addr)
        close()
      }
    } catch (err) {
      setStatus(`${mode === 'signup' ? 'Sign-up' : 'Sign-in'} failed: ${err.message}`)
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
      saveRememberMe(addr)
      setStatus('Check your email. The link opens in Safari, so set a password there to sign in here too.')
    } catch (err) {
      setStatus(`Sign-in failed: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  async function sendPasswordReset(e) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr || busy) return
    setBusy(true)
    setStatus('')
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(addr, {
        redirectTo: window.location.origin,
      })
      if (error) throw error
      setStatus('Password reset link sent — check your email.')
    } catch (err) {
      setStatus(`Reset failed: ${err.message}`)
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
      setSettingPassword(false)
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
          <span className="rb-account-email">{session.user.email}</span>
          <button className="rb-account-btn" onClick={() => setSettingPassword((v) => !v)}>
            {settingPassword ? 'Close' : 'Set password'}
          </button>
          <button className="rb-account-btn" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
        {settingPassword && (
          <form className="rb-auth" onSubmit={savePassword}>
            {/* Keychain files a password against a username. Without this it
                prompts to overwrite some unrelated saved account.

                Positioned off-screen rather than `hidden`: Safari skips hidden
                and display:none inputs when it looks for the username to pair
                with, so the attribute meant to fix the association was the
                thing preventing it. It must stay rendered and focusable. */}
            <input
              {...EMAIL_FIELD}
              id="rb-set-password-username"
              autoComplete="username"
              className="rb-offscreen"
              tabIndex={-1}
              value={session.user.email}
              readOnly
            />
            <label className="rb-auth-label" htmlFor="rb-new-password">
              New password ({MIN_PASSWORD}+ characters)
            </label>
            <input
              id="rb-new-password"
              type="password"
              name="new-password"
              autoComplete="new-password"
              enterKeyHint="done"
              placeholder={`New password (${MIN_PASSWORD}+ characters)`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button type="submit" disabled={busy || password.length < MIN_PASSWORD}>
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </form>
        )}
        {status && <p className="rb-account-status">{status}</p>}
      </div>
    )
  }

  if (!open) {
    return (
      <div className="rb-account">
        <div className="rb-account-row">
          <button className="rb-account-btn" onClick={() => setOpen(true)}>
            Sign in
          </button>
        </div>
      </div>
    )
  }

  const emailOnly = mode === 'magic' || mode === 'forgot'
  const submit = mode === 'magic' ? sendLink : mode === 'forgot' ? sendPasswordReset : handlePasswordAuth

  return (
    <div className="rb-account">
      <form className="rb-auth" onSubmit={submit}>
        {!emailOnly && (
          <div className="rb-auth-tabs">
            <button
              type="button"
              className={mode === 'signin' ? 'rb-auth-tab rb-auth-tab-active' : 'rb-auth-tab'}
              onClick={() => go('signin')}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === 'signup' ? 'rb-auth-tab rb-auth-tab-active' : 'rb-auth-tab'}
              onClick={() => go('signup')}
            >
              Create account
            </button>
          </div>
        )}
        {emailOnly && (
          <p className="rb-auth-title">{mode === 'magic' ? 'Email a sign-in link' : 'Reset password'}</p>
        )}

        <label className="rb-auth-label" htmlFor="rb-email">
          Email
        </label>
        <input
          {...EMAIL_FIELD}
          id="rb-email"
          // "username" is what pairs an address with a password for Keychain;
          // with no password field alongside it, plain "email" is right.
          autoComplete={emailOnly ? 'email' : 'username'}
          enterKeyHint={emailOnly ? 'send' : 'next'}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        {!emailOnly && (
          <>
            <label className="rb-auth-label" htmlFor="rb-password">
              Password
            </label>
            <input
              id="rb-password"
              type="password"
              name="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              enterKeyHint="go"
              placeholder={mode === 'signup' ? `Choose a password (${MIN_PASSWORD}+)` : 'Password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        {mode === 'signin' && (
          <label className="rb-auth-remember">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span>Remember me</span>
          </label>
        )}

        <button type="submit" disabled={busy || !email.trim() || (!emailOnly && !password)}>
          {busy
            ? 'Working…'
            : mode === 'signup'
              ? 'Create account'
              : mode === 'magic'
                ? 'Send link'
                : mode === 'forgot'
                  ? 'Send reset link'
                  : 'Sign in'}
        </button>

        {status && <p className="rb-account-status">{status}</p>}

        <p className="rb-auth-links">
          {mode === 'signin' && (
            <button type="button" className="rb-account-link" onClick={() => go('forgot')}>
              Forgot password?
            </button>
          )}
          {mode === 'signin' && ' · '}
          {emailOnly ? (
            <button type="button" className="rb-account-link" onClick={() => go('signin')}>
              Back to password sign-in
            </button>
          ) : (
            <button type="button" className="rb-account-link" onClick={() => go('magic')}>
              Use a magic link instead
            </button>
          )}
          {' · '}
          <button type="button" className="rb-account-link" onClick={close}>
            Cancel
          </button>
        </p>
      </form>
    </div>
  )
}
