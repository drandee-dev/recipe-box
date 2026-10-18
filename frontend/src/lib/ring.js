// The timer's alarm as WAV bytes, so it can be played through a normal audio
// element and looped.
//
// Why not only Web Audio: iOS mutes Web Audio when the silent switch is on, and
// `navigator.audioSession` did not change that on a real phone. An HTML audio
// element is media playback and does play over the switch (confirmed on a
// phone). Generated here rather than shipped as a file for the same reasons the
// oscillator tones were: nothing to fetch, cache or lose offline.
//
// The sound is built to be hard to miss, not pleasant. It is the classic digital
// alarm: four quick high beeps and a pause, with the third harmonic added so it
// cuts through kitchen noise better than a plain sine. It is one cycle of about
// 1.7 seconds, and the player loops it until the timer is dismissed.

const RATE = 22050
const FREQ = 1320
const BEEPS = 4
const BEEP_S = 0.11
const STEP_S = 0.17
// Silence at the end of a cycle, so the loop reads as bursts rather than a drone.
const TAIL_S = 0.85
const PEAK = 0.85
const HARMONIC = 0.35

// 16-bit mono PCM, little-endian, with a standard 44-byte header.
export function ringWavBytes() {
  const seconds = STEP_S * (BEEPS - 1) + BEEP_S + TAIL_S
  const samples = Math.round(seconds * RATE)
  const dataBytes = samples * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))

  text(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, RATE, true)
  view.setUint32(28, RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples; i += 1) {
    const t = i / RATE
    const beep = Math.floor(t / STEP_S)
    const into = t - beep * STEP_S
    let amp = 0
    if (beep < BEEPS && into < BEEP_S) {
      // A short ramp in and out so each beep has no click at its edges.
      const attack = Math.min(1, into / 0.008)
      const release = Math.min(1, (BEEP_S - into) / 0.02)
      const tone = Math.sin(2 * Math.PI * FREQ * t) + HARMONIC * Math.sin(2 * Math.PI * FREQ * 3 * t)
      amp = attack * release * PEAK * (tone / (1 + HARMONIC))
    }
    view.setInt16(44 + i * 2, Math.round(amp * 32767), true)
  }
  return bytes
}

export function ringUrl() {
  return URL.createObjectURL(new Blob([ringWavBytes()], { type: 'audio/wav' }))
}
