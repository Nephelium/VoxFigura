class VowelMicrophone extends AudioWorkletProcessor {
  constructor({ processorOptions: { maxSamples } }) {
    super();
    this.samples = new Float32Array(maxSamples);
    this.length = 0;
    this.finished = false;
    this.port.onmessage = () => this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    const samples = this.samples.slice(0, this.length);
    this.port.postMessage(samples, [samples.buffer]);
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && !this.finished) {
      const count = Math.min(channel.length, this.samples.length - this.length);
      this.samples.set(channel.subarray(0, count), this.length);
      this.length += count;
      if (this.length === this.samples.length) this.finish();
    }
    return !this.finished;
  }
}

registerProcessor('vowel-microphone', VowelMicrophone);
