// The one-time line that says this screen swipes. A week bar with arrows reads
// as buttons only; nothing about a plain list says it also turns like a page.
// Shown by the screens until the week has been changed once (lib/useWeekSwipe),
// then never again on this device. Plain text, not a control: a dismiss button
// would be a second tap target to justify, and changing the week retires it.

export default function SwipeHint() {
  return (
    <p className="swipe-hint">
      <span className="swipe-hint-chev swipe-hint-chev-l" aria-hidden="true">
        ‹
      </span>
      Swipe to change week
      <span className="swipe-hint-chev swipe-hint-chev-r" aria-hidden="true">
        ›
      </span>
    </p>
  )
}
