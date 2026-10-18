// Swipe a whole screen to change the week: the planner and the shopping list
// share one week, so they share one gesture.
//
// Why this is a hook and not two copies: the planner's own version only listened
// on the block of day rows, ignored any touch that started on a button, and the
// day rows ARE buttons (an empty day is one), so on a real phone almost every
// swipe was thrown away; and the empty space under a short week was outside the
// block altogether. Measured with real touch events: a swipe starting on an empty
// day or in the space below changed nothing. The fixes are the whole screen as
// the target, and only refusing a start where a horizontal drag already means
// something else.
//
// Left to right is the previous week and right to left the next, the way a page
// turns. A drag decides its axis once, after a small slop, and a mostly vertical
// one is never ours, so scrolling is untouched.

import { useCallback, useRef, useState } from 'react'

export const SWIPE_SLOP = 8
export const WEEK_SWIPE_THRESHOLD = 56

// Where a swipe must NOT start, because a horizontal drag there already does
// something: a planned meal row (swipe to remove), a row of chips that scrolls
// sideways, and anything you type in or choose from. Buttons and links are not
// here on purpose: an empty day is a button, and a tap still taps.
//
// `.sheet-backdrop` is here because a sheet is rendered inside the screen it was
// opened from, and React hands its pointer events to the screen's handlers too:
// without it, dragging inside the day picker would turn the week behind it.
export const NO_SWIPE =
  '.planner-entry-swipe, .shopping-tools, .sheet-backdrop, input, textarea, select, [data-no-week-swipe]'

// Whether the "Swipe to change week" line has done its job. Kept on this device;
// blocked storage just means the line shows again, which is harmless.
const HINT_KEY = 'recipebox:swipeHint'

export function swipeHintSeen() {
  try {
    return localStorage.getItem(HINT_KEY) === '1'
  } catch {
    return false
  }
}

function markSwipeHintSeen() {
  try {
    localStorage.setItem(HINT_KEY, '1')
  } catch {
    // Nothing to do: see above.
  }
}

// -1 previous week, +1 next week, 0 nothing. Pure, so the rule is tested without
// a DOM: the drag has to be far enough, and more sideways than up or down.
export function weekSwipeDirection(dx, dy = 0, threshold = WEEK_SWIPE_THRESHOLD) {
  if (Math.abs(dx) < threshold) return 0
  if (Math.abs(dx) <= Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

export function useWeekSwipe(onWeekChange) {
  // slideDir only drives the entrance animation of the week that arrives. The
  // outgoing content is not animated separately; the key on the week body
  // remounts it into the new week.
  const [slideDir, setSlideDir] = useState(null)
  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [showHint, setShowHint] = useState(() => !swipeHintSeen())
  const gesture = useRef(null)
  const dragXRef = useRef(0)
  // A horizontal drag that ends over a button must not also press it. Touch
  // already withholds the click after a move; a mouse does not.
  const suppressClick = useRef(false)

  const goWeek = useCallback(
    (direction) => {
      // Moving a week by swipe or by arrow retires the hint; "This week" (0) is a
      // jump home, not a sign they have found the gesture.
      if (direction !== 0) {
        markSwipeHintSeen()
        setShowHint(false)
      }
      setSlideDir(direction > 0 ? 'right' : direction < 0 ? 'left' : null)
      onWeekChange(direction)
    },
    [onWeekChange],
  )

  function setDrag(x) {
    dragXRef.current = x
    setDragX(x)
  }

  function onPointerDown(e) {
    // First of all, before any early return: a touch swipe is never followed by a
    // click, so the flag it set would otherwise outlive it, and the next tap on a
    // planned meal or inside a sheet (both return below) would be swallowed.
    suppressClick.current = false
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (!e.isPrimary) return
    if (e.target.closest(NO_SWIPE)) return
    gesture.current = { startX: e.clientX, startY: e.clientY, axis: null }
  }

  function onPointerMove(e) {
    const g = gesture.current
    if (!g) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (g.axis === null) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return
      g.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      if (g.axis === 'horizontal') setDragging(true)
    }
    if (g.axis !== 'horizontal') return
    g.dy = dy
    // Only after the axis is decided, or a vertical drag stops scrolling.
    e.preventDefault()
    setDrag(dx)
  }

  // A cancelled pointer (the browser or system took the touch over) never turns
  // the week, however far it had travelled.
  function end(cancelled) {
    const g = gesture.current
    gesture.current = null
    if (g && g.axis === 'horizontal') {
      setDragging(false)
      // The click a mouse sends right after this lands within the same turn; a
      // touch sends none, so the flag also lapses on its own.
      suppressClick.current = true
      setTimeout(() => {
        suppressClick.current = false
      }, 100)
      const direction = cancelled === true ? 0 : weekSwipeDirection(dragXRef.current, g.dy)
      if (direction !== 0) goWeek(direction)
    }
    setDrag(0)
  }

  return {
    goWeek,
    showHint,
    slideDir,
    dragX,
    dragging,
    // Spread on the element that covers the whole screen's worth of content.
    swipeProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: () => end(false),
      onPointerCancel: () => end(true),
      onClickCapture(e) {
        if (!suppressClick.current) return
        suppressClick.current = false
        e.preventDefault()
        e.stopPropagation()
      },
    },
  }
}
