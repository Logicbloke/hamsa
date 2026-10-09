// Batches microphone samples and hands them to the main thread, where the
// demodulator runs.
class RxTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      let offset = 0;
      while (offset < input.length) {
        const n = Math.min(input.length - offset, this.block.length - this.fill);
        this.block.set(input.subarray(offset, offset + n), this.fill);
        this.fill += n;
        offset += n;
        if (this.fill === this.block.length) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(2048);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('rx-tap', RxTap);
