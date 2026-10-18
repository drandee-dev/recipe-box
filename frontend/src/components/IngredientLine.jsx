// One ingredient line with its amount in a hanging column: the quantity in bold,
// right-aligned against a column shared by every line of the list, and the item
// in the column beside it. A line with no amount ("Pepper, to taste") starts at
// the item column rather than at the left edge, so the eye keeps one edge.
//
// `ch` is the column's width in characters, from qtyColumnCh over the whole list;
// 0 means no line has an amount and the text is set plainly. The width is set in
// em, not the `ch` unit: `ch` is the width of a regular "0", and the amounts are
// bold, so an 11-character amount overflowed an 11ch column. Nothing here
// rewrites the words of the line; a leading bullet ("- ") is the one thing left
// off a line that has an amount.

import { splitAmount } from '../lib/ingredients.js'

// Average advance of a bold character in the UI face, in em, rounded up so the
// widest real amounts ("1 1/2 tbsp", "2 tablespoons") fit without wrapping.
const BOLD_EM_PER_CHAR = 0.64

export default function IngredientLine({ text, ch }) {
  if (!ch) return <span className="ing-line ing-line-flat">{text}</span>
  const { bold, rest } = splitAmount(text)
  const style = { '--qty-w': `${(ch * BOLD_EM_PER_CHAR).toFixed(2)}em` }
  if (!bold) {
    return (
      <span className="ing-line" style={style}>
        <span className="ing-text ing-text-wide">{text}</span>
      </span>
    )
  }
  // Longer than the column (it was cut to the cap): that one amount may wrap
  // inside it. Every other amount fits and never wraps.
  const over = bold.trim().length > ch
  return (
    <span className="ing-line" style={style}>
      <strong className={over ? 'ing-qty ing-qty-wrap' : 'ing-qty'}>{bold.trim()}</strong>{' '}
      <span className="ing-text">{rest.trim()}</span>
    </span>
  )
}
