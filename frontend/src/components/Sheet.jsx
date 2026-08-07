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

// `action` is an optional confirming control for the head — the editor's Save.
// It lives up here rather than at the end of the form because a form long enough
// to scroll needs its save reachable from anywhere, and the alternative, a
// sticky bar across the foot, spends a full-width accent slab covering the
// fields being filled in.
export default function Sheet({ title, onClose, children, closeLabel = 'Cancel', action = null }) {
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
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKey(e) {
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

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
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
