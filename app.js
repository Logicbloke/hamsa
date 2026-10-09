import { MIN_SAMPLE_RATE } from './modem/config.js';
import { MAX_BYTES, byteLength, encodeControl, encodeFrame } from './modem/codec.js';
import { modulate } from './modem/modulator.js';
import { Demodulator } from './modem/demodulator.js';

const $ = (id) => document.getElementById(id);
const log = $('log');
const text = $('text');
const sendButton = $('send');
const listenButton = $('listen');

const STORE_KEY = 'hamsa.messages';
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

// --- message log -----------------------------------------------------------

function loadMessages() {
  try {
    messages = JSON.parse(localStorage.getItem(STORE_KEY)) || [];
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
  try {
    const stored = messages.slice(-STORE_LIMIT).map(({ el, ...message }) => message);
    localStorage.setItem(STORE_KEY, JSON.stringify(stored));
  } catch {
    // Storage is a convenience; the app works without it.
  }
}

function render(message) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${message.dir}`;
  el.textContent = message.text;
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

function addMessage(dir, body, status) {
  const message = { dir, text: body, at: Date.now(), status };
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
  message.el.querySelector('span').textContent = status ? ` · ${STATUS_LABELS[status]}` : '';
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

let awaited = null;  // { id, resolve } while a sent message waits for its receipt
let lastSeen = null; // last message shown, to recognise a retransmission
let garbled = null;  // { id, message } notice to drop if a retry gets through

function onFrame(frame) {
  receiving = false;
  updateStatus();
  if (frame.type === 'ack' || frame.type === 'nack') {
    if (awaited?.id === frame.id) awaited.resolve(frame.type);
    return;
  }
  if (frame.type === 'garbled' && frame.broadcast) {
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
  const repeat = lastSeen && lastSeen.id === frame.id && lastSeen.text === frame.text &&
    Date.now() - lastSeen.at < 60000;
  lastSeen = { id: frame.id, text: frame.text, at: Date.now() };
  if (!repeat) {
    addMessage('in', frame.text, frame.broadcast ? 'broadcast' : undefined);
    // Not available on iOS, where no browser exposes vibration.
    navigator.vibrate?.([120, 60, 120]);
  }
  // Broadcasts go to many devices at once; their replies would collide.
  if (!frame.broadcast) reply('ack', frame.id);
}

async function reply(type, id) {
  await sleep(REPLY_DELAY);
  transmit(encodeControl(type, id)).catch(() => {});
}

function receiver(sampleRate) {
  demod ??= new Demodulator(sampleRate, {
    onLevel: setLevel,
    onSync() {
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
  // Half-duplex: ignore the microphone while our own audio is playing.
  tap.port.onmessage = (event) => { if (!transmitting) rx.push(event.data); };
  // The graph only runs if it reaches the destination; keep that path silent.
  const silent = audio.createGain();
  silent.gain.value = 0;
  source.connect(tap).connect(silent).connect(audio.destination);
  mic = { stream, source, tap, silent };
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
    updateStatus();
    try {
      await play(audio, modulate(frame, audio.sampleRate));
      // Let the speaker drain and the room's echo die before listening again.
      await sleep(200 + 1000 * (audio.outputLatency || 0));
    } finally {
      transmitting = false;
      demod?.reset();
      updateStatus();
    }
  };
  txQueue = txQueue.then(run, run);
  return txQueue;
}

function receipt(id) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ACK_TIMEOUT);
    awaited = { id, resolve: (result) => { clearTimeout(timer); resolve(result); } };
  }).finally(() => { awaited = null; });
}

let nextId = Math.floor(Math.random() * 256);

async function send(body, broadcast) {
  const id = nextId;
  nextId = (nextId + 1) % 256;
  const frame = encodeFrame(body, id, broadcast);
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
      if (await receipt(id) === 'ack') status = 'delivered';
    }
    setStatus(message, status);
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
  const bytes = byteLength(text.value.trim());
  $('count').textContent = `${bytes}/${MAX_BYTES}`;
  $('count').classList.toggle('over', bytes > MAX_BYTES);
  sendButton.disabled = busy || !bytes || bytes > MAX_BYTES;
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
    await send(body, $('broadcast').checked);
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

$('clear').addEventListener('click', () => {
  messages = [];
  saveMessages();
  log.querySelectorAll('.msg').forEach((el) => el.remove());
  $('empty').hidden = false;
});

loadMessages();
updateStatus();
updateComposer();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
