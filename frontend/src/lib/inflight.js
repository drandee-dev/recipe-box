// Writes still on the wire (cloud saves, image mirrors). The auto-update in
// pwa.js waits for zero, since a reload mid-request drops the response and the
// local copy never learns whether the save landed.

let writes = 0

export function writesInFlight() {
  return writes
}

// A fetch that counts anything but a read while it runs.
export function countingFetch(input, init) {
  const method = (init?.method || input?.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return fetch(input, init)
  writes += 1
  return fetch(input, init).finally(() => {
    writes -= 1
  })
}
