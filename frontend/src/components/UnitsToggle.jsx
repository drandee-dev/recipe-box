// Original / Metric / US. Used twice: as the standing setting in the account
// sheet, and on an open recipe to flip that one recipe without changing the
// setting. The styling is the feedback sheet's Suggestion / Bug control.

const OPTIONS = [
  ['original', 'As written'],
  ['metric', 'Metric'],
  ['us', 'US'],
]

// `options` is for the other three-way setting that looks the same (the theme in
// the account sheet): a list of [value, label] pairs.
export default function UnitsToggle({ value, onChange, label = 'Units', options = OPTIONS }) {
  return (
    <div className="account-modes units-toggle" role="group" aria-label={label}>
      {options.map(([mode, text]) => (
        <button
          key={mode}
          type="button"
          className={value === mode ? 'account-mode account-mode-on' : 'account-mode'}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {text}
        </button>
      ))}
    </div>
  )
}
