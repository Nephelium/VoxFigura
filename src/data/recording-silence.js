/**
 * Detect quiet runs of at least 30 ms in a recording. Times use the playback clock.
 * @param {ArrayBuffer} bytes
 */
export async function measureRecordingSilence(bytes) {
  const context = new OfflineAudioContext(1, 1, 48000);
  const buffer = await context.decodeAudioData(bytes);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const hop = Math.round(buffer.sampleRate * .01);
  const levels = [];
  for (let start = 0; start < buffer.length; start += hop) {
    const end = Math.min(start + hop, buffer.length);
    let energy = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) energy += channel[i] ** 2;
    }
    levels.push(Math.sqrt(energy / ((end - start) * channels.length)));
  }
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * .12)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const threshold = Math.max(.0001, peak * .022, Math.min(peak * .16, floor * 2.8 + .0001));
  const intervals = [];
  let start = -1;
  for (let i = 0; i <= levels.length; i++) {
    if (i < levels.length && levels[i] < threshold) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const start_s = start * hop / buffer.sampleRate;
      const end_s = Math.min(i * hop, buffer.length) / buffer.sampleRate;
      if (end_s - start_s >= .03 - 1e-9) intervals.push({ start_s, end_s });
      start = -1;
    }
  }
  return { duration_s: buffer.duration, intervals };
}
