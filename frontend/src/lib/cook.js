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

// The *first* duration in the step, not the longest. A step reads in order, and
// the first number is the one you are about to act on: "fry for 2 minutes, then
// simmer for 20" starts with two minutes on the clock, and the 20 arrives as its
// own step or as a second press.
//
// A range takes its LOW end, unlike everything else here that reads ranges —
// "bake 25-30 minutes" means look at it at 25. A timer that fires at the high
// end has already let it go too far, and the whole point is to come back and
// check. This is the opposite choice from the shopping list's low-end rule for
// the same underlying reason: pick the end where being wrong is recoverable.
export function parseDuration(step) {
  const text = String(step ?? '')
  DURATION.lastIndex = 0
  const match = DURATION.exec(text)
  if (!match) return null

  const unit = unitSeconds(match[3])
  if (unit === null) return null
  const seconds = Math.round(Number(match[1]) * unit)
  if (!Number.isFinite(seconds) || seconds <= 0) return null

  // A step naming a whole day is describing a rest, not something to stand and
  // wait for, and a countdown that cannot survive the phone locking should not
  // claim it can. Four hours is already generous for a screen kept awake.
  if (seconds > 4 * 3600) return null

  return { seconds, label: match[0].trim() }
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
