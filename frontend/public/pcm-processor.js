// pcm-processor.js
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const channelData = input[0]; // assume mono
      // Post Float32Array to main thread
      this.port.postMessage(channelData);
    }
    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PCMProcessor);
