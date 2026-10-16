// What's new: the banner on the Recipes tab and the list behind it.
//
// Ships with the code rather than living in a table, on purpose. pwa.js
// installs a new build and reloads on the next open, so what this file says is
// always about the build actually running: patch notes can't describe code the
// phone doesn't have yet, and there is nothing to fetch or go stale offline.
//
// Newest first. A release prepends its entry in the same commit as the code it
// describes, and bumps APP_VERSION and package.json together (news.test.js
// holds the three in step). Users read these, so they are written for them:
// what changed for you, never how it was built.
//
// `upcoming` announces work before it ships and carries the feedback button.
// Closing the banner remembers the entry's id, so a new id brings it back.

export const APP_VERSION = '1.0.1'

export const NEWS = [
  {
    id: '2026-10-update-coming',
    kind: 'upcoming',
    date: '2026-10-16',
    title: 'An update is on the way',
    body:
      "Timers that ring when time's up, even with the phone locked in the installed app, switching between metric and US measures, and a better shopping list. Have an idea or found a bug?",
  },
  {
    id: '1.0.1',
    kind: 'release',
    version: '1.0.1',
    date: '2026-10-16',
    title: 'Version 1.0.1',
    notes: [
      'Scaling a recipe now scales a weight in brackets as well, like the 200g in 1 cup (200g).',
      'You can send suggestions and bug reports from the account screen.',
      "This What's new page, where every update will be listed.",
    ],
  },
]

const SEEN_KEY = 'recipebox:newsSeen'

export function latestNews(news = NEWS) {
  return news[0] || null
}

// Storage can throw or come back empty (private windows, cleared site data).
// Either way the banner simply shows again, which is the safe direction.
export function newsSeen(id) {
  try {
    return localStorage.getItem(SEEN_KEY) === id
  } catch {
    return false
  }
}

export function markNewsSeen(id) {
  try {
    localStorage.setItem(SEEN_KEY, id)
  } catch {
    // Nothing to do: it shows again next time.
  }
}
