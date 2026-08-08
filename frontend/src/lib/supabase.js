// Supabase client — created only when both env vars are present. When they're absent,
// the app runs in local-only mode (recipes save to localStorage) and getSupabase() resolves null.
//
// **The client is imported dynamically, and that is audit item 15.** It is the
// single biggest thing in the bundle — 218 kB raw, 57 kB gzipped, against about
// 72 kB for all of the app's own code — and none of it is needed to draw the
// first screen. A static import put it in the entry chunk, so the browser had to
// download and execute all of it before React could render anything at all.
//
// Deferring it does not mean loading it late. The auth effect asks for it on
// mount, which is the moment after the first paint, so the fetch still starts
// immediately — it just stops standing between the HTML and the pixels. Paired
// with item 14 (`seedRecipes` in cache.js), a returning visit is now
// HTML → app JS → a list of real recipes with real image URLs, while Supabase
// arrives alongside and reconciles.
//
// `supabaseEnabled` stays a plain synchronous const on purpose: it answers
// "does this build have a cloud at all", which several call sites need in order
// to decide whether to ask for a client, and making that a promise would put an
// await in front of every one of them.

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseEnabled = Boolean(url && anon)

// Memoised, not re-imported: `import()` caches the module, but `createClient`
// does not cache the client, and a second client means a second GoTrue instance
// racing the first one over the same storage key.
let clientPromise = null

export function getSupabase() {
  if (!supabaseEnabled) return Promise.resolve(null)
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) =>
      // These are the client defaults, pinned explicitly because staying signed in is
      // a feature here, not an accident: the session sits in localStorage and the
      // access token refreshes itself, so a sign-in survives quitting and rebooting.
      // storageKey is deliberately left alone — changing it orphans existing sessions
      // and signs everyone out once.
      //
      // detectSessionInUrl is why App.jsx's share-param strip has to preserve
      // window.location.hash: a magic-link callback puts its tokens there, and
      // this client is now created inside an effect rather than at module load,
      // so a strip that dropped the hash would now run first.
      createClient(url, anon, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
    )
  }
  return clientPromise
}
