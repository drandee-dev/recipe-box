// A bottom sheet. Everything modal in this app is one of these.
//
// It sits at the bottom because that is where a thumb is, and it covers the
// screen because the decision it holds is the only thing happening. The picker
// was the first one and had its dismissal and focus handling written inline; an
// account panel is the second, and two copies of modal focus behaviour is how
// one of them ends up subtly broken.
//
// What it guarantees, none of which the inline version did in full:
//   - Escape closes it, and so does a click on the backdrop but not on the sheet
//   - focus moves in on open and returns to whatever opened it on close
//   - Tab cycles inside it. Without a trap, tabbing past the last control walks
//     into the page behind an aria-modal dialog, which is exactly the state that
//     makes a screen reader describe a screen the user cannot see
//   - the page behind cannot scroll while it is open

import { useEffect, useRef } from 'react'

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

let sheetCount = 0

// Pull to close. Before this the only way out with a thumb was the strip of
// dimmed page above the sheet, which on the recipe detail is 6% of the screen —
// so the gesture the grab handle has been advertising since pass 1 finally does
// something.
//
// Same shape as the app's pull-to-refresh, deliberately, because the two have to
// coexist: track the start point, decide horizontal-versus-vertical once
// movement clears a slop, and only call preventDefault() after that decision, so
// a sideways drag over the day chips and a scroll down through a recipe both
// still work. The difference is the mapping. Refresh damps its pull, because
// what is being pulled is a hint about something happening elsewhere; this one
// tracks the finger exactly, because the sheet is the thing under it.
const PULL_SLOP = 8
// Far enough that a lazy scroll at the top of a recipe doesn't throw it away,
// close enough to be one gesture. Capped as a fraction as well, since a short
// sheet where the threshold is most of its height cannot be flicked at all.
const PULL_CLOSE_PX = 120
const PULL_CLOSE_FRACTION = 0.25
// A fast flick counts even if it was short — how a sheet is usually dismissed
// once the gesture is known. Pixels per millisecond over the last move.
const PULL_FLICK = 0.5
const PULL_SETTLE = '0.2s cubic-bezier(0.22, 1, 0.36, 1)'

// `action` is an optional confirming control for the head — the editor's Save.
// It lives up here rather than at the end of the form because a form long enough
// to scroll needs its save reachable from anywhere, and the alternative, a
// sticky bar across the foot, spends a full-width accent slab covering the
// fields being filled in.
//
// `className` is for size, and only size. Behaviour stays here so there is still
// exactly one modal in the app; the recipe detail asks for a taller panel than
// the 85vh default because it is a whole document rather than one decision, and
// that is a stylesheet's business, not a second component's.
export default function Sheet({
  title,
  onClose,
  children,
  closeLabel = 'Cancel',
  action = null,
  className = '',
  // Cook mode opts out. It is the one sheet you are not looking at while you
  // use it — hands busy, phone propped up, following a step — and a downward
  // brush that dismisses the screen you are cooking from is a different kind of
  // mistake from one that closes a form you can reopen.
  dismissible = true,
}) {
  const sheetRef = useRef(null)
  const headingId = useRef(`sheet-title-${Math.random().toString(36).slice(2, 9)}`)

  // onClose goes through a ref so the effect below can keep empty deps, and it
  // has to stay that way. The effect used to list [onClose], and every caller
  // passes a freshly created closure on each render — so any state change while
  // a sheet was open tore the effect down and set it up again, and the teardown
  // ends by returning focus to the opener. Typing one letter in the sign-in form
  // therefore yanked focus out of the field and onto the avatar button, which on
  // iOS dismisses the keyboard and reads as the sheet having closed. The body
  // scroll lock was flickering off and on for the same reason.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    // Whatever had focus when the sheet opened gets it back when it closes.
    // Without this, dismissing the picker drops focus to <body> and the next Tab
    // starts from the top of the page.
    const opener = document.activeElement

    // The container, not the first focusable. The first focusable is the Cancel
    // in the head, so focusing it opens a sign-in dialog by announcing "Cancel".
    // Focusing the labelled dialog itself announces its title and leaves Tab to
    // walk the content in order.
    sheetRef.current?.focus()

    // Reference counted: nested or rapidly swapped sheets must not have the
    // first one to unmount hand scrolling back to a page still covered.
    sheetCount += 1
    // …and the count doubles as a depth, which is what makes stacking safe. Both
    // sheets listen on `document`, so without this every key press ran both
    // handlers: Escape over the editor closed the editor *and* the recipe behind
    // it (stopPropagation does nothing between two listeners on the same node),
    // and Shift+Tab from the middle of the editor hit the lower sheet's trap
    // first, which saw focus outside itself and threw it to its own last item.
    // Only the topmost sheet handles keys; the ones underneath are covered.
    const depth = sheetCount
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKey(e) {
      if (depth !== sheetCount) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const items = sheetRef.current?.querySelectorAll(FOCUSABLE)
      if (!items || items.length === 0) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      // Also catches focus sitting outside the sheet entirely, which is what
      // happens when the element that had it gets removed mid-interaction.
      if (e.shiftKey && (document.activeElement === firstItem || !sheetRef.current.contains(document.activeElement))) {
        e.preventDefault()
        lastItem.focus()
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      sheetCount -= 1
      if (sheetCount === 0) document.body.style.overflow = previousOverflow
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
    // Mount and unmount only. See the onCloseRef note above before adding a dep.
  }, [])

  useEffect(() => {
    const sheet = sheetRef.current
    if (!dismissible || !sheet) return

    // Claimed at the same moment the key handler claims its depth, and read the
    // same way: a sheet with another one on top of it is covered, and a drag
    // that lands on it is a drag on something the user cannot see.
    const depth = sheetCount

    let startX = 0
    let startY = 0
    let lastY = 0
    let lastAt = 0
    let speed = 0
    let pulling = false
    let decided = false

    function reset(animate) {
      if (animate) sheet.style.transition = `transform ${PULL_SETTLE}`
      sheet.style.transform = ''
      if (animate) {
        // Cleared once it lands, or the next drag starts with a transition on
        // and the sheet lags behind the finger by two tenths of a second.
        window.setTimeout(() => {
          sheet.style.transition = ''
        }, 220)
      } else {
        sheet.style.transition = ''
      }
      pulling = false
      decided = false
    }

    function onStart(e) {
      if (depth !== sheetCount || e.touches.length !== 1) return
      // A textarea scrolls its own overflow, and a range input is a horizontal
      // drag by definition. Neither should be answering for the sheet.
      if (e.target.closest('textarea, input[type="range"]')) return
      // Only from the top. Anywhere else and the gesture is a scroll — the
      // whole sheet is the scroll container, so this is the same check
      // pull-to-refresh makes against the document.
      if (sheet.scrollTop > 0) return
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      lastY = touch.clientY
      lastAt = e.timeStamp
      speed = 0
      pulling = true
      decided = false
      sheet.style.transition = ''
    }

    function onMove(e) {
      if (!pulling) return
      const touch = e.touches[0]
      const dy = touch.clientY - startY
      const dx = touch.clientX - startX

      if (!decided) {
        if (Math.abs(dy) < PULL_SLOP && Math.abs(dx) < PULL_SLOP) return
        // Downward and mostly vertical, or this gesture belongs to something
        // else. Deciding once and sticking to it is what stops a diagonal drag
        // flickering between scrolling and dragging.
        if (dy <= 0 || Math.abs(dy) <= Math.abs(dx)) {
          pulling = false
          return
        }
        decided = true
      }

      // Only now, once the gesture is known to be ours. preventDefault before
      // the decision would kill scrolling inside the sheet.
      e.preventDefault()
      const elapsed = e.timeStamp - lastAt
      if (elapsed > 0) speed = (touch.clientY - lastY) / elapsed
      lastY = touch.clientY
      lastAt = e.timeStamp
      // The slop comes back off so nothing jumps at the moment the drag is
      // adopted, and the sheet is under the finger from the first pixel.
      sheet.style.transform = `translateY(${Math.max(0, dy - PULL_SLOP)}px)`
    }

    function onEnd(e) {
      if (!pulling) return
      if (!decided) {
        reset(false)
        return
      }
      const travelled = Math.max(0, lastY - startY - PULL_SLOP)
      const threshold = Math.min(PULL_CLOSE_PX, sheet.getBoundingClientRect().height * PULL_CLOSE_FRACTION)
      if (travelled >= threshold || speed >= PULL_FLICK) {
        // Left where it was rather than sprung back first: the sheet unmounts
        // on the next render and animating it home only to delete it reads as a
        // dismissal that failed and then took.
        pulling = false
        decided = false
        onCloseRef.current()
        return
      }
      reset(true)
      // Suppress the click the browser sends after a touch that ended over a
      // control — a short pull that settles back should not also press
      // whatever the finger came to rest on.
      if (travelled > PULL_SLOP) e.preventDefault()
    }

    function onCancel() {
      if (pulling) reset(true)
    }

    // touchmove has to be non-passive or preventDefault is ignored and iOS
    // rubber-bands the page instead — the same reason the app's pull gesture
    // uses native listeners rather than React's, which registers them passive.
    sheet.addEventListener('touchstart', onStart, { passive: true })
    sheet.addEventListener('touchmove', onMove, { passive: false })
    sheet.addEventListener('touchend', onEnd, { passive: false })
    sheet.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      sheet.removeEventListener('touchstart', onStart)
      sheet.removeEventListener('touchmove', onMove)
      sheet.removeEventListener('touchend', onEnd)
      sheet.removeEventListener('touchcancel', onCancel)
    }
    // `dismissible` never changes for a given sheet in practice; it is a dep
    // for correctness, not because it moves. If that ever stops being true,
    // note that `depth` is read at setup and re-running would re-read it.
  }, [dismissible])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className={className ? `sheet ${className}` : 'sheet'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId.current}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2 id={headingId.current} className="sheet-title">
            {title}
          </h2>
          <span className="sheet-head-actions">
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              {closeLabel}
            </button>
            {action}
          </span>
        </div>
        {children}
      </div>
    </div>
  )
}
