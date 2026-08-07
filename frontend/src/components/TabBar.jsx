/* The three primary sections, at the bottom where the thumb is.
 *
 * They used to sit at y=65, which on an 844px phone is the far end of a reach
 * and, in Safari, directly under the address bar. Apple's HIG and Material both
 * put three to five primary sections along the bottom edge, and this app has
 * exactly three.
 *
 * Moving them also settles the older complaint that the tabs were shaped like
 * cards: they carried a white surface and a border, which is the treatment the
 * recipe cards use, so three of them sat in a row above eight more of the same
 * shape. Down here a tab is an icon over a label and nothing else — no fill, no
 * outline, no surface. The accent marks the active one because tapping a tab is
 * an action, but it marks the mark and the word, never a slab behind them.
 */

const ICON = {
  recipes: (
    <>
      <path d="M3.5 5.5h5A3 3 0 0 1 11.5 8.5v10a2.6 2.6 0 0 0-2.6-1.7H3.5z" />
      <path d="M20.5 5.5h-5a3 3 0 0 0-3 3v10a2.6 2.6 0 0 1 2.6-1.7h5.4z" />
    </>
  ),
  planner: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  shopping: (
    <>
      <path d="M3 4.5h2.1l2.4 10.3h9.2l2.2-7.5H6.3" />
      <circle cx="9.6" cy="18.7" r="1.4" />
      <circle cx="16.9" cy="18.7" r="1.4" />
    </>
  ),
}

const TABS = [
  ['recipes', 'Recipes'],
  ['planner', 'Planner'],
  ['shopping', 'Shopping'],
]

export default function TabBar({ tab, onChange }) {
  return (
    <nav className="rb-tabbar" aria-label="Sections">
      <div className="rb-tabbar-row">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'rb-tab rb-tab-active' : 'rb-tab'}
            // aria-current is what tells a screen reader which of the three is
            // showing. Without it the active tab is a purely visual state and
            // the nav reads as three identical buttons.
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => onChange(id)}
          >
            {/* The label below names the tab, so naming the icon too would only
                make a screen reader say the same word twice. */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              {ICON[id]}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
