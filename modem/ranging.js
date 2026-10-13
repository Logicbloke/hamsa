// Two-way acoustic ranging. Each device times, on its own microphone, both its
// own transmission and the other device's. With A sending a message and B
// answering it:
//   A hears itself at a1 and the answer at a2
//   B hears the message at b1 and itself at b2
//   distance = c/2 * ((a2 - a1) - (b2 - b1)) + SELF_PATH
// Speaker and microphone latency appear in both terms of each difference and
// cancel. B reports (b2 - b1) to A in a range frame.

export const SPEED_OF_SOUND = 343; // m/s in air at 20 °C
// Typical distance from a device's own speaker to its own microphone.
export const SELF_PATH = 0.03;

// The turnaround is sent modulo 65.536 ms: A knows its own interval, and the
// two differ only by the sound's travel time.
const WRAP = 65536;
const MAX_METRES = 10;

const wrap = (micros) => ((micros % WRAP) + WRAP) % WRAP;

// Times are in seconds on the measuring device's own clock.
export function turnaroundMicros(heard, answered) {
  return wrap(Math.round((answered - heard) * 1e6));
}

// Metres between the two devices, or null if the timings make no sense.
export function distance(sent, answered, micros) {
  let travel = wrap((answered - sent) * 1e6 - micros);
  // Just below the wrap is a small negative: noise around zero distance.
  if (travel > WRAP - 4000) travel -= WRAP;
  const metres = (SPEED_OF_SOUND * travel * 1e-6) / 2 + SELF_PATH;
  if (!(metres > -0.3 && metres <= MAX_METRES)) return null;
  return Math.max(0, metres);
}

export function formatDistance(metres) {
  return metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(1)} m`;
}
