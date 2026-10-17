// One ingredient line with its amount in a hanging column: the quantity in bold,
// right-aligned against a column shared by every line of the list, and the item
// in the column beside it. A line with no amount ("Pepper, to taste") starts at
// the item column rather than at the left edge, so the eye keeps one edge.
//
// `ch` is the column's width from qtyColumnCh over the whole list; 0 means no line
// has an amount and the text is set plainly. Nothing here rewrites the line: the
// bold part and the rest always join back into it (splitAmount).

import { splitAmount } from '../lib/ingredients.js'

export default function IngredientLine({ text, ch }) {
  if (!ch) return <span className="ing-line ing-line-flat">{text}</span>
  const { bold, rest } = splitAmount(text)
  const style = { '--qty-ch': `${ch}ch` }
  if (!bold) {
    return (
      <span className="ing-line" style={style}>
        <span className="ing-text ing-text-wide">{text}</span>
      </span>
    )
  }
  return (
    <span className="ing-line" style={style}>
      <strong className="ing-qty">{bold.trim()}</strong>
      <span className="ing-text">{rest.trim()}</span>
    </span>
  )
}
