// Date helpers for the planner. Weeks start Sunday, which is when the week's
// shopping actually happens, so a plan and the list it feeds cover the same
// span.
//
// Everything here works in local time on purpose. plan_date is a Postgres
// `date` with no zone, and toISOString() converts to UTC first, so west of
// Greenwich an evening assignment would save under the day before.

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack']

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// Midnight local, so arithmetic never lands mid-day and drifts across a DST
// boundary.
export function atMidnight(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function toISODate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// The inverse of toISODate, and it has to be hand-parsed for the same reason
// toISODate is hand-formatted: `new Date('2026-08-09')` is read as an ISO
// *instant* and lands on UTC midnight, which is the 8th anywhere west of
// Greenwich. Splitting the parts and handing them to the local constructor is
// the only round trip that survives.
export function fromISODate(iso) {
  const [year, month, day] = String(iso).split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function addDays(date, count) {
  const out = atMidnight(date)
  out.setDate(out.getDate() + count)
  return out
}

// getDay() is 0 for Sunday, so subtracting it lands on the week's Sunday.
export function startOfWeek(date) {
  const out = atMidnight(date)
  out.setDate(out.getDate() - out.getDay())
  return out
}

export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
}

export function dayName(date) {
  return DAY_NAMES[date.getDay()]
}

export function shortDate(date) {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()}`
}

export function isSameDay(a, b) {
  return toISODate(a) === toISODate(b)
}

// "Aug 3 – 9" when one month, "Aug 31 – Sep 6" when it straddles two.
export function weekRangeLabel(weekStart) {
  const end = addDays(weekStart, 6)
  const tail =
    weekStart.getMonth() === end.getMonth() ? String(end.getDate()) : shortDate(end)
  return `${shortDate(weekStart)} – ${tail}`
}
