# Hamsa

Send and receive short text messages between nearby devices over ultrasound,
using only the speaker and microphone. Hamsa (همسة) is Arabic for "whisper".

**Live app: https://logicbloke.github.io/hamsa/**

- Runs entirely in the browser; there is no server and nothing is uploaded.
- Installable PWA that works fully offline after the first visit.
- No dependencies and no build step.

## Using it

1. Open the app on two devices, put them close together and enter a name on
   each. The name (up to 16 bytes) is sent with every message.
2. On the receiver, tap **Start listening** and allow the microphone.
3. On the sender, turn the volume up, type a message and send. Name and
   message share 119 bytes.

A message takes roughly 2 s plus 0.1 s per character, name included. Only one
device can talk at a time.

### Delivery receipts

The receiver answers every message with a short acknowledgement, or with a
request to repeat it if it arrived garbled. Sending turns the sender's
microphone on so it can hear that answer: it shows **Delivered ✓**, resends up
to twice when no acknowledgement comes back, and otherwise marks the message
**Not delivered**. If the microphone is unavailable the message is still sent
and shows **Sent, no receipt**.

### Distance

A delivered message also shows how far away the other device is, for example
**Delivered ✓ · 12 cm away**. Each device times both its own sound and the
other's on its own microphone, so speaker and microphone latency cancel out;
the receiver sends its half of the timing in a short extra frame about a
second after the receipt. If that frame is lost, or a device cannot hear its
own speaker, the message just stays **Delivered ✓**.

- The figure is speaker-to-microphone, so two phones lying side by side may
  read 5-15 cm. Expect a few centimetres of error, more with strong echoes or
  when a device is moving.
- The two devices' clocks drift apart by roughly 1 cm per second of message.
- `SELF_PATH` in `modem/ranging.js` is the assumed distance between a device's
  own speaker and microphone; tune it if readings are consistently off.

### Who is nearby, and group mode

A device says hello when it starts listening, and the others answer, so
everyone sees a line such as "Taha is on the frequency" and a **Nearby** list
of the devices heard in the last five minutes. Devices are also noticed from
any message or receipt they send.

With two or more other devices nearby, receipts would collide, so the app
switches to group mode on its own: messages go out as broadcasts, receivers
show them but stay silent, and the sender gets no confirmation or distance. A
device in group mode that hears an ordinary message answers with "here"
instead of a receipt, which moves the sender into group mode too.

Tick **Broadcast (no receipt)** to send that way regardless of who is nearby.

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
| Framing | 8-symbol preamble, header (length, broadcast flag, message id, device id), UTF-8 name and text, CRC-16 |
| Receipts | header-only ACK / NACK frames carrying the message id |
| Presence | hello / here frames carrying the device id and name |
| Ranging | arrival timed by correlating against the preamble; header-only frame with the receiver's turnaround in microseconds |
| Error correction | Reed-Solomon over GF(256), about one bad byte in eight |
| Receiver | Goertzel filter bank, preamble search at quarter-symbol hops |

All air-interface constants live in `modem/config.js`. The modulator and
demodulator are plain JavaScript with no Web Audio dependency, so the same
code runs in the browser and in the Node tests.

## Development

```sh
npm test        # modem tests: FEC, framing, loopback with noise and echo, ranging
npm run serve   # static server on http://localhost:8080
npm run icons   # regenerate the PNG icons
```

Opening the app with `?loopback` feeds every sent message straight into the
receiver, which tests the whole pipeline without a speaker or microphone
(there is no distance in this mode).

The microphone needs a secure context: `https://` or `localhost`.

When you change any shipped file, bump `CACHE` in `sw.js` so installed copies
update.

## License

MIT
