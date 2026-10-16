// The timer's ring as WAV bytes, so it can be played through a normal audio
// element.
//
// Why not only Web Audio, which is what the ring used to be: iOS mutes Web Audio
// when the silent switch is on, and `navigator.audioSession` did not change that
// on a real phone. An HTML audio element is media playback and is understood to
// be allowed over the switch. Generated here rather than shipped as a file for
// the same reasons the oscillator tones were: nothing to fetch, cache or lose
// offline.

const RATE = 22050
const FREQ = 880
const BEEPS = 3
const BEEP_S = 0.22
const STEP_S = 0.28
const TAIL_S = 0.15
const PEAK = 0.6

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
      // A short ramp in and a longer one out, so each beep has no click at its
      // edges. Same shape as the oscillator version's gain ramps.
      const attack = Math.min(1, into / 0.02)
      const release = Math.min(1, (BEEP_S - into) / 0.06)
      amp = attack * release * PEAK * Math.sin(2 * Math.PI * FREQ * t)
    }
    view.setInt16(44 + i * 2, Math.round(amp * 32767), true)
  }
  return bytes
}

export function ringUrl() {
  return URL.createObjectURL(new Blob([ringWavBytes()], { type: 'audio/wav' }))
}
