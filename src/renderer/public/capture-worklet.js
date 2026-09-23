// Runs on the audio thread. Collects 16 kHz mono samples into 512-sample frames (32 ms),
// the frame size Silero VAD expects, and hands them to the page.
class AidaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(512);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.frame[this.filled++] = channel[i];
        if (this.filled === this.frame.length) {
          this.port.postMessage(this.frame.slice());
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('aida-capture', AidaCapture);
