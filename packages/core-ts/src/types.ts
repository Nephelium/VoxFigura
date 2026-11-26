/**
 * VoxFigura Core Schema v1 & Unit/Validation Types
 *
 * All timeline positions use 48 kHz integer samples (`_smp`) and half-open
 * intervals `[start_smp, end_smp)`. Pressures in TS/Frontend/Adapters are
 * strictly in Pascals (`_pa`, 0..1600 Pa). Out-of-range parameters must be
 * rejected via `outOfRange()` and never silently clamped.
 */

export const SAMPLE_RATE_HZ = 48000 as const;
export const DEFAULT_FPS = 60 as const;
export const SAMPLES_PER_FRAME_60FPS = 800 as const; // 48000 / 60 = 800 exact
export const F0_LIMIT_HZ = { min: 60, max: 600 } as const;
export const PRESSURE_LIMIT_PA = { min: 0, max: 1600 } as const;
export const MAX_SEQUENCE_SECONDS = 60 as const;

export type ComputeDevice = 'webgpu-high' | 'webgpu-low' | 'cuda' | 'wasm-cpu';

export interface RangeBound {
  min: number;
  max: number;
  unit?: string;
}

export type CoreErrorCode =
  | 'out_of_range'
  | 'validation_error'
  | 'conflict'
  | 'not_found'
  | 'rigid_floor'
  | 'missing_glyph'
  | 'unauthorized'
  | 'unsupported_geometry'
  | 'device_unavailable'
  | 'payload_too_large'
  | 'model_unavailable';

export interface CoreErrorDetail {
  code: CoreErrorCode;
  field?: string;
  value?: unknown;
  allowed?: RangeBound | string[];
  hint: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CoreErrorDetail };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(error: CoreErrorDetail): { ok: false; error: CoreErrorDetail } {
  return { ok: false, error };
}

export function outOfRange(
  field: string,
  value: number,
  min: number,
  max: number,
  unit: string,
  hint?: string,
): { ok: false; error: CoreErrorDetail } {
  return {
    ok: false,
    error: {
      code: 'out_of_range',
      field,
      value,
      allowed: { min, max, unit },
      hint: hint ?? `${field} (${value} ${unit}) 超出合法范围 [${min}, ${max}] ${unit}`,
    },
  };
}

export function assertInRange(
  field: string,
  value: number,
  min: number,
  max: number,
  unit: string,
  hint?: string,
): Result<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return outOfRange(field, value, min, max, unit, hint);
  }
  return ok(value);
}

export function msToSamples(ms: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return Math.round((ms / 1000) * sampleRateHz);
}

export function samplesToMs(smp: number, sampleRateHz: number = SAMPLE_RATE_HZ): number {
  return (smp / sampleRateHz) * 1000;
}

export function hzToSt(hz: number, refHz: number): number {
  return 12 * Math.log2(hz / refHz);
}

export function stToHz(st: number, refHz: number): number {
  return refHz * Math.pow(2, st / 12);
}

export interface SampleInterval {
  start_smp: number;
  end_smp: number;
}

export type TractParamName =
  | 'HX' | 'HY' | 'JX' | 'JA' | 'LP' | 'LD' | 'VS' | 'VO'
  | 'TCX' | 'TCY' | 'TTX' | 'TTY' | 'TBX' | 'TBY' | 'TRX' | 'TRY'
  | 'TS1' | 'TS2' | 'TS3';

export type Tract17ParamName = Exclude<TractParamName, 'TRX' | 'TRY'>;

export type TractDelta = Partial<Record<TractParamName, number>>;

export type OrganScope =
  | 'lips'
  | 'jaw'
  | 'tongue_tip'
  | 'tongue_blade'
  | 'tongue_body'
  | 'tongue_root'
  | 'velum'
  | 'hyoid'
  | 'larynx'
  | 'glottis';

export type PhonationRegime =
  | 'pressed'
  | 'modal'
  | 'breathy'
  | 'whisper'
  | 'creaky'
  | 'falsetto';

export interface GlottisM27Params {
  f0_hz: number;       // F0 bias / nominal Hz (40..600 in M27, 60..600 for voiced control)
  pr_pa: number;       // Subglottal pressure in Pa (0..1600 Pa; engine converts dPa = pa * 10)
  xb_cm: number;       // Lower vocal fold displacement x_bottom (-0.05..0.30 cm)
  xt_cm: number;       // Upper vocal fold displacement x_top (-0.05..0.30 cm)
  ca_cm2: number;      // Posterior chink area (-0.25..0.25 cm^2)
  lag_rad: number;     // Phase lag (0..3.1415 rad)
  ra: number;          // Relative amplitude (-1..1)
  ps: number;          // Pulse shape (-1..1)
  fl: number;          // Flutter (0..100)
  shim: number;        // Shimmer (0..100)
}

export interface PhonationAnchor {
  id: string;
  t_smp: number;
  regime: PhonationRegime;
  blend: number; // 0..1 strength
  syllable_id?: string;
  glottis?: GlottisM27Params;
  voqs?: { symbol: string; source_id: string; t_s: number };
  larynx_height_cm?: number;
}

export type TargetSource = 'user' | 'transfer' | 'score' | 'default';

export interface QtaTargetCandidate {
  m_st_per_s: number;
  b_end_st: number;
  lambda_per_s: number;
  source: TargetSource;
  rule?: string;
}

export interface QtaTargetSpan {
  id: string;
  span_id: string; // e.g., syllable id or "note:0"
  start_smp: number;
  end_smp: number;
  voiced?: boolean;
  is_rest_after?: boolean;
  pre_glide_ms?: number;
  candidates: Partial<Record<TargetSource, QtaTargetCandidate>>;
}

export interface F0ResidualPoint {
  u: number;   // 0..1 normalized position within span
  st: number;  // semitone offset
}

export interface F0ResidualSegment {
  id: string;
  span_id: string;
  points: F0ResidualPoint[];
  feather_ms: number; // default 30 ms raised cosine
}

export interface F0PinPoint {
  t_smp: number;
  f0_hz: number;
}

export interface F0PinSegment {
  id: string;
  start_smp: number;
  end_smp: number;
  points: F0PinPoint[];
  transition_ms: number; // entry crossfade 20..40 ms (default 30 ms)
  exit_fit_ms: number;   // exit quadratic fit 30..40 ms (default 35 ms)
  snap_entry?: boolean;
}

export interface VibratoConfig {
  enabled: boolean;
  rate_hz: number;     // e.g. 5.5
  depth_cents: number; // e.g. 25
  delay_ms: number;    // e.g. 200
  fade_in_ms: number;  // e.g. 120
  fade_out_ms: number; // e.g. 90
  min_hold_ms: number; // e.g. 400
}

export interface PerturbationConfig {
  flutter: number;
  shimmer: number;
  seed: number;
}

export interface StopTiming {
  closure_ms: number;    // >= 10 ms rigid floor
  release_ms: number;    // >= 1 ms rigid floor
  aspiration_ms: number; // >= 0 ms
  vot_ms: number;        // relative to release onset; [-closure_ms, release_ms + aspiration_ms]
  locked?: boolean;
  auto_generated?: boolean;
}

export interface SegmentAnchor {
  id: string;
  ipa: string;
  start_smp: number;
  end_smp: number;
  role: 'onset' | 'nucleus' | 'coda' | 'aspiration' | 'rest';
  elastic: boolean;
  voiced: boolean;
  params?: number[]; // 19-dim VTL tract params
  lip_width?: number;
  larynx_height_cm?: number;
  manual_root?: boolean;
  tongue_shape?: number[];
  lip_shape?: number[];
  stop_timing?: StopTiming;
  stress?: number;
}

export interface PressurePoint {
  u: number; // 0..1 within syllable or clip
  pressure_pa: number;
}

export interface GlottisMixSpan {
  u0: number;
  u1: number;
  preset: PhonationRegime;
  blend: number;
}

export interface PoseOverride {
  seg_index: number;
  seg_id?: string;
  delta: TractDelta;
  scope?: OrganScope[];
}

export interface SyllableOverrides {
  poses: PoseOverride[];
  f0_resid: F0ResidualSegment[];
  pressure: PressurePoint[];
  glottis: GlottisMixSpan[];
  vibrato?: Partial<VibratoConfig>;
  perturbation?: Partial<PerturbationConfig>;
}

export interface SyllableAnchor {
  tick?: number;
  beat?: number;
  policy: 'nucleus_on_beat' | 'speech_timing';
  lead_ms: number | null;
  bias_ms: number;
}

export interface Syllable {
  id: string;
  text: string;
  ipa: string[];
  nucleus_index: number;
  start_smp: number;
  end_smp: number;
  tone_levels?: string; // e.g. "55", "35", "21", "214", "51"
  tone_id?: string;
  checked?: boolean;
  coda_release?: 'unreleased' | 'glottal' | 'released';
  reading_candidates?: string[];
  anchor: SyllableAnchor;
  segments: SegmentAnchor[];
  targets: QtaTargetSpan[];
  overrides: SyllableOverrides;
}

export type ClipKind = 'phrase' | 'audio' | 'video' | 'subtitle';

export interface ClipSourceMeta {
  lyrics?: string;
  score?: string;
  score_tonic?: import('./scheduler').SongTonic;
  score_bpm?: number;
  reading_standard?: string;
  lang?: 'cmn' | 'en' | 'ja' | 'ipa' | 'mixed';
  transcription?: string;
}

export type AnnotationControls = Pick<VcProject, 'phonation_anchor_order' | 'phonation_anchors' | 'f0_pins' | 'vibrato' | 'perturbation'>;

export interface Clip {
  annotation_controls?: AnnotationControls;
  id: string;
  kind: ClipKind;
  voice_id?: string;
  asset_id?: string;
  start_smp: number;
  end_smp: number;
  variants?: Array<'synth' | 'inversion' | 'original'>;
  active_variant?: 'synth' | 'inversion' | 'original';
  source?: ClipSourceMeta;
  syllable_order: string[];
  syllables: Record<string, Syllable>;
  orphan_overrides?: Array<{ syllable_id: string; overrides: SyllableOverrides }>;
}

export interface TempoEvent {
  tick: number;
  bpm: number;
}

export interface VoiceConfig {
  id: string;
  speaker: 'JD2' | 'W02' | 'M01' | 'JD2-2D' | 'W02-2D';
  dimension: '2d' | '3d';
  geometry: 'm10/r21';
  sections: 33 | 65 | 129 | 257;
  preset_pack: { id: string; sha256: string };
  f0_ref_hz: number;
  range_st: [number, number];
  seed: number;
}

export interface AssetRef {
  id: string;
  kind: 'audio' | 'textgrid' | 'image' | 'video' | 'font' | 'score' | 'spritesheet';
  sha256: string;
  path: string;
  role?: string;
  duration_smp?: number;
  width_px?: number;
  height_px?: number;
}

export type TrackKind =
  | 'textgrid'
  | 'articulation'
  | 'phonation'
  | 'f0'
  | 'pressure'
  | 'audio'
  | 'visual'
  | 'subtitle';

export interface Track {
  id: string;
  kind: TrackKind;
  voice_id?: string;
  tiers?: Array<'syllable' | 'phone' | 'note'>;
  clip_order?: string[];
  layer_order?: string[];
  source_track_id?: string;
  style_id?: string;
  gain_db?: number;
  height_px?: number;
  expanded?: boolean;
}

export interface VisualLayerKeyframe {
  t_smp?: number;
  at?: { bar: number; beat: number } | { bind: 'beat' };
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation_deg?: number;
  pulse?: number;
  decay_ms?: number;
  frame?: string;
}

export interface VisualLayer {
  id: string;
  kind: 'background' | 'sprite' | 'tract' | 'spectrum' | 'particles' | 'subtitle';
  z_index: number;
  asset_id?: string;
  visible: boolean;
  switches?: Array<{ at: { bar: number; beat: number }; frame: string }>;
  keys?: Record<string, VisualLayerKeyframe[]>;
  style?: SubtitleStyleConfig;
  tract_render_style?: TractRenderStyle;
}

export type TractRenderStyle = 'natural' | 'ink' | 'oil' | 'watercolor' | 'pastel' | 'sketch';
export interface SubtitleJitterConfig { enabled: boolean; min_pct: number; max_pct: number; seed: number }

export interface SubtitleStyleConfig {
  font_family: string;
  font_size_px: number;
  tilt_deg: number;
  reveal_mode: 'line' | 'word' | 'char_by_char' | 'single_char';
  text_color: string;
  highlight_color: string;
  show_ipa: boolean;
  show_translation: boolean;
  safe_margin_px: [number, number];
  size_jitter?: SubtitleJitterConfig;
}

export interface ProjectSettings {
  sample_rate_hz: number; // 48000
  fps: number;            // 60
  size_px: [number, number];
  tempo_map: TempoEvent[];
  ppq: number;            // 480
  time_signature: [number, number];
  default_lead_policy: 'nucleus_on_beat' | 'onset_on_beat';
  compute_device: ComputeDevice;
}

export interface RenderConfig {
  container: 'mp4' | 'webm';
  video: 'h264' | 'vp8' | 'vp9';
  audio: 'aac' | 'opus' | 'pcm';
  safe_margin_px: [number, number];
  max_width_px: number;  // <= 1920
  max_height_px: number; // <= 1080
}

export interface VcProject {
  /** Versioned arranger editor documents, keyed by source clip ID. */
  arrangements?: Record<string, { version: 2; state: Record<string, unknown> }>;
  schema: 'vocalcut/project';
  schema_version: 1;
  revision: number;
  id: string;
  name: string;
  settings: ProjectSettings;
  voice_order: string[];
  voices: Record<string, VoiceConfig>;
  asset_order: string[];
  assets: Record<string, AssetRef>;
  track_order: string[];
  tracks: Record<string, Track>;
  clip_order: string[];
  clips: Record<string, Clip>;
  layer_order: string[];
  layers: Record<string, VisualLayer>;
  phonation_anchor_order: string[];
  phonation_anchors: Record<string, PhonationAnchor>;
  f0_pins?: F0PinSegment[];
  vibrato?: VibratoConfig;
  perturbation?: PerturbationConfig;
  render: RenderConfig;
}
