export type AudioCapture = {
  stop: () => void;
};

function floatTo16BitPcm(float32: Float32Array) {
  const output = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const next = input[index + 1] ?? input[index] ?? 0;
    output[i] = (input[index] ?? 0) * (1 - fraction) + next * fraction;
  }
  return output;
}

function int16ToBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToInt16(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

export async function createAudioCapture(onChunk: (base64Pcm: string) => void): Promise<AudioCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resampleLinear(input, context.sampleRate, 24000);
    const pcm = floatTo16BitPcm(resampled);
    onChunk(int16ToBase64(pcm));
  };

  source.connect(processor);
  processor.connect(context.destination);

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}

export class PcmPlayer {
  private context: AudioContext;
  private nextTime = 0;
  private sources = new Set<ReturnType<AudioContext["createBufferSource"]>>();

  constructor() {
    this.context = new AudioContext({ sampleRate: 24000 });
  }

  enqueue(base64Pcm: string) {
    if (!base64Pcm) return;
    if (this.context.state === "suspended") void this.context.resume();
    const pcm = base64ToInt16(base64Pcm);
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      floats[i] = pcm[i] / 0x8000;
    }

    const buffer = this.context.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
    };
    const startAt = Math.max(this.context.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }

  reset() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Source may already have stopped between scheduling and reset.
      }
    }
    this.sources.clear();
    this.nextTime = this.context.currentTime;
  }

  close() {
    this.reset();
    void this.context.close();
  }
}
