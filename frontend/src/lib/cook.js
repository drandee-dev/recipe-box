// Cook mode's two pure questions: does this step name a duration, and what does
// a running clock look like (finding 13).
//
// Kept out of the component because both of these fail quietly. A timer offered
// on the wrong number is worse than no timer — you set it, walk away, and the
// thing burns — so this is the part with tests on it.

const UNIT_SECONDS = [
  [/^h(ou)?rs?$/i, 3600],
  [/^m(in(ute)?s?)?$/i, 60],
  [/^s(ec(ond)?s?)?$/i, 1],
]

function unitSeconds(word) {
  const hit = UNIT_SECONDS.find(([pattern]) => pattern.test(word))
  return hit ? hit[1] : null
}

// "10 minutes", "10-12 minutes", "10 to 12 mins", "1 hour", "90 seconds",
// "1 hr 30 min". The bare "m" spelling is deliberately not accepted — "5 m" in a
// recipe is more likely a typo than five minutes, and a wrong timer is the
// failure this is trying to avoid.
const DURATION = /(\d+(?:\.\d+)?)\s*(?:(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*)?(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi

// Between "1 hr" and "30 min" there may be nothing, a space, "and" or a comma.
const JOINER = /^\s*(?:,\s*|and\s+)?$/i

// Every duration in the step, in reading order. "Brown the butter 6-8 minutes
// and cool 15 minutes" is two timers; it used to offer only the first, which
// left the cooling to be remembered.
//
// A range takes its LOW end, unlike everything else here that reads ranges —
// "bake 25-30 minutes" means look at it at 25. A timer that fires at the high
// end has already let it go too far, and the whole point is to come back and
// check. This is the opposite choice from the shopping list's low-end rule for
// the same underlying reason: pick the end where being wrong is recoverable.
//
// "1 hr 30 min" is ONE duration, not two. Left as two it offered a one-hour
// timer and a thirty-minute one and a cook would trust whichever they tapped.
export function findDurations(step) {
  const text = String(step ?? '')
  const found = []
  DURATION.lastIndex = 0
  for (let match = DURATION.exec(text); match; match = DURATION.exec(text)) {
    const unit = unitSeconds(match[3])
    const seconds = Math.round(Number(match[1]) * (unit ?? 0))
    if (!unit || !Number.isFinite(seconds) || seconds <= 0) continue
    const item = {
      start: match.index,
      end: match.index + match[0].length,
      seconds,
      unit,
      range: match[2] !== undefined,
    }
    const prev = found[found.length - 1]
    // Hours then minutes (or minutes then seconds), and neither a range.
    if (
      prev &&
      !prev.range &&
      !item.range &&
      prev.unit > item.unit &&
      JOINER.test(text.slice(prev.end, item.start))
    ) {
      prev.end = item.end
      prev.seconds += seconds
      prev.unit = item.unit
    } else {
      found.push(item)
    }
  }
  // A step naming a whole day is describing a rest, not something to stand and
  // wait for, and a countdown that cannot survive the phone locking should not
  // claim it can. Four hours is already generous for a screen kept awake.
  return found
    .filter((d) => d.seconds <= 4 * 3600)
    .map(({ start, end, seconds }) => ({ start, end, seconds, label: text.slice(start, end).trim() }))
}

// The step as pieces: plain text, and the durations in it as `{ text, seconds }`
// so a screen can make each one tappable and still print the step verbatim.
export function splitDurations(step) {
  const text = String(step ?? '')
  const pieces = []
  let at = 0
  for (const d of findDurations(text)) {
    if (d.start > at) pieces.push({ text: text.slice(at, d.start) })
    pieces.push({ text: text.slice(d.start, d.end), seconds: d.seconds })
    at = d.end
  }
  if (at < text.length) pieces.push({ text: text.slice(at) })
  return pieces
}

// mm:ss, or h:mm:ss once there is an hour on the clock. Padded so the digits
// don't shift width as it counts down; the CSS pairs this with tabular numerals
// for the same reason.
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}
