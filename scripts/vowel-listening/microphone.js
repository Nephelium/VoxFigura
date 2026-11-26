const MAX_SECONDS = 30;
const MIN_SECONDS = .08;

function encodeWav(samples, rate) {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode('RIFF'), 0);
  bytes.set(encoder.encode('WAVEfmt '), 8);
  bytes.set(encoder.encode('data'), 36);
  view.setUint32(4, dataSize + 36, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

export async function startMicrophone(onComplete) {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    throw new Error('当前浏览器无法访问麦克风。可在 Chrome 或 Edge 打开这个本机地址。');
  }
  const audio = new AudioContext({ sampleRate: 48000 });
  let stream;
  let node;
  let cutoff;
  let stopTimeout;
  let closed = false;

  function release() {
    if (closed) return;
    closed = true;
    clearTimeout(cutoff);
    clearTimeout(stopTimeout);
    window.removeEventListener('pagehide', abandon);
    node?.disconnect();
    node?.port.close();
    stream?.getTracks().forEach(track => track.stop());
    void audio.close().catch(() => {});
  }

  function complete(samples, error) {
    if (closed) return;
    release();
    if (samples?.length >= MIN_SECONDS * audio.sampleRate) {
      onComplete(encodeWav(samples, audio.sampleRate), '');
    } else {
      onComplete(null, error ?? '录音太短，请重新录一条。');
    }
  }

  function abandon() {
    complete(null, '录音已停止。');
  }

  function stop() {
    if (closed || stopTimeout) return;
    stopTimeout = setTimeout(() => complete(null, '录音中断，请重新录一条。'), 2000);
    node.port.postMessage('stop');
  }

  window.addEventListener('pagehide', abandon);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: { ideal: 1 }, noiseSuppression: false, echoCancellation: false, autoGainControl: false },
    });
    if (closed) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('录音已停止。');
    }
    await audio.audioWorklet.addModule('/microphone-worklet.js');
    if (closed) throw new Error('录音已停止。');
    node = new AudioWorkletNode(audio, 'vowel-microphone', {
      channelCount: 1, channelCountMode: 'explicit',
      processorOptions: { maxSamples: Math.floor(audio.sampleRate * MAX_SECONDS) },
    });
    node.port.onmessage = ({ data }) => complete(data);
    node.addEventListener('processorerror', () => complete(null, '录音中断，请重新录一条。'), { once: true });
    audio.createMediaStreamSource(stream).connect(node).connect(audio.destination);
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', stop, { once: true }));
    await audio.resume();
    if (!closed) cutoff = setTimeout(stop, (MAX_SECONDS + 1) * 1000);
    return { stop };
  } catch (error) {
    release();
    throw error;
  }
}
