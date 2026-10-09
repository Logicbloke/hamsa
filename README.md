# Hamsa

Send and receive short text messages between nearby devices over ultrasound,
using only the speaker and microphone. Hamsa (همسة) is Arabic for "whisper".

**Live app: https://logicbloke.github.io/hamsa/**

- Runs entirely in the browser; there is no server and nothing is uploaded.
- Installable PWA that works fully offline after the first visit.
- No dependencies and no build step.

## Using it

1. Open the app on two devices and put them close together.
2. On the receiver, tap **Start listening** and allow the microphone.
3. On the sender, turn the volume up, type a message (up to 120 bytes) and send.

A message takes roughly 2 s plus 0.1 s per character. Only one device can
talk at a time; a device ignores its microphone while it is sending.

### Delivery receipts

The receiver answers every message with a short acknowledgement, or with a
request to repeat it if it arrived garbled. Sending turns the sender's
microphone on so it can hear that answer: it shows **Delivered ✓**, resends up
to twice when no acknowledgement comes back, and otherwise marks the message
**Not delivered**. If the microphone is unavailable the message is still sent
and shows **Sent, no receipt**.

Tick **Broadcast (no receipt)** to send to several devices at once. Receivers
show the message but stay silent, since their replies would collide, so the
sender gets no confirmation and does not resend.

Receiving phones vibrate on a new message where the browser supports it
(Android; iOS browsers do not expose vibration).

### If nothing arrives

- Watch the signal meter on the receiver while the other device sends. If it
  does not move, the speaker or microphone cannot handle 18-20 kHz; many
  Bluetooth speakers and headsets cannot.
- Raise the sender's volume and move the devices closer.
- On iOS, if the microphone prompt never appears, enable Microphone for the
  browser in the iOS Settings app and reload.

## How it works

| Layer | Details |
| --- | --- |
| Band | 32 tones, 18.000-20.325 kHz, 75 Hz apart |
| Modulation | 16-FSK, 40 ms symbols (4 bits each), raised-cosine edges |
| Echo rejection | even and odd symbols use two interleaved 16-tone sets |
| Framing | 8-symbol preamble, header (length, broadcast flag, message id), UTF-8 payload, CRC-16 |
| Receipts | header-only ACK / NACK frames carrying the message id |
| Error correction | Reed-Solomon over GF(256), about one bad byte in eight |
| Receiver | Goertzel filter bank, preamble search at quarter-symbol hops |

All air-interface constants live in `modem/config.js`. The modulator and
demodulator are plain JavaScript with no Web Audio dependency, so the same
code runs in the browser and in the Node tests.

## Development

```sh
npm test        # modem tests: FEC, framing, loopback with noise and echo
npm run serve   # static server on http://localhost:8080
npm run icons   # regenerate the PNG icons
```

Opening the app with `?loopback` feeds every sent message straight into the
receiver, which tests the whole pipeline without a speaker or microphone.

The microphone needs a secure context: `https://` or `localhost`.

When you change any shipped file, bump `CACHE` in `sw.js` so installed copies
update.

## License

MIT
