// What's new: the banner on the Recipes tab and the list behind it.
//
// Ships with the code rather than living in a table, on purpose. A new
// build only replaces the running one when its worker takes over (pwa.js, the
// update bar), so what this file says is always about the build actually
// running: patch notes can't describe code the phone doesn't have yet, and
// there is nothing to fetch or go stale offline.
//
// Newest first. A release prepends its entry in the same commit as the code it
// describes, and bumps APP_VERSION and package.json together (news.test.js
// holds the three in step). Users read these, so they are written for them:
// what changed for you, never how it was built.
//
// `upcoming` announces work before it ships and carries the feedback button.
// Closing the banner remembers the entry's id, so a new id brings it back.

export const APP_VERSION = '1.1.1'

// What the update bar shows from version.json: up to three plain short lines.
// Defensive about the shape since it arrives over the network from a build this
// code has never seen; anything else is dropped rather than rendered.
export function cleanHighlights(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((line) => typeof line === 'string' && line.trim())
    .map((line) => line.trim().slice(0, 80))
    .slice(0, 3)
}

export const NEWS = [
  {
    id: '1.1.1',
    kind: 'release',
    version: '1.1.1',
    date: '2026-10-18',
    title: 'Version 1.1.1',
    body: 'A bar tells you when an update is ready, and you can ask to hear about new versions. Tap to see what changed.',
    // The short version, at most three lines of at most 60 characters, for the
    // places with no room: the update bar and the notification. The build copies
    // these into version.json, so the app that is still running (which cannot know
    // what the next release holds) can show them. news.test.js enforces the size.
    highlights: [
      'A bar tells you when an update is ready',
      'Optional heads-up when a new version is out',
      'Notification settings are together in your account',
    ],
    notes: [
      'A bar now tells you when an update is ready. Tap Reload to switch, or Later.',
      'New versions, in your account menu, sends one notification when an update is ready. It is off until you choose it.',
      'Timer alerts and New versions are together under Notifications.',
    ],
  },
  {
    id: '1.1.0',
    kind: 'release',
    version: '1.1.0',
    date: '2026-10-17',
    title: 'Version 1.1.0',
    body: 'Dark mode, notes, leftovers, timers that ring on a locked phone, and more. Tap to see what changed.',
    // A large notice that stays until the person closes it, for a release that is
    // not complete until the app has been closed and opened again. It can only
    // appear once the new build is running, so it says what to do next rather
    // than announcing something still to come.
    update: {
      heading: 'Close and reopen Recipe Box',
      text: 'Version 1.1.0 is here. If you had Recipe Box open, close the app completely and open it again to finish updating. On an iPhone, swipe up from the bottom of the screen, flick Recipe Box away, and open it from your home screen.',
    },
    notes: [
      'A recipe you write by hand can now get a photo from your camera or your photo library.',
      'Imported recipes get more accurate tags.',
      'Timers can now alert you on a locked phone, if you install the app and allow notifications. On an iPhone this needs iOS 18.4 or later.',
      'Run several timers at once from a tray that follows you around, and add one by hand.',
      'Switch recipes and the shopping list between metric and US measures. Amounts of the same thing now add up across units, so ticks on weight and volume items start fresh once.',
      'Plan a meal for more or fewer people and the shopping list buys for that many. Tap a planned meal to open it, move it to another day, or mark it as leftovers so nothing is bought for it.',
      "Mark things you always have, like salt, as staples. Move an item to its real aisle and put the aisles in your shop's order. Share the list as text.",
      "Add some of a recipe's ingredients to the list without planning it.",
      'Add notes to a recipe, mark it as cooked, and sort by recently cooked or most cooked.',
      'Swipe the Planner or Shopping screen to change the week.',
      'Cook mode shows how much of each ingredient the step uses, so you do not have to scroll the list.',
      'Recipes divided into parts, like crust, filling and topping, keep their headings, and cook mode shows which part a step belongs to. Recipes you saved before this update have no parts until you import them again.',
      'Download all your recipes as a file from the account menu.',
      'Dark mode follows your phone, or choose Light or Dark in the account menu.',
      'Easier to read: bigger recipe text, amounts lined up in a column, ingredients beside the step in cook mode, a slimmer update notice, and a wider layout on tablets and laptops.',
      'A bigger icon on the iPhone home screen. To get it, remove the app from your home screen and add it again.',
      'If the app looks the same as before, close it completely and open it again to get this update.',
    ],
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
