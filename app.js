import { MIN_SAMPLE_RATE } from './modem/config.js';
import {
  MAX_BYTES, NAME_MAX_BYTES, byteLength, encodeAnnounce, encodeControl, encodeFrame, encodeRange,
} from './modem/codec.js';
import { modulate } from './modem/modulator.js';
import { Demodulator } from './modem/demodulator.js';
import { distance, formatDistance, turnaroundMicros } from './modem/ranging.js';

const $ = (id) => document.getElementById(id);
const log = $('log');
const text = $('text');
const sendButton = $('send');
const listenButton = $('listen');

const STORE_KEY = 'hamsa.messages';
const NAME_KEY = 'hamsa.name';
const DEVICE_KEY = 'hamsa.device';
const STORE_LIMIT = 200;
// ?loopback feeds sent audio straight into the receiver: a self-test that
// needs neither speaker nor microphone.
const LOOPBACK = new URLSearchParams(location.search).has('loopback');
const LOOPBACK_RATE = 48000;

// Delivery receipts. The receiver answers after REPLY_DELAY so the sender has
// finished playing and unmuted its microphone; the sender waits ACK_TIMEOUT
// for that answer before trying again.
const REPLY_DELAY = 600;
const ACK_TIMEOUT = 3500;
const ATTEMPTS = 3;
// After its receipt the receiver sends one more frame, the timing needed to
// work out the distance. Stay off the air until it has arrived.
const RANGE_TIMEOUT = 2500;
// A frame carrying our own id is our own sound if it ends this soon after we
// stopped playing; later than that, another device has picked the same id.
const ECHO_WINDOW = 1000;
// A device not heard from for this long is assumed to have left.
const PEER_TTL = 5 * 60 * 1000;
const JOIN_LINES = [
  '{name} is listening',
  '{name} is on the frequency',
  '{name} tuned in',
  '{name} joined the whisper',
  '{name} is within earshot',
  '{name} just dropped in',
];
const STATUS_LABELS = {
  sending: 'Sending…',
  waiting: 'Waiting for receipt…',
  retrying: 'No receipt, sending again…',
  delivered: 'Delivered ✓',
  failed: 'Not delivered',
  sent: 'Sent, no receipt (microphone off)',
  broadcast: 'Broadcast',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ctx = null;
let demod = null;
let mic = null;
let busy = false;         // a send, including its retries, is in progress
let transmitting = false; // our own audio is playing; the microphone is ignored
let receiving = false;
let messages = [];
let lastTransmit = 0;     // when our own audio last stopped

function stored(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function store(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    // Storage is a convenience; the app works without it.
  }
}

// --- identity --------------------------------------------------------------

// Trim a name to what fits in a frame without splitting a character.
function clipName(value) {
  const chars = Array.from((value || '').replace(/[\u0000-\u001f]/g, ' ').trim());
  while (byteLength(chars.join('')) > NAME_MAX_BYTES) chars.pop();
  return chars.join('').trim();
}

let name = clipName(stored(localStorage, NAME_KEY));
// Random id that tells devices apart on the air, including our own echo.
let deviceId = Number(stored(sessionStorage, DEVICE_KEY) ?? NaN);
if (!(deviceId >= 0 && deviceId < 256)) newDeviceId();

function newDeviceId() {
  deviceId = Math.floor(Math.random() * 256);
  store(sessionStorage, DEVICE_KEY, String(deviceId));
}

function showNamer(show) {
  $('namer').hidden = !show;
  $('composer').hidden = show;
  $('rename').hidden = show || !name;
  $('rename').textContent = `You: ${name}`;
  if (show) $('name').focus();
}

// --- nearby devices --------------------------------------------------------

const peers = new Map();   // device id -> { name, at } for devices heard lately
const greeted = new Map(); // device id -> when its arrival was last announced

// With two or more other devices around, receipts would collide: everything
// is sent as a broadcast.
function groupMode() {
  return peers.size >= 2;
}

function updateRoster() {
  for (const [id, peer] of peers) if (Date.now() - peer.at > PEER_TTL) peers.delete(id);
  const names = [...peers.values()].map((peer) => peer.name || 'Someone');
  $('roster').hidden = !names.length;
  $('roster').textContent = `Nearby: ${names.join(', ')}${groupMode() ? ' · group mode, no receipts' : ''}`;
}

// Note that a device was heard. Returns true if it was not known before.
function heard(frame) {
  const known = peers.get(frame.from);
  peers.set(frame.from, { name: frame.name || known?.name || '', at: Date.now() });
  updateRoster();
  // A send still waiting for its receipt will not get a clean one now.
  if (groupMode()) awaited?.resolve({ type: 'group' });
  return !known;
}

// Say hello, or answer one, after a random delay and only on a quiet channel,
// so several devices answering the same hello rarely talk over each other.
let announcing = null;
function announce(type, min, max) {
  if (announcing) return;
  const attempt = () => {
    if (!mic && !LOOPBACK) {
      announcing = null;
    } else if (busy || transmitting || replying || demod?.receiving) {
      announcing = setTimeout(attempt, 400 + Math.random() * 800);
    } else {
      announcing = null;
      transmit(encodeAnnounce(type, deviceId, name)).catch(() => {});
    }
  };
  announcing = setTimeout(attempt, min + Math.random() * (max - min));
}
// --- message log -----------------------------------------------------------

function loadMessages() {
  try {
    messages = JSON.parse(stored(localStorage, STORE_KEY)) || [];
  } catch {
    messages = [];
  }
  // A send that was interrupted by closing the page never got its receipt.
  for (const message of messages) {
    if (['sending', 'waiting', 'retrying'].includes(message.status)) message.status = 'failed';
  }
  messages.forEach(render);
}

function saveMessages() {
  const kept = messages.slice(-STORE_LIMIT).map(({ el, ...message }) => message);
  store(localStorage, STORE_KEY, JSON.stringify(kept));
}

function render(message) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${message.dir}`;
  el.textContent = message.text;
  if (message.name) {
    const who = document.createElement('b');
    who.textContent = message.name;
    el.prepend(who);
  }
  const meta = document.createElement('small');
  const time = document.createElement('time');
  time.dateTime = new Date(message.at).toISOString();
  time.textContent = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const status = document.createElement('span');
  meta.append(time, status);
  el.append(meta);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  message.el = el;
  setStatus(message, message.status);
  return el;
}

function addMessage(dir, body, status, from) {
  const message = { dir, text: body, at: Date.now(), status };
  if (from) message.name = from;
  if (dir !== 'bad') {
    messages.push(message);
    saveMessages();
  }
  render(message);
  return message;
}

function setStatus(message, status) {
  message.status = status;
  message.el.dataset.status = status || '';
  let label = status ? ` · ${STATUS_LABELS[status]}` : '';
  if (status === 'delivered' && message.distance != null) {
    label += ` · ${formatDistance(message.distance)} away`;
  }
  message.el.querySelector('span').textContent = label;
}

// A line in the log that is not a message, such as someone arriving.
function addNote(body) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = 'note';
  el.textContent = body;
  log.append(el);
  log.scrollTop = log.scrollHeight;
}

// --- status ----------------------------------------------------------------

function showNotice(message) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
}

function updateStatus() {
  const [state, label] = transmitting ? ['sending', 'Sending…']
    : receiving ? ['receiving', 'Receiving…']
    : mic || LOOPBACK ? ['listening', LOOPBACK ? 'Loopback test' : 'Listening']
    : ['idle', 'Not listening'];
  $('status').dataset.state = state;
  $('status').textContent = label;
  listenButton.setAttribute('aria-pressed', String(Boolean(mic)));
  listenButton.textContent = mic ? 'Stop listening' : 'Start listening';
}

let level = 0;
let meterQueued = false;
function setLevel(db) {
  // Map -90..-20 dBFS onto the meter.
  level = Math.max(0, Math.min(100, ((db + 90) / 70) * 100));
  if (meterQueued) return;
  meterQueued = true;
  requestAnimationFrame(() => {
    meterQueued = false;
    $('meter-fill').style.width = `${level}%`;
    $('meter').setAttribute('aria-valuenow', String(Math.round(level)));
  });
}

// --- receiving -------------------------------------------------------------

let awaited = null;      // { id, resolve } while a sent message waits for its receipt
let awaitedRange = null; // resolve, while a delivered message waits for its timing frame
let lastSeen = null;     // last message shown, to recognise a retransmission
let garbled = null;      // { id, message } notice to drop if a retry gets through
let selfHeard = null;    // our own latest frame as the microphone heard it
let ranging = null;      // { id, at } of the message whose receipt we are sending
let replying = 0;        // receipts waiting to go out

function onFrame(frame) {
  receiving = false;
  updateStatus();
  const echo = !LOOPBACK && (transmitting || Date.now() - lastTransmit < ECHO_WINDOW);
  if (frame.type === 'range') {
    if (!echo) awaitedRange?.(frame);
    return;
  }
  if (!LOOPBACK && frame.from === deviceId) {
    if (echo) {
      heardSelf(frame);
      return;
    }
    newDeviceId();
  }
  const fresh = heard(frame);
  const who = frame.name || peers.get(frame.from).name || 'Someone';
  if (frame.type === 'hello') {
    if (Date.now() - (greeted.get(frame.from) || 0) > 60000) {
      greeted.set(frame.from, Date.now());
      addNote(JOIN_LINES[Math.floor(Math.random() * JOIN_LINES.length)].replace('{name}', who));
    }
    announce('here', 500, 4500);
    return;
  }
  if (frame.type === 'here') {
    if (fresh) addNote(`Also here: ${who}`);
    return;
  }
  if (frame.type === 'ack' || frame.type === 'nack') {
    if (awaited?.id === frame.id) awaited.resolve(frame);
    return;
  }
  // Broadcasts go to many devices at once; their replies would collide. The
  // same holds for a sender that has not noticed the group yet: tell it we
  // are here, once its exchange with any other receiver is over.
  const silent = frame.broadcast || groupMode();
  if (silent && !frame.broadcast) announce('here', 3500, 6000);
  if (frame.type === 'garbled' && silent) {
    addMessage('bad', 'A broadcast arrived but was too garbled to read.');
    return;
  }
  if (frame.type === 'garbled') {
    if (garbled?.id !== frame.id) {
      garbled = { id: frame.id, message: addMessage('bad', 'A message arrived but was too garbled to read. Asking the sender to repeat it…') };
    }
    reply('nack', frame.id);
    return;
  }
  if (garbled?.id === frame.id) garbled.message.el.remove();
  garbled = null;
  // A repeat means our receipt was lost: acknowledge again, show it once.
  const repeat = lastSeen && lastSeen.id === frame.id && lastSeen.from === frame.from &&
    lastSeen.text === frame.text && Date.now() - lastSeen.at < 60000;
  lastSeen = { id: frame.id, from: frame.from, text: frame.text, at: Date.now() };
  if (!repeat) {
    addMessage('in', frame.text, frame.broadcast ? 'broadcast' : undefined, frame.name);
    // Not available on iOS, where no browser exposes vibration.
    navigator.vibrate?.([120, 60, 120]);
  }
  if (silent) return;
  ranging = { id: frame.id, at: frame.at };
  reply('ack', frame.id);
}

// Our own transmission, picked up by our own microphone. Once the receipt we
// sent has been heard, the time between the message arriving and the receipt
// leaving is known: send it, so the other side can work out the distance.
function heardSelf(frame) {
  selfHeard = frame;
  if (frame.type !== 'ack') return;
  if (ranging?.id === frame.id && ranging.at !== undefined && frame.at !== undefined) {
    transmit(encodeRange(turnaroundMicros(ranging.at, frame.at))).catch(() => {});
  }
  ranging = null;
}

async function reply(type, id) {
  replying++;
  try {
    await sleep(REPLY_DELAY);
    await transmit(encodeControl(type, id, deviceId));
  } catch {
    // The sender will ask again.
  } finally {
    replying--;
  }
}

function receiver(sampleRate) {
  demod ??= new Demodulator(sampleRate, {
    onLevel: setLevel,
    onSync(length, header) {
      if (!LOOPBACK && header.from === deviceId) return;
      receiving = true;
      updateStatus();
    },
    onFrame,
  });
  return demod;
}

// --- audio -----------------------------------------------------------------

async function audioContext() {
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('This browser has no Web Audio support.');
    ctx = new Ctor({ latencyHint: 'playback' });
  }
  if (ctx.state === 'suspended') await ctx.resume();
  if (ctx.sampleRate < MIN_SAMPLE_RATE) {
    throw new Error(
      `Audio is running at ${ctx.sampleRate} Hz, too low for ultrasound. ` +
      'Disconnect Bluetooth headsets and use the built-in speaker and microphone.',
    );
  }
  return ctx;
}

async function startListening() {
  if (!window.isSecureContext) {
    throw new Error('The microphone only works on https:// pages.');
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('This browser cannot capture microphone audio. Update it, or on iOS try Safari.');
  }
  // Ask for the microphone and start the audio context in the same tap, before
  // any await: iOS browsers only honour both while the tap is still "active".
  // Voice processing filters out exactly the frequencies we need.
  const pending = navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  let audio;
  let stream;
  try {
    [audio, stream] = await Promise.all([audioContext(), pending]);
  } catch (error) {
    pending.then((s) => s.getTracks().forEach((track) => track.stop()), () => {});
    throw error;
  }
  // Opening the microphone can suspend the context on iOS.
  if (audio.state !== 'running') await audio.resume();
  await audio.audioWorklet.addModule('modem/rx-worklet.js');
  const rx = receiver(audio.sampleRate);
  rx.reset();
  const source = audio.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(audio, 'rx-tap', { channelCount: 1, channelCountMode: 'explicit' });
  // Our own audio is heard too: the distance to the other device is worked
  // out from when each side hears itself and the other.
  tap.port.onmessage = (event) => rx.push(event.data);
  // The graph only runs if it reaches the destination; keep that path silent.
  const silent = audio.createGain();
  silent.gain.value = 0;
  source.connect(tap).connect(silent).connect(audio.destination);
  mic = { stream, source, tap, silent };
  announce('hello', 200, 600);
}

function stopListening() {
  if (!mic) return;
  mic.stream.getTracks().forEach((track) => track.stop());
  mic.tap.port.onmessage = null;
  mic.source.disconnect();
  mic.tap.disconnect();
  mic.silent.disconnect();
  mic = null;
  receiving = false;
  demod?.reset();
  setLevel(-Infinity);
}

function play(audio, samples) {
  return new Promise((resolve) => {
    const buffer = audio.createBuffer(1, samples.length, audio.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.onended = resolve;
    source.start();
  });
}

// Play one frame. Transmissions are queued so a receipt never overlaps a
// message of our own.
let txQueue = Promise.resolve();
function transmit(frame) {
  const run = async () => {
    if (LOOPBACK) {
      await sleep(0);
      receiver(LOOPBACK_RATE).push(modulate(frame, LOOPBACK_RATE));
      return;
    }
    const audio = await audioContext();
    transmitting = true;
    selfHeard = null;
    updateStatus();
    try {
      await play(audio, modulate(frame, audio.sampleRate));
      // Let the speaker drain and the room's echo die before listening again.
      await sleep(200 + 1000 * (audio.outputLatency || 0));
    } finally {
      transmitting = false;
      lastTransmit = Date.now();
      updateStatus();
    }
  };
  txQueue = txQueue.then(run, run);
  return txQueue;
}

function receipt(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'timeout' }), ACK_TIMEOUT);
    awaited = { id, resolve: (result) => { clearTimeout(timer); resolve(result); } };
  }).finally(() => { awaited = null; });
}

// The timing frame that follows a receipt, or null if it does not come.
function rangeReport() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), RANGE_TIMEOUT);
    awaitedRange = (frame) => { clearTimeout(timer); resolve(frame); };
  }).finally(() => { awaitedRange = null; });
}

let nextId = Math.floor(Math.random() * 256);

async function send(body, broadcast) {
  const id = nextId;
  nextId = (nextId + 1) % 256;
  const frame = encodeFrame(body, { id, from: deviceId, name, broadcast });
  const message = addMessage('out', body, 'sending');
  busy = true;
  updateComposer();
  // Receipts can only be heard with the microphone on. Turn it on here, before
  // any await, so the permission prompt is tied to the tap on Send.
  const listening = mic || LOOPBACK || broadcast ? null : startListening();
  try {
    try {
      await listening;
    } catch (error) {
      showNotice(`Sending without a delivery receipt. ${describe(error)}`);
    }
    updateStatus();
    let status = 'failed';
    let acked = null;
    for (let attempt = 0; attempt < ATTEMPTS && status === 'failed'; attempt++) {
      if (attempt) {
        setStatus(message, 'retrying');
        // Random back-off, so two devices that collided do not collide again.
        await sleep(300 + Math.random() * 500);
      }
      await transmit(frame);
      if (broadcast) {
        status = 'broadcast';
        break;
      }
      if (!mic && !LOOPBACK) {
        status = 'sent';
        break;
      }
      if (!attempt) setStatus(message, 'waiting');
      const answer = await receipt(id);
      if (answer.type === 'ack') {
        status = 'delivered';
        acked = answer;
      } else if (groupMode()) {
        // More devices turned up while waiting; they will not send receipts.
        status = 'broadcast';
      }
    }
    setStatus(message, status);
    if (acked && !LOOPBACK) {
      const sent = selfHeard?.type === 'message' && selfHeard.id === id ? selfHeard.at : undefined;
      const report = await rangeReport();
      if (report && sent !== undefined && acked.at !== undefined) {
        message.distance = distance(sent, acked.at, report.micros);
        setStatus(message, status);
      }
    }
  } catch (error) {
    setStatus(message, 'failed');
    throw error;
  } finally {
    busy = false;
    saveMessages();
    updateComposer();
  }
}

// --- composer --------------------------------------------------------------

function updateComposer() {
  // The name and a separator travel in the same frame as the text.
  const limit = MAX_BYTES - 1 - byteLength(name);
  const bytes = byteLength(text.value.trim());
  $('count').textContent = `${bytes}/${limit}`;
  $('count').classList.toggle('over', bytes > limit);
  sendButton.disabled = busy || !name || !bytes || bytes > limit;
  text.style.height = 'auto';
  text.style.height = `${text.scrollHeight + 3}px`;
}

const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function describe(error) {
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
    return IOS
      ? 'Microphone access was blocked. In the iOS Settings app, open the entry for this browser ' +
        '(for example Settings > Apps > Chrome), turn Microphone on, then reload this page.'
      : 'Microphone access was blocked. Allow it in the browser’s site settings, then try again.';
  }
  if (error.name === 'NotFoundError') return 'No microphone was found on this device.';
  if (error.name === 'NotReadableError') return 'The microphone is in use by another app. Close it and try again.';
  return `${error.message || error} (${error.name || 'error'})`;
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = text.value.trim();
  if (sendButton.disabled) return;
  text.value = '';
  showNotice('');
  try {
    updateRoster();
    await send(body, $('broadcast').checked || groupMode());
  } catch (error) {
    showNotice(describe(error));
  }
});

text.addEventListener('input', updateComposer);
text.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});

listenButton.addEventListener('click', async () => {
  listenButton.disabled = true;
  showNotice('');
  try {
    if (mic) stopListening();
    else await startListening();
  } catch (error) {
    showNotice(describe(error));
  }
  listenButton.disabled = false;
  updateStatus();
});

$('namer').addEventListener('submit', (event) => {
  event.preventDefault();
  const chosen = clipName($('name').value);
  if (!chosen) return;
  const changed = chosen !== name;
  name = chosen;
  store(localStorage, NAME_KEY, name);
  showNamer(false);
  updateComposer();
  text.focus();
  // Let devices already listening learn the new name.
  if (changed && mic) announce('hello', 200, 600);
});

$('rename').addEventListener('click', () => {
  $('name').value = name;
  showNamer(true);
});

$('clear').addEventListener('click', () => {
  messages = [];
  saveMessages();
  log.querySelectorAll('.msg, .note').forEach((el) => el.remove());
  $('empty').hidden = false;
});

setInterval(updateRoster, 30000);

loadMessages();
showNamer(!name);
updateStatus();
updateComposer();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
