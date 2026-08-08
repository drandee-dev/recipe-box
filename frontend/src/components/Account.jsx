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
import Sheet from './Sheet.jsx'
import { getSupabase, supabaseEnabled } from '../lib/supabase.js'

const REMEMBER_EMAIL_KEY = 'recipebox:rememberedEmail'
const REMEMBER_ME_KEY = 'recipebox:rememberMe'
const MIN_PASSWORD = 8

// Supabase's built-in sender allows only a couple of messages an hour and
// counts every kind against the same allowance, so a few sign-in links can
// lock out a password reset. Raw, that surfaces as "email rate limit
// exceeded", which reads like a broken account and hides the one move that
// still works: updateUser from a session that is already signed in sends no
// email, so another signed-in device can change the password immediately.
const RATE_LIMIT_HELP =
  'Too many emails have gone out from this project in the last hour, and every ' +
  'kind of message shares the same small allowance. There is nothing wrong with ' +
  'your account. If you are still signed in on another device, use Set password ' +
  'there and it changes without sending anything. Otherwise the limit clears on ' +
  'its own within the hour.'

// 429 is what the older client surfaces; newer ones carry the code. The
// message test catches both when a version reports neither.
function isEmailRateLimit(err) {
  return (
    err?.status === 429 ||
    err?.code === 'over_email_send_rate_limit' ||
    /rate limit/i.test(err?.message || '')
  )
}

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
    setSettingPassword(false)
  }

  async function signOut() {
    const supabase = await getSupabase()
    await supabase.auth.signOut()
    close()
  }

  async function handlePasswordAuth(e) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr || !password || busy) return
    // The placeholder has always said 8, and Set password enforces 8, but
    // sign-up used to send whatever was typed and let Supabase's own weaker
    // default decide. Sign-in is deliberately not checked: an existing password
    // shorter than this is still that account's password.
    if (mode === 'signup' && password.length < MIN_PASSWORD) {
      setStatus(`Choose a password of at least ${MIN_PASSWORD} characters.`)
      return
    }
    setBusy(true)
    setStatus('')
    try {
      const supabase = await getSupabase()
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
      // Only sign-up sends mail here. A 429 on signInWithPassword means too
      // many attempts, which is a different problem with different advice.
      if (mode === 'signup' && isEmailRateLimit(err)) setStatus(RATE_LIMIT_HELP)
      else setStatus(`${mode === 'signup' ? 'Sign-up' : 'Sign-in'} failed: ${err.message}`)
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
      const supabase = await getSupabase()
      const { error } = await supabase.auth.signInWithOtp({
        email: addr,
        options: { emailRedirectTo: `${window.location.origin}/?auth_callback=1` },
      })
      if (error) throw error
      saveRememberMe(addr)
      setStatus('Check your email. The link opens in Safari, so set a password there to sign in here too.')
    } catch (err) {
      setStatus(isEmailRateLimit(err) ? RATE_LIMIT_HELP : `Sign-in failed: ${err.message}`)
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
      const supabase = await getSupabase()
      const { error } = await supabase.auth.resetPasswordForEmail(addr, {
        redirectTo: window.location.origin,
      })
      if (error) throw error
      setStatus('Password reset link sent — check your email.')
    } catch (err) {
      setStatus(isEmailRateLimit(err) ? RATE_LIMIT_HELP : `Reset failed: ${err.message}`)
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
      const supabase = await getSupabase()
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

  const address = session?.user?.email || ''
  const statusClass =
    status === RATE_LIMIT_HELP ? 'account-status account-status-help' : 'account-status'

  // The header gets one control, and it is the size of a control rather than a
  // row of them. Everything the account can do lives in the sheet behind it:
  // a title bar is not a settings screen, and the old version proved it by
  // truncating the address to 40vw to make room for two buttons.
  const trigger = (
    <button
      type="button"
      className={session ? 'rb-avatar rb-avatar-in' : 'rb-avatar'}
      onClick={() => setOpen(true)}
      aria-haspopup="dialog"
      aria-label={session ? `Account — signed in as ${address}` : 'Sign in'}
    >
      {session ? (
        <span aria-hidden="true">{address.trim().charAt(0).toUpperCase() || '?'}</span>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="8" r="3.5" />
          <path d="M4.5 20a7.5 7.5 0 0 1 15 0" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )

  if (session) {
    return (
      <>
        {trigger}
        {open && (
          <Sheet title="Account" closeLabel="Done" onClose={close}>
            <p className="account-identity">
              <span className="account-identity-label">Signed in as</span>
              <span className="account-identity-email">{address}</span>
            </p>
            <p className="account-note">
              Recipes, plans and lists sync to this account on every device you sign in
              on.
            </p>

            {settingPassword ? (
              <form className="account-form" onSubmit={savePassword}>
                {/* Keychain files a password against a username. Without this it
                    prompts to overwrite some unrelated saved account.

                    Positioned off-screen rather than `hidden`: Safari skips
                    hidden and display:none inputs when it looks for the username
                    to pair with, so the attribute meant to fix the association
                    was the thing preventing it. It must stay rendered and
                    focusable. */}
                <input
                  {...EMAIL_FIELD}
                  id="rb-set-password-username"
                  autoComplete="username"
                  className="rb-offscreen"
                  tabIndex={-1}
                  value={address}
                  readOnly
                />
                <label className="account-label" htmlFor="rb-new-password">
                  New password ({MIN_PASSWORD}+ characters)
                </label>
                <input
                  className="field"
                  id="rb-new-password"
                  type="password"
                  name="new-password"
                  autoComplete="new-password"
                  enterKeyHint="done"
                  placeholder={`At least ${MIN_PASSWORD} characters`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
                <div className="account-form-actions">
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setSettingPassword(false)
                      setPassword('')
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={busy || password.length < MIN_PASSWORD}
                  >
                    {busy ? 'Saving…' : 'Save password'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="account-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-block"
                  onClick={() => setSettingPassword(true)}
                >
                  Set a password
                </button>
                {/* Worth saying plainly: an emailed link opens in Safari, and the
                    installed app has its own storage, so a link can never sign
                    you in there. A password is the only route that works. */}
                <p className="account-hint">
                  A password is the only way to sign in inside the installed app on
                  iPhone, because an emailed link always opens in Safari.
                </p>
                <button type="button" className="btn btn-secondary btn-block" onClick={signOut}>
                  Sign out
                </button>
              </div>
            )}

            {status && (
              <p className={statusClass} role="status">
                {status}
              </p>
            )}
          </Sheet>
        )}
      </>
    )
  }

  const emailOnly = mode === 'magic' || mode === 'forgot'
  const submit = mode === 'magic' ? sendLink : mode === 'forgot' ? sendPasswordReset : handlePasswordAuth

  // Not "Sign in": the segmented control below already says that, and a title
  // repeating the selected tab wastes the one line that could answer "why would
  // I?". The single-purpose modes have no tabs, so they title themselves.
  const sheetTitle =
    mode === 'magic'
      ? 'Email a sign-in link'
      : mode === 'forgot'
        ? 'Reset password'
        : 'Sync your recipes'

  return (
    <>
      {trigger}
      {open && (
        <Sheet title={sheetTitle} onClose={close}>
          <form className="account-form" onSubmit={submit}>
            {/* Segmented, not two equal buttons: these are two states of one
                form, and the tabs say so. The magic-link and reset modes have
                no second state, so they get the sheet title instead. */}
            {!emailOnly && (
              <div className="account-modes">
                <button
                  type="button"
                  className={mode === 'signin' ? 'account-mode account-mode-on' : 'account-mode'}
                  aria-pressed={mode === 'signin'}
                  onClick={() => go('signin')}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  className={mode === 'signup' ? 'account-mode account-mode-on' : 'account-mode'}
                  aria-pressed={mode === 'signup'}
                  onClick={() => go('signup')}
                >
                  Create account
                </button>
              </div>
            )}

            <label className="account-label" htmlFor="rb-email">
              Email
            </label>
            <input
              {...EMAIL_FIELD}
              className="field"
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
                <label className="account-label" htmlFor="rb-password">
                  Password
                </label>
                <input
                  className="field"
                  id="rb-password"
                  type="password"
                  name="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  enterKeyHint="go"
                  placeholder={
                    mode === 'signup' ? `At least ${MIN_PASSWORD} characters` : 'Your password'
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            )}

            {mode === 'signin' && (
              <label className="account-remember">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Remember my email on this device</span>
              </label>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={
                busy ||
                !email.trim() ||
                (!emailOnly && !password) ||
                (mode === 'signup' && password.length < MIN_PASSWORD)
              }
            >
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

            {status && (
              <p className={statusClass} role="status">
                {status}
              </p>
            )}

            {/* Alternate routes, below the action they are alternatives to.
                Cancel is gone: the sheet's own Cancel and its backdrop both do
                it, and a third way out was just noise. */}
            <p className="account-links">
              {mode === 'signin' && (
                <button type="button" className="btn btn-quiet" onClick={() => go('forgot')}>
                  Forgot password?
                </button>
              )}
              {emailOnly ? (
                <button type="button" className="btn btn-quiet" onClick={() => go('signin')}>
                  Back to password sign-in
                </button>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={() => go('magic')}>
                  Email me a link instead
                </button>
              )}
            </p>
          </form>
        </Sheet>
      )}
    </>
  )
}
