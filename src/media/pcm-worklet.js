class NearLinkPCM extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(8192);
    this.right = new Float32Array(8192);
    this.write = 0;
    this.read = 0;
    this.count = 0;
    this.port.onmessage = (event) => {
      const { samples, channels } = event.data;
      const frames = samples.length / channels;
      for (let i = 0; i < frames; i++) {
        if (this.count >= 4096) {
          this.read = (this.read + 1) % 8192;
          this.count--;
        }
        this.left[this.write] = samples[i * channels];
        this.right[this.write] = samples[i * channels + (channels > 1 ? 1 : 0)];
        this.write = (this.write + 1) % 8192;
        this.count++;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    for (let i = 0; i < out[0].length; i++) {
      if (this.count) {
        out[0][i] = this.left[this.read];
        if (out[1]) out[1][i] = this.right[this.read];
        this.read = (this.read + 1) % 8192;
        this.count--;
      } else {
        out[0][i] = 0;
        if (out[1]) out[1][i] = 0;
      }
    }
    return true;
  }
}
registerProcessor("nearlink-pcm", NearLinkPCM);
