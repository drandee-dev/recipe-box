// Platform sniffs, in one place because two of them already existed.
//
// `isIos` lived inside InstallPrompt, and pass 4 needs the same answer in the
// capture sheet: the Shortcut setup is the iPhone capture path and there is
// nothing for anyone else to do with it. Two copies of a user-agent regex is how
// one of them ends up not knowing about iPadOS.

export function isIos() {
  const ua = navigator.userAgent
  // An iPad on iPadOS 13+ reports a Mac user agent, so touch points are the
  // only way to tell it apart from a desktop.
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // Safari's own flag, which predates the media query and is still the only
    // one iOS sets for a home-screen app.
    window.navigator.standalone === true
  )
}
