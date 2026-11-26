import { softLimitVoiceSample } from '@/data/voice-playback-gain';

const LEVEL_BLOCK_SEC = 0.04;
const HISTORY_BLOCKS = 500; // 20 seconds of synthesized audio, including pauses.
const MIN_ACTIVE_BLOCKS = 20; // Accumulate 800 ms of active output before adapting.
const MIN_ACTIVE_POWER = 0.001 ** 2;
const TARGET_RMS_DBFS = -20;
const INITIAL_GAIN_DB = 6;
const MAX_GAIN_DB = 24;
const GAIN_RISE_DB_PER_SEC = 6;
const GAIN_FALL_DB_PER_SEC = 18;
const RECENT_LEVEL_DECAY = Math.exp(-LEVEL_BLOCK_SEC / 2);
const RECENT_HEADROOM_DB = 4;

/** Causal makeup gain for the decoded Tract2Vox-Lite stream. */
export class M27RealtimeGain {
  private readonly historyDb = new Float64Array(HISTORY_BLOCKS);
  private historyIndex = 0;
  private activeBlocks = 0;
  private sumLevelDb = 0;
  private recentLevelDb = NaN;
  private sampleRate = 0;
  private blockSamples = 0;
  private blockEnergy = 0;
  private gainDb = INITIAL_GAIN_DB;
  private gain = 10 ** (INITIAL_GAIN_DB / 20);
  private gainStep = 0;

  constructor() {
    this.historyDb.fill(NaN);
  }

  reset(): void {
    this.historyDb.fill(NaN);
    this.historyIndex = 0;
    this.activeBlocks = 0;
    this.sumLevelDb = 0;
    this.recentLevelDb = NaN;
    this.sampleRate = 0;
    this.blockSamples = 0;
    this.blockEnergy = 0;
    this.gainDb = INITIAL_GAIN_DB;
    this.gain = 10 ** (INITIAL_GAIN_DB / 20);
    this.gainStep = 0;
  }

  process(samples: Float32Array, sampleRate: number, overlapSamples: number, silent: boolean): void {
    if (this.sampleRate !== sampleRate) {
      this.reset();
      this.sampleRate = sampleRate;
    }
    const blockSize = Math.max(1, Math.round(sampleRate * LEVEL_BLOCK_SEC));

    // The left overlap repeats audio time from the previous RPC. Use the current
    // gain for the crossfade, and advance the estimator only on new samples.
    for (let i = 0; i < overlapSamples; i++) {
      samples[i] = softLimitVoiceSample(samples[i] * this.gain);
    }
    for (let i = overlapSamples; i < samples.length; i++) {
      const sample = samples[i];
      samples[i] = softLimitVoiceSample(sample * this.gain);
      this.gain += this.gainStep;
      this.blockEnergy += silent ? 0 : sample * sample;
      if (++this.blockSamples === blockSize) {
        this.finishBlock(blockSize);
      }
    }
  }

  private finishBlock(blockSize: number): void {
    const power = this.blockEnergy / blockSize;
    const levelDb = power >= MIN_ACTIVE_POWER ? 10 * Math.log10(power) : NaN;
    this.blockSamples = 0;
    this.blockEnergy = 0;

    const expiredDb = this.historyDb[this.historyIndex];
    if (!Number.isNaN(expiredDb)) {
      this.sumLevelDb -= expiredDb;
      this.activeBlocks--;
    }
    this.historyDb[this.historyIndex] = levelDb;
    this.historyIndex = (this.historyIndex + 1) % HISTORY_BLOCKS;
    const hasSignal = !Number.isNaN(levelDb);
    if (hasSignal) {
      this.sumLevelDb += levelDb;
      this.activeBlocks++;
      this.recentLevelDb = Number.isNaN(this.recentLevelDb)
        ? levelDb
        : levelDb + RECENT_LEVEL_DECAY * (this.recentLevelDb - levelDb);
    }

    let targetGainDb = this.gainDb;
    if (this.activeBlocks === 0) {
      this.recentLevelDb = NaN;
      this.sumLevelDb = 0;
      targetGainDb = INITIAL_GAIN_DB;
    } else if (hasSignal && this.activeBlocks >= MIN_ACTIVE_BLOCKS) {
      const longTermDb = this.sumLevelDb / this.activeBlocks;
      // Recent speech can lower the long-term gain after a sustained level increase.
      const referenceDb = Math.max(longTermDb, this.recentLevelDb - RECENT_HEADROOM_DB);
      targetGainDb = Math.max(0, Math.min(MAX_GAIN_DB, TARGET_RMS_DBFS - referenceDb));
    }

    const changeDb = Math.max(
      -GAIN_FALL_DB_PER_SEC * LEVEL_BLOCK_SEC,
      Math.min(GAIN_RISE_DB_PER_SEC * LEVEL_BLOCK_SEC, targetGainDb - this.gainDb),
    );
    this.gain = 10 ** (this.gainDb / 20);
    this.gainDb += changeDb;
    this.gainStep = (10 ** (this.gainDb / 20) - this.gain) / blockSize;
  }
}
