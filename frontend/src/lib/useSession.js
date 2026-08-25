import { useEffect, useState } from 'react'
import { rememberUser } from './cache.js'
import { clearCache } from './cache.js'
import { getSupabase, supabaseEnabled } from './supabase.js'

// Who is signed in, and whether we know yet.
//
// `ready` is the important half and is not the same as "signed out". It gates
// the recipe load so a cloud session still restoring is not raced by a
// localStorage read that would answer "no recipes" first and then be corrected.
// With no Supabase configured at all there is nothing to wait for, so it starts
// true.
//
// **This hook is where the Supabase client is actually built** (audit item 15),
// and that is deliberate rather than incidental. The client is the single
// biggest thing in the bundle — 219 kB raw against 290 kB for everything else —
// and none of it is needed to draw the first screen, so it is imported
// dynamically and the import is kicked off here, in an effect, after the first
// paint. The download still starts immediately; it just no longer stands between
// the HTML and a screen with recipes on it. A *static* `import` of
// `@supabase/supabase-js` anywhere in src/ silently undoes all of that.
export function useSession() {
  const [session, setSession] = useState(null)
  const [ready, setReady] = useState(!supabaseEnabled)

  useEffect(() => {
    if (!supabaseEnabled) return undefined
    let cancelled = false
    let subscription = null

    ;(async () => {
      const supabase = await getSupabase()
      if (cancelled) return
      supabase.auth.getSession().then(({ data }) => {
        if (cancelled) return
        setSession(data.session)
        setReady(true)
      })
      const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
        // The mirror is keyed per user, so the next account can't read it
        // anyway; dropping it on sign-out just avoids leaving one person's
        // recipes in storage on a shared phone.
        if (event === 'SIGNED_OUT') clearCache()
        setSession(s)
        setReady(true)
      })
      subscription = sub.subscription
      // Unmounted while the import was in flight, so the cleanup below has
      // already run and there was nothing to unsubscribe from at the time.
      if (cancelled) subscription.unsubscribe()
    })()

    return () => {
      cancelled = true
      subscription?.unsubscribe()
    }
  }, [])

  // Re-read on resume. A phone that slept through a token expiry comes back
  // with a session object that is no longer valid.
  useEffect(() => {
    if (!supabaseEnabled) return undefined
    async function onVisible() {
      if (document.visibilityState !== 'visible') return
      const supabase = await getSupabase()
      const { data } = await supabase.auth.getSession()
      setSession(data.session)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  const userId = session?.user?.id || null

  // Recorded so the next mount knows whose offline mirror to seed from. Cleared
  // with the mirror itself on sign-out, so it can never point at rows that are
  // gone.
  useEffect(() => {
    if (!ready) return
    rememberUser(userId)
  }, [ready, userId])

  return { session, userId, ready }
}
