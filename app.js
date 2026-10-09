import { MIN_SAMPLE_RATE } from './modem/config.js';
import { MAX_BYTES, byteLength, encodeFrame } from './modem/codec.js';
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

let ctx = null;
let demod = null;
let mic = null;
let sending = false;
let receiving = false;
let messages = [];

// --- message log -----------------------------------------------------------

function loadMessages() {
  try {
    messages = JSON.parse(localStorage.getItem(STORE_KEY)) || [];
  } catch {
    messages = [];
  }
  messages.forEach(render);
}

function saveMessages() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(messages.slice(-STORE_LIMIT)));
  } catch {
    // Storage is a convenience; the app works without it.
  }
}

function render(message) {
  $('empty').hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${message.dir}`;
  el.textContent = message.text;
  const time = document.createElement('time');
  time.dateTime = new Date(message.at).toISOString();
  time.textContent = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.append(time);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function addMessage(dir, body) {
  const message = { dir, text: body, at: Date.now() };
  if (dir !== 'bad') {
    messages.push(message);
    saveMessages();
  }
  return render(message);
}

// --- status ----------------------------------------------------------------

function showNotice(message) {
  $('notice').textContent = message || '';
  $('notice').hidden = !message;
}

function updateStatus() {
  const [state, label] = sending ? ['sending', 'Sending…']
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

function receiver(sampleRate) {
  demod ??= new Demodulator(sampleRate, {
    onLevel: setLevel,
    onSync() {
      receiving = true;
      updateStatus();
    },
    onFrame(body) {
      receiving = false;
      updateStatus();
      if (body === null) addMessage('bad', 'A message arrived but was too garbled to read.');
      else addMessage('in', body);
    },
  });
  return demod;
}

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    throw new Error('This browser cannot capture microphone audio for decoding.');
  }
  const audio = await audioContext();
  // Voice processing filters out exactly the frequencies we need.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  await audio.audioWorklet.addModule('modem/rx-worklet.js');
  const rx = receiver(audio.sampleRate);
  rx.reset();
  const source = audio.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(audio, 'rx-tap', { channelCount: 1, channelCountMode: 'explicit' });
  // Half-duplex: ignore the microphone while our own message is playing.
  tap.port.onmessage = (event) => { if (!sending) rx.push(event.data); };
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

async function send(body) {
  const frame = encodeFrame(body);
  const bubble = addMessage('out', body);
  bubble.classList.add('pending');
  sending = true;
  updateStatus();
  updateComposer();
  try {
    if (LOOPBACK) {
      receiver(LOOPBACK_RATE).push(modulate(frame, LOOPBACK_RATE));
    } else {
      const audio = await audioContext();
      await play(audio, modulate(frame, audio.sampleRate));
      // Let the room's echo die down before listening again.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    sending = false;
    if (!LOOPBACK) demod?.reset();
    bubble.classList.remove('pending');
    updateStatus();
    updateComposer();
  }
}

// --- composer --------------------------------------------------------------

function updateComposer() {
  const bytes = byteLength(text.value.trim());
  $('count').textContent = `${bytes}/${MAX_BYTES}`;
  $('count').classList.toggle('over', bytes > MAX_BYTES);
  sendButton.disabled = sending || !bytes || bytes > MAX_BYTES;
  text.style.height = 'auto';
  text.style.height = `${text.scrollHeight + 3}px`;
}

function describe(error) {
  if (error.name === 'NotAllowedError') return 'Microphone access was blocked. Allow it in the browser’s site settings to receive messages.';
  if (error.name === 'NotFoundError') return 'No microphone was found on this device.';
  return error.message || String(error);
}

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = text.value.trim();
  if (sendButton.disabled) return;
  text.value = '';
  showNotice('');
  try {
    await send(body);
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
