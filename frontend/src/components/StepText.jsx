// A step's text with every duration in it made tappable (A1). Pressing "15
// minutes" starts a 15 minute timer; pressing it again while it runs stops it.
//
// The step is printed exactly as written. A chip is the original words, so
// nothing is rewritten and a duration we misread is still legible as the
// recipe's own sentence.

import { Fragment } from 'react'
import { convertTemperatures } from '../lib/convert.js'
import { formatClock, splitDurations } from '../lib/cook.js'
import { isDue, secondsLeft } from '../lib/timers.js'
import { useTimers } from '../lib/useTimers.jsx'

export default function StepText({ text, recipe, step, units = 'original' }) {
  const { timers, now, start, stop, full } = useTimers()
  let nth = 0

  // Oven temperatures are converted in the plain text between the timer chips. A
  // temperature is never split by a duration, so doing it piece by piece is the
  // same as doing it on the whole step.
  return splitDurations(text).map((piece, i) => {
    if (piece.seconds === undefined) {
      return <Fragment key={i}>{convertTemperatures(piece.text, units)}</Fragment>
    }

    // Which duration in this step it is, so two chips in one step are two timers.
    const key = `${recipe.id}:${step}:${nth}`
    nth += 1
    const running = timers.find((t) => t.key === key)
    const due = running ? isDue(running, now) : false

    if (!running) {
      return (
        <button
          key={i}
          type="button"
          className="step-time"
          disabled={full}
          aria-label={`Start a ${piece.text} timer`}
          onClick={() =>
            start({
              label: piece.text,
              seconds: piece.seconds,
              key,
              recipeId: recipe.id,
              recipeTitle: recipe.title,
              step,
            })
          }
        >
          {piece.text}
        </button>
      )
    }
    return (
      <button
        key={i}
        type="button"
        className={due ? 'step-time step-time-ringing' : 'step-time step-time-running'}
        // Starts with the visible text (the clock), so the name contains the label.
        aria-label={
          due
            ? `Time's up, dismiss the ${piece.text} timer`
            : `${formatClock(secondsLeft(running, now))}, stop the ${piece.text} timer`
        }
        onClick={() => stop(running.id)}
      >
        {due ? "Time's up" : formatClock(secondsLeft(running, now))}
      </button>
    )
  })
}
