<script lang="ts">
interface RecordedTake { original:File; clean:boolean; text:string; url:string;pts:{u:number,hz:number}[];pack:string; toneId?:string }
const sessionTakes:RecordedTake[]=[];
</script>
<script setup lang="ts">
import '@/styles/acoustic-charts.css';
import { computed, nextTick, onBeforeUnmount, ref, watch, watchEffect } from 'vue';
import { publishPanelSnapshot } from '@/data/panel-snapshots';
import {
  applyDialectSandhi,
  isValidF0Hz,
  type SandhiSyllableOutput,
} from '@vocalcut/core';
import { denoiseFile } from "@/data/denoise";
import { normalizeAudioFile } from '@/data/voice-renderer';
import {
  estimateSpeakerPitchRangeFromCurves,
  fitChaoFromPitchCurve,
  isValidSpeakerPitchRange,
  swiftPitchRecording,
  type SpeakerPitchRange,
} from '@/data/dialect-exchange';
import { RECORDED_IPA_SET_ID, ipaPoseSets } from '@/data/ipa-pose-sets';
import { DIALECT_PACKS, type DialectSandhiRule, type DialectTone } from '@/data/dialect-packs';
import { coreDialect, toneDigits, type SavedDialect } from '@/data/dialect-user-library';
import { dialectDraftKey, readDialectDraft, validatedDialectPitchRange } from '@/data/pronunciation-dictionaries';
import { useWorkbenchStore } from '@/stores/workbench';
import type { SelectOption } from '@/components/common/CustomSelect.vue';
import CustomSelect from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';

const store = useWorkbenchStore();

const props = defineProps<{ profile: SavedDialect; editable: boolean; ruleHost: HTMLElement | null }>();
const emit = defineEmits<{ save: [profile: SavedDialect, section: 'tone' | 'sandhi' | 'all']; copy: [] }>();
const dialectKey = computed(() => props.profile.id);
const allowRules = computed(() => props.profile.base !== 'cmn');
const toolTab = ref<'tone' | 'record' | 'guide'>('tone');

const editableTones = ref<DialectTone[]>([]);
const editableSandhi = ref<DialectSandhiRule[]>([]);
const ruleKeyMap = new WeakMap<DialectSandhiRule, number>();
let ruleKeySeq = 0;
function ruleRenderKey(rule: DialectSandhiRule): number {
  let key = ruleKeyMap.get(rule);
  if (key === undefined) {
    key = ++ruleKeySeq;
    ruleKeyMap.set(rule, key);
  }
  return key;
}

const selectedToneIdx = ref(0);
const newToneName = ref<string>();
const newToneInput = ref<HTMLInputElement | null>(null);
const confirmingToneDeletion = ref(false);
const toneNameDraft = ref('');

// Continuous F0 overlay points (either derived from Chao, fine-drawn, or previewing a recording)
const f0OverlayPoints = ref<Array<{ u: number; hz: number }>>([]);
const isDrawingF0 = ref(false);
const isPreviewingRecordingF0 = ref(false);
let loadingPack = false;

// Single-word recording / denoising / F0 extraction
const isRecording = ref(false);
const requestingMic = ref(false);
const recDenoise = ref(false);
const speakerPitchMinHz = ref<number | ''>('');
const speakerPitchMaxHz = ref<number | ''>('');
const speakerPitchRange = computed<SpeakerPitchRange | null>(() => {
  if (speakerPitchMinHz.value === '' || speakerPitchMaxHz.value === '') return null;
  const candidate = { minHz: Number(speakerPitchMinHz.value), maxHz: Number(speakerPitchMaxHz.value) };
  return isValidSpeakerPitchRange(candidate) ? candidate : null;
});
const speakerPitchRangeHint = computed(() => {
  if (speakerPitchMinHz.value === '' && speakerPitchMaxHz.value === '') return '';
  if (!speakerPitchRange.value) return '参考调域须为正基频 (> 0 Hz) 且跨度不少于 3 半音';
  return `当前按对数调域 ${speakerPitchRange.value.minHz}–${speakerPitchRange.value.maxHz} Hz 换算五度`;
});
const extractedF0Summary = ref('可录制单字音或载入基频；设定说话人参考调域后可换算赵氏五度');
let mediaRec: MediaRecorder | null = null;
let recordReqToken = 0;

// Live Sandhi Sandbox
const sandboxInput = ref('');
const sandboxWord = ref('');
const sandboxNotice = ref('');
const sandboxTrace = ref<SandhiSyllableOutput[]>([]);

const linkedSet = ref(RECORDED_IPA_SET_ID);
const recordText = ref('');
const recordings = ref<RecordedTake[]>(sessionTakes);
const currentPack = computed(() => ({ ...(DIALECT_PACKS[props.profile.base] ?? DIALECT_PACKS.yue), name: props.profile.name }));
const localRecordings = computed(() => recordings.value.filter(take => take.pack === dialectKey.value));
const selectedMainSyllable = computed(() => {
  const clip = store.project.value.clips[store.activeClipId.value];
  return clip?.syllables[store.selectedSyllableId.value] ?? null;
});

function showRecording(take: RecordedTake): void {
  f0OverlayPoints.value = take.pts.map(p => ({ ...p }));
  recordText.value = take.text;
  isPreviewingRecordingF0.value = take.pts.length >= 2;
  toolTab.value = 'tone';
}

function removeRecording(take: RecordedTake): void {
  const idx = recordings.value.indexOf(take);
  if (idx >= 0) {
    URL.revokeObjectURL(take.url);
    recordings.value.splice(idx, 1);
  }
}

function getDraft(): SavedDialect {
  return {
    ...props.profile,
    poseSetId: linkedSet.value,
    pitchRangeHz: speakerPitchRange.value ? [speakerPitchRange.value.minHz, speakerPitchRange.value.maxHz] : undefined,
    tones: editableTones.value,
    sandhi: editableSandhi.value,
  };
}

const savedSnapshot = computed(() => JSON.stringify({
  poseSetId: props.profile.poseSetId ?? RECORDED_IPA_SET_ID,
  pitchRangeHz: validatedDialectPitchRange(props.profile.pitchRangeHz),
  tones: props.profile.tones,
  sandhi: props.profile.sandhi,
}));
const currentSnapshot = computed(() => JSON.stringify({
  poseSetId: linkedSet.value,
  pitchRangeHz: speakerPitchRange.value ? [speakerPitchRange.value.minHz, speakerPitchRange.value.maxHz] : undefined,
  tones: editableTones.value,
  sandhi: editableSandhi.value,
}));
const hasUnsavedChanges = computed(() => props.editable && currentSnapshot.value !== savedSnapshot.value);

defineExpose({ getDraft, hasUnsavedChanges });

function toneId(tone: DialectTone, index: number): string {
  return tone.id || `T${index + 1}`;
}

async function beginAddTone() {
  if (newToneName.value === undefined) {
    let number = editableTones.value.length + 1;
    while (editableTones.value.some(tone => tone.name === `自订 ${number}`)) number++;
    newToneName.value = `自订 ${number}`;
    confirmingToneDeletion.value = false;
  }
  await nextTick();
  newToneInput.value?.focus();
  newToneInput.value?.select();
}

function addTone() {
  const name = newToneName.value?.trim();
  if (!name) return;
  if (editableTones.value.some(tone => tone.name.trim() === name)) {
    store.pushToast('已有同名调类，请换一个名称', 'warning');
    return;
  }
  const usedIds = new Set([
    ...editableTones.value.map(toneId),
    ...localRecordings.value.map(take => take.toneId),
  ]);
  let number = editableTones.value.length + 1;
  while (usedIds.has(`T${number}`)) number++;
  editableTones.value.push({ name, id: `T${number}`, chao: '33', pts: [62, 62, 62], checked: false });
  selectedToneIdx.value = editableTones.value.length - 1;
  newToneName.value = undefined;
}

function commitToneName(): void {
  const tone = activeTone.value;
  if (!tone || !props.editable) return;
  const trimmed = toneNameDraft.value.trim();
  if (!trimmed) {
    toneNameDraft.value = tone.name;
    store.pushToast('调类名称不能为空', 'warning');
    return;
  }
  if (editableTones.value.some((other, idx) => idx !== selectedToneIdx.value && other.name.trim() === trimmed)) {
    toneNameDraft.value = tone.name;
    store.pushToast('已有同名调类，请换一个名称', 'warning');
    return;
  }
  tone.name = trimmed;
}

function beginDeleteTone() {
  if (!props.editable) return;
  const tone = activeTone.value;
  if (!tone || editableTones.value.length <= 1) return;
  const id = toneId(tone, selectedToneIdx.value);
  const savedName = props.profile.tones.find((saved, index) => toneId(saved, index) === id)?.name;
  const usesTone = (value: string) => value === tone.name || value === savedName || value === id;
  const entry = props.profile.lexicon.find(row => row.tone && (usesTone(row.tone.trim())
    || row.tone.split(/[,，+\s]+/u).some(usesTone)));
  if (entry) {
    store.pushToast(`词条「${entry.text}」正在使用该调类，请先修改词条中的调类`, 'warning');
    return;
  }
  const rule = [...editableSandhi.value, ...props.profile.sandhi].find(rule => {
    const trigParts = rule.trig.split('+').map(part => part.trim());
    const outParts = rule.out.split('+').map(part => part.trim());
    const trigTones = rule.type === 'pair' ? trigParts.slice(0, 2)
      : rule.type === 'lexical' ? trigParts.slice(1, 2) : trigParts.slice(0, 1);
    return trigTones.some(usesTone) || outParts.some(usesTone);
  });
  if (rule) {
    store.pushToast(`变调规则「${rule.trig} → ${rule.out}」正在使用该调类，请先修改规则`, 'warning');
    return;
  }
  confirmingToneDeletion.value = true;
}

function deleteTone() {
  if (!props.editable || !confirmingToneDeletion.value || editableTones.value.length <= 1) return;
  const index = selectedToneIdx.value;
  // Older dictionaries derive tone IDs from their original positions.
  editableTones.value = editableTones.value.flatMap((tone, i) =>
    i === index ? [] : [tone.id ? tone : { ...tone, id: toneId(tone, i) }]);
  selectedToneIdx.value = Math.min(index, editableTones.value.length - 1);
  confirmingToneDeletion.value = false;
  runSandhiSimulation();
}

function saveOverlayToTone() {
  if (!props.editable) return;
  const tone = activeTone.value;
  if (!tone || f0OverlayPoints.value.length < 2) return;
  const points = f0OverlayPoints.value.filter(point => point.u >= 0 && point.u <= 1 && isValidF0Hz(point.hz));
  if (points.length !== f0OverlayPoints.value.length) { store.pushToast('该曲线包含无效基频（须大于 0 Hz）', 'warning'); return; }
  tone.f0 = points.map(point => ({ ...point }));
  isPreviewingRecordingF0.value = false;
  store.pushToast(`已将当前基频曲线关联至调类 ${tone.name}`, 'success');
}

function resetToneF0(): void {
  if (!props.editable) return;
  const tone = activeTone.value;
  if (!tone) return;
  delete tone.f0;
  isPreviewingRecordingF0.value = false;
  rebuildF0OverlayFromActiveTone();
}

const activeTone = computed(() => editableTones.value[selectedToneIdx.value] ?? editableTones.value[0] ?? null);

function loadDialectPack(key: string): void {
  loadingPack = true;
  try {
    const pack = props.profile;
    const draft = props.editable ? readDialectDraft(key) : {};
    linkedSet.value = draft.poseSetId ?? pack.poseSetId ?? RECORDED_IPA_SET_ID;
    editableTones.value = JSON.parse(JSON.stringify(draft.tones ?? pack.tones)) as DialectTone[];
    editableSandhi.value = JSON.parse(JSON.stringify(draft.sandhi ?? pack.sandhi)) as DialectSandhiRule[];
    const range = validatedDialectPitchRange(draft.pitchRangeHz ?? pack.pitchRangeHz);
    speakerPitchMinHz.value = range?.[0] ?? '';
    speakerPitchMaxHz.value = range?.[1] ?? '';
    selectedToneIdx.value = 0;
    toneNameDraft.value = editableTones.value[0]?.name ?? '';
    isPreviewingRecordingF0.value = false;
    rebuildF0OverlayFromActiveTone();
    sandboxInput.value = editableTones.value.slice(0, 2).map(tone => tone.chao).join(' + ');
    runSandhiSimulation();
  } finally {
    loadingPack = false;
  }
}

function chaoYToLevel(y: number): number {
  // SVG y in [22..102] maps to Chao 5..1
  const lv = 5 - ((y - 22) / 80) * 4;
  return Math.max(1, Math.min(5, Math.round(lv)));
}

function levelToY(lv: number): number {
  return 22 + ((5 - lv) / 4) * 80;
}

function chaoYToHz(y: number): number {
  const norm = Math.max(0, Math.min(1, 1 - (y - 22) / 80));
  const range = speakerPitchRange.value;
  if (range) {
    const logMin = Math.log(range.minHz);
    const logMax = Math.log(range.maxHz);
    return Math.round(Math.exp(logMin + norm * (logMax - logMin)));
  }
  return Math.round(115 + norm * 185); // 115..300 Hz default Chao register
}

const pitchBounds = computed(() => {
  const values = [
    ...(activeTone.value?.f0 ?? []).map(point => point.hz),
    ...f0OverlayPoints.value.map(point => point.hz),
  ].filter(isValidF0Hz);
  const minVal = values.length ? Math.min(70, ...values) : 70;
  const maxVal = values.length ? Math.max(420, ...values) : 420;
  return { min: Math.max(5, Math.floor(minVal / 10) * 10), max: Math.ceil(maxVal / 10) * 10 };
});

function hzToCanvasY(hz: number): number {
  const {min,max}=pitchBounds.value;
  const norm = (hz - min) / (max-min);
  return 112 - norm * 96;
}

function canvasYToHz(y: number): number {
  const norm = Math.max(0, Math.min(1, (112 - y) / 96));
  const {min,max}=pitchBounds.value;
  return Math.round(min + norm * (max-min));
}

interface ChaoPchipSegments {
  y0: number;
  y1: number;
  y2: number;
  c1y: number;
  c2y: number;
  c3y: number;
  c4y: number;
}

function clampChaoY(y: number): number {
  return Math.max(22, Math.min(102, y));
}

function computeChaoPchip(pts: number[]): ChaoPchipSegments {
  const y0 = clampChaoY(pts[0] ?? 62);
  const y1 = clampChaoY(pts[1] ?? 62);
  const y2 = clampChaoY(pts[2] ?? 62);
  const d0 = y1 - y0;
  const d1 = y2 - y1;
  // Monotone-preserving PCHIP interior slope at midpoint (zero at local extremum -> bottoms/peaks right on y1!)
  const m1 = d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
  // Shape-preserving non-overshooting endpoint slopes
  let m0 = 0.5 * (3 * d0 - m1);
  if (m0 * d0 <= 0) m0 = 0;
  else if (Math.abs(m0) > 3 * Math.abs(d0)) m0 = 3 * d0;
  let m2 = 0.5 * (3 * d1 - m1);
  if (m2 * d1 <= 0) m2 = 0;
  else if (Math.abs(m2) > 3 * Math.abs(d1)) m2 = 3 * d1;

  return {
    y0,
    y1,
    y2,
    c1y: clampChaoY(y0 + m0 / 3),
    c2y: clampChaoY(y1 - m1 / 3),
    c3y: clampChaoY(y1 + m1 / 3),
    c4y: clampChaoY(y2 - m2 / 3),
  };
}

function evalChaoPchipY(seg: ChaoPchipSegments, u: number): number {
  const clampedU = Math.max(0, Math.min(1, u));
  if (clampedU <= 0.5) {
    const t = clampedU * 2;
    const v = 1 - t;
    return v * v * v * seg.y0 + 3 * v * v * t * seg.c1y + 3 * v * t * t * seg.c2y + t * t * t * seg.y1;
  }
  const t = (clampedU - 0.5) * 2;
  const v = 1 - t;
  return v * v * v * seg.y1 + 3 * v * v * t * seg.c3y + 3 * v * t * t * seg.c4y + t * t * t * seg.y2;
}

function rebuildF0OverlayFromActiveTone(): void {
  const t = activeTone.value;
  if (!t) return;
  if (t.f0?.length) { f0OverlayPoints.value = t.f0.map(point => ({ ...point })); return; }
  const seg = computeChaoPchip(t.pts);
  const pts: Array<{ u: number; hz: number }> = [];
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    const y = evalChaoPchipY(seg, u);
    pts.push({ u, hz: chaoYToHz(y) });
  }
  f0OverlayPoints.value = pts;
}

function syncChaoDigitsFromPts(tone: DialectTone): void {
  const d0 = chaoYToLevel(tone.pts[0]);
  const d1 = chaoYToLevel(tone.pts[1]);
  const d2 = chaoYToLevel(tone.pts[2]);
  if (tone.checked) {
    tone.chao = `${d1}`;
  } else if (d0 === d1 && d1 === d2) {
    tone.chao = `${d0}${d2}`;
  } else if ((d1 - d0) * (d2 - d1) < 0) {
    tone.chao = `${d0}${d1}${d2}`;
  } else {
    tone.chao = `${d0}${d2}`;
  }
}

const TONE_SVG_W = 300;
const TONE_X_START = 12;
const TONE_X_END_OPEN = 288;
const TONE_X_END_CHECKED = 174;

function splitIpaText(raw: string): Array<{ text: string; isIpa: boolean }> {
  const parts: Array<{ text: string; isIpa: boolean }> = [];
  const re = /(\[[^\]]+\]|[0-9]+̚)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > lastIdx) {
      parts.push({ text: raw.slice(lastIdx, m.index), isIpa: false });
    }
    parts.push({ text: m[0], isIpa: true });
    lastIdx = re.lastIndex;
  }
  if (lastIdx < raw.length) {
    parts.push({ text: raw.slice(lastIdx), isIpa: false });
  }
  return parts;
}

const chaoCurvePath = computed(() => {
  const t = activeTone.value;
  if (!t) return '';
  const x0 = TONE_X_START;
  const xEnd = t.checked ? TONE_X_END_CHECKED : TONE_X_END_OPEN;
  const xMid = x0 + (xEnd - x0) * 0.5;
  const h = (xEnd - x0) * 0.5;
  const seg = computeChaoPchip(t.pts);
  const c1x = (x0 + h / 3).toFixed(2);
  const c2x = (xMid - h / 3).toFixed(2);
  const c3x = (xMid + h / 3).toFixed(2);
  const c4x = (xEnd - h / 3).toFixed(2);
  return `M ${x0},${seg.y0.toFixed(2)} C ${c1x},${seg.c1y.toFixed(2)} ${c2x},${seg.c2y.toFixed(2)} ${xMid.toFixed(2)},${seg.y1.toFixed(2)} C ${c3x},${seg.c3y.toFixed(2)} ${c4x},${seg.c4y.toFixed(2)} ${xEnd},${seg.y2.toFixed(2)}`;
});

const chaoPointCoords = computed(() => {
  const t = activeTone.value;
  if (!t) return [];
  const xEnd = t.checked ? TONE_X_END_CHECKED : TONE_X_END_OPEN;
  const xMid = TONE_X_START + (xEnd - TONE_X_START) * 0.5;
  return [
    { idx: 0, x: TONE_X_START, y: t.pts[0], pctX: (TONE_X_START / TONE_SVG_W) * 100, pctY: (t.pts[0] / 130) * 100 },
    { idx: 1, x: xMid, y: t.pts[1], pctX: (xMid / TONE_SVG_W) * 100, pctY: (t.pts[1] / 130) * 100 },
    { idx: 2, x: xEnd, y: t.pts[2], pctX: (xEnd / TONE_SVG_W) * 100, pctY: (t.pts[2] / 130) * 100 },
  ];
});

const f0OverlayPath = computed(() => {
  if (f0OverlayPoints.value.length < 2) return '';
  const xEnd = activeTone.value?.checked ? TONE_X_END_CHECKED : TONE_X_END_OPEN;
  return f0OverlayPoints.value
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${(TONE_X_START + pt.u * (xEnd - TONE_X_START)).toFixed(1)},${hzToCanvasY(pt.hz).toFixed(1)}`)
    .join(' ');
});

function trackGesture(e: PointerEvent, move: (ev: PointerEvent) => void, finish?: () => void): void {
  const target = e.currentTarget as Element;
  if (e.button !== 0 || !e.isPrimary) return;
  e.preventDefault();
  target.setPointerCapture(e.pointerId);
  const update = (raw: Event) => {
    const ev = raw as PointerEvent;
    if (ev.pointerId === e.pointerId) move(ev);
  };
  const end = (raw: Event) => {
    if ((raw as PointerEvent).pointerId !== e.pointerId) return;
    target.removeEventListener('pointermove', update);
    target.removeEventListener('lostpointercapture', end);
    finish?.();
  };
  target.addEventListener('pointermove', update);
  target.addEventListener('lostpointercapture', end);
  move(e);
}

function editChao(tone: DialectTone, idx: number, y: number): void {
  if (!props.editable) return;
  tone.pts[idx] = clampChaoY(y);
  syncChaoDigitsFromPts(tone);
  delete tone.f0;
  isPreviewingRecordingF0.value = false;
  rebuildF0OverlayFromActiveTone();
}

function startDragChaoNode(idx: number, e: PointerEvent): void {
  if (!props.editable) return;
  const tone = activeTone.value;
  const stage = (e.currentTarget as Element).closest('.dia-svg-stage');
  if (!tone || !stage) return;
  e.stopPropagation();
  const initial = tone.pts[idx];
  const height = stage.getBoundingClientRect().height;
  trackGesture(e, ev => editChao(tone, idx, initial + (ev.clientY - e.clientY) * 130 / height));
}

function pitchAt(points: ReadonlyArray<{u:number; hz:number}>, u:number): number {
  const idx = points.findIndex(pt => pt.u >= u);
  if (idx < 0) return points[points.length-1].hz;
  if (idx === 0) return points[0].hz;
  const a=points[idx-1], b=points[idx];
  return a.hz + (b.hz-a.hz) * (u-a.u) / Math.max(1e-9, b.u-a.u);
}

function onToneSvgPointerDown(e: PointerEvent, mode: 'chao' | 'f0'): void {
  if (!props.editable) {
    store.pushToast('内置方言为只读示例，请先复制字典后编辑调型', 'info');
    return;
  }
  const tone = activeTone.value;
  if (!tone) return;
  const bounds = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
  const xEnd = tone.checked ? TONE_X_END_CHECKED : TONE_X_END_OPEN;
  const at = (ev:PointerEvent) => ({
    u:Math.max(0, Math.min(1, ((ev.clientX-bounds.left)*300/bounds.width-TONE_X_START)/(xEnd-TONE_X_START))),
    y:(ev.clientY-bounds.top)*130/bounds.height,
  });
  if (mode === 'chao') {
    let previous=at(e);
    trackGesture(e, ev => {
      const now=at(ev), idx=Math.round(now.u*2);
      for(let k=0;k<3;k++) {
        const u=k/2;
        if(k!==idx && (u-previous.u)*(u-now.u)<=0 && now.u!==previous.u)
          tone.pts[k]=clampChaoY(previous.y+(now.y-previous.y)*(u-previous.u)/(now.u-previous.u));
      }
      editChao(tone,idx,now.y);
      previous=now;
    });
    return;
  }
  const samples = Array.from({length:101},(_,i)=>({u:i/100,hz:pitchAt(f0OverlayPoints.value,i/100)}));
  let previous=at(e);
  isDrawingF0.value = true;
  isPreviewingRecordingF0.value = false;
  trackGesture(e, ev => {
    const now=at(ev), start=Math.round(previous.u*100), end=Math.round(now.u*100);
    for(let i=Math.min(start,end);i<=Math.max(start,end);i++){
      const y=start===end ? now.y : previous.y+(now.y-previous.y)*(i-start)/(end-start);
      samples[i].hz=canvasYToHz(y);
    }
    f0OverlayPoints.value = samples.map(point=>({...point}));
    previous=now;
  }, () => {
    isDrawingF0.value = false;
    tone.f0 = samples.map(point=>({...point}));
  });
}

let mounted=true;
function stopActiveRecorder(): void {
  const rec = mediaRec;
  mediaRec = null;
  isRecording.value = false;
  if (!rec) return;
  try {
    if (rec.state !== 'inactive') rec.stop();
  } catch { /* ignore already stopped recorder */ }
  rec.stream.getTracks().forEach((t) => t.stop());
}
onBeforeUnmount(() => {
  mounted = false;
  recordReqToken++;
  requestingMic.value = false;
  stopActiveRecorder();
});
async function analyzeRecording(blob:Blob,name:string) {
 const pack = dialectKey.value;
 const tone = activeTone.value;
 const text = recordText.value.trim() || name;
 const file=blob instanceof File?blob:new File([blob],name,{type:blob.type});
 let chosen = file;
 let clean = false;
 if (recDenoise.value) {
   try { chosen = await denoiseFile(file); clean = true; }
   catch (error) { if (mounted) store.pushToast(`降噪失败，保留原音 · ${String(error)}`, 'warning'); }
 }
 if (!clean) chosen = await normalizeAudioFile(file, file.name);
 let points: RecordedTake['pts'] = [];
 try { points = await swiftPitchRecording(chosen); }
 catch (error) { if (mounted) store.pushToast(`录音已保留，基频提取失败 · ${String(error)}`, 'warning'); }
 if (!mounted) return;
 recordings.value.push({ original:file, clean, text, url:URL.createObjectURL(chosen), pts:points, pack,
   toneId: [...text].length === 1 ? tone?.id : undefined });
 if (dialectKey.value !== pack || tone !== activeTone.value) return;
 if ([...text].length === 1 && points.length >= 3) previewExtractedCurve(points, clean);
 else {
   f0OverlayPoints.value = points;
   extractedF0Summary.value = `${text} · SwiftF0 · ${points.length} 个有声帧`;
 }
}
async function toggleTakeNoise(r:typeof recordings.value[number]){
 try {
   const clean = !r.clean;
   const file = clean ? await denoiseFile(r.original) : await normalizeAudioFile(r.original, r.original.name);
   if (!mounted) return;
   URL.revokeObjectURL(r.url);
   r.url = URL.createObjectURL(file);
   r.clean = clean;
   r.pts = [];
   const expectedUrl = r.url;
   const points = await swiftPitchRecording(file);
   if (!mounted || expectedUrl !== r.url) return;
   r.pts = points;
   if (dialectKey.value !== r.pack) return;
   if (r.toneId && r.toneId === activeTone.value?.id && points.length >= 3) previewExtractedCurve(points, clean);
   else f0OverlayPoints.value = points;
 } catch (error) { if (mounted) store.pushToast(String(error),'warning'); }
}
async function toggleSingleWordRecord() {
 if (mediaRec?.state === 'recording') {
   mediaRec.stop();
   isRecording.value = false;
   return;
 }
 if (requestingMic.value) {
   recordReqToken++;
   requestingMic.value = false;
   return;
 }
 const token = ++recordReqToken;
 requestingMic.value = true;
 try {
   const stream = await navigator.mediaDevices.getUserMedia({
     audio: { noiseSuppression: false, echoCancellation: false, autoGainControl: false },
   });
   if (!mounted || token !== recordReqToken) {
     stream.getTracks().forEach((t) => t.stop());
     return;
   }
   let recorder: MediaRecorder;
   try {
     recorder = new MediaRecorder(stream);
     const chunks: Blob[] = [];
     const mime = recorder.mimeType;
     recorder.ondataavailable = (e) => {
       if (e.data.size) chunks.push(e.data);
     };
     recorder.onstop = () => {
       stream.getTracks().forEach((t) => t.stop());
       if (mediaRec === recorder) mediaRec = null;
       isRecording.value = false;
       if (mounted && chunks.length) void analyzeRecording(new Blob(chunks, { type: mime }), '录音');
     };
     recorder.start();
   } catch (startErr) {
     stream.getTracks().forEach((t) => t.stop());
     throw startErr;
   }
   mediaRec = recorder;
   isRecording.value = true;
 } catch (error) {
   if (mounted && token === recordReqToken) {
     store.pushToast('无法开始录音 · ' + String(error), 'warning');
   }
 } finally {
   if (token === recordReqToken) requestingMic.value = false;
 }
}
function summarizePackPitchRange(): void {
  const curves: Array<ReadonlyArray<{ hz: number }>> = [
    ...recordings.value.filter((r) => r.pack === dialectKey.value && r.pts.length >= 3).map((r) => r.pts),
    ...editableTones.value.flatMap((t) => (t.f0 && t.f0.length >= 3 ? [t.f0] : [])),
  ];
  const est = estimateSpeakerPitchRangeFromCurves(curves);
  if (!est) {
    store.pushToast('当前已采录样本音高跨度不足 3.5 半音，请采集不同音高的字词或手动填写说话人调域', 'warning');
    return;
  }
  speakerPitchMinHz.value = est.minHz;
  speakerPitchMaxHz.value = est.maxHz;
  store.pushToast(`已汇总说话人参考调域：${est.minHz}–${est.maxHz} Hz`, 'success');
}
function previewExtractedCurve(pts: Array<{ u: number; hz: number }>, clean: boolean): void {
  f0OverlayPoints.value = pts.map((p) => ({ ...p }));
  isPreviewingRecordingF0.value = pts.length >= 2;
  const hzMin = Math.round(Math.min(...pts.map((p) => p.hz)));
  const hzMax = Math.round(Math.max(...pts.map((p) => p.hz)));
  const checked = activeTone.value?.checked ?? false;
  const fitted = fitChaoFromPitchCurve(pts, speakerPitchRange.value, checked);
  if (fitted) {
    extractedF0Summary.value = `提取 F0 ${hzMin}–${hzMax} Hz (${clean ? '已降噪' : '原始'}) · 调域拟合五度 ${fitted.chao}${checked ? '̚' : ''}（未自动覆盖原调类，可点击「按调域写入调类」）`;
  } else {
    extractedF0Summary.value = `提取 F0 ${hzMin}–${hzMax} Hz (${clean ? '已降噪' : '原始'}) · 未设说话人参考调域，已保留 Hz 曲线与原调类`;
  }
  store.pushToast(extractedF0Summary.value, 'info', 3000);
}
function applyFittedChaoToActiveTone(): void {
  if (!props.editable) {
    store.pushToast('内置方言为只读示例，请先复制字典后写入调类', 'info');
    return;
  }
  const tone = activeTone.value;
  if (!tone || f0OverlayPoints.value.length < 3) {
    store.pushToast('请先录制或载入至少 3 帧有声基频的单字样本', 'warning');
    return;
  }
  const fitted = fitChaoFromPitchCurve(f0OverlayPoints.value, speakerPitchRange.value, tone.checked);
  if (!fitted) {
    store.pushToast('请先设定或汇总同一说话人的参考调域（正基频且跨度 ≥ 3 半音），再换算五度调值', 'warning');
    return;
  }
  const validPts = f0OverlayPoints.value.filter(
    (point) => point.u >= 0 && point.u <= 1 && isValidF0Hz(point.hz),
  );
  if (validPts.length !== f0OverlayPoints.value.length) {
    store.pushToast('该曲线包含无效基频（须大于 0 Hz）', 'warning');
    return;
  }
  tone.f0 = validPts.map((p) => ({ ...p }));
  tone.pts = [...fitted.svgPts];
  tone.chao = fitted.chao;
  isPreviewingRecordingF0.value = false;
  store.pushToast(`已按说话人调域将 ${tone.name} 更新为 ${tone.chao}${tone.checked ? '̚' : ''}`, 'success');
}

// ===== Editable 3-Type Non-Recursive Sandhi Rule Table =====
const sandhiTypeOptions: ReadonlyArray<SelectOption<'pair' | 'lexical' | 'word_pattern'>> = [
  { value: 'pair', label: 'pair · 邻接双字变调' },
  { value: 'lexical', label: 'lexical · 词项特例变调' },
  { value: 'word_pattern', label: 'word_pattern · 整词广用式' },
];

function addSandhiRule(): void {
  if (!props.editable) return;
  editableSandhi.value.push({
    en: true,
    type: 'pair',
    trig: '214 + 214',
    out: '35 + 214',
    note: '新建连读变调规则',
  });
  runSandhiSimulation();
}

function removeSandhiRule(idx: number): void {
  if (!props.editable) return;
  editableSandhi.value.splice(idx, 1);
  runSandhiSimulation();
}

function runSandhiSimulation(): void {
  if (!allowRules.value) return;
  let pack;
  try { pack = coreDialect({ id: dialectKey.value, name: currentPack.value.name, tones: editableTones.value, sandhi: editableSandhi.value }); }
  catch (error) { sandboxTrace.value=[]; sandboxNotice.value = error instanceof Error ? error.message : String(error); return; }
  const { categories } = pack;
  sandboxNotice.value='';
  const tokens=sandboxInput.value.trim().split(/[+，,\s]+/u).filter(Boolean);
  if(!tokens.length){sandboxTrace.value=[];return;}
  const resolveCategory = (rawToken: string) => {
    const digits = toneDigits(rawToken);
    return categories.find(c => c.label === rawToken || c.id === rawToken || c.levels === rawToken || (digits && c.levels === digits));
  };
  const missing = tokens.filter(t => !resolveCategory(t));
  if(missing.length){sandboxNotice.value='当前字典没有调类 '+missing.join('、');sandboxTrace.value=[];return;}
  const example = [...sandboxWord.value.trim()];
  const testSylls = tokens.map((token, idx) => ({
    text: example[idx] ?? token,
    tone_id: resolveCategory(token)!.id,
    domain_id: 'w1',
    is_prepausal: idx === tokens.length - 1,
  }));
  const res = applyDialectSandhi(pack, testSylls);
  sandboxTrace.value = res.ok ? res.value : [];
}

async function auditionActiveTone(): Promise<void> {
  const t = activeTone.value;
  if (!t) return;
  const points = f0OverlayPoints.value.map(point=>({...point}));
  if (points.length < 2) return;
  const buf = await store.synthesizeRange({
    durationMs: t.checked ? 260 : 560,
    pitchAt: u=>pitchAt(points,u),
    tractParams: {
      TCX: currentPack.value.pose.TCX,
      TCY: currentPack.value.pose.TCY,
      TTX: currentPack.value.pose.TTX,
      TTY: currentPack.value.pose.TTY,
      LD: currentPack.value.pose.LD,
      LP: currentPack.value.pose.LP,
      JA: currentPack.value.pose.JA,
      VO: currentPack.value.pose.VO,
    },
  });
  if (buf) await store.playAudioBuffer(buf);
}

function applyToneToSelectedSyllable(): void {
  const t = activeTone.value;
  if (!t) return;
  const syl = selectedMainSyllable.value;
  if (!syl) {
    store.pushToast('请先在语音合成或编曲页选中一个音节，再写入主轨', 'info');
    return;
  }
  const pts = f0OverlayPoints.value.length >= 2
    ? f0OverlayPoints.value
    : [{ u: 0, hz: chaoYToHz(t.pts[0]) }, { u: 0.5, hz: chaoYToHz(t.pts[1]) }, { u: 1, hz: chaoYToHz(t.pts[2]) }];
  const span = Math.max(1, syl.end_smp - syl.start_smp);
  const f0Pts = pts.map((p) => ({
    t_smp: syl.start_smp + Math.round(p.u * span),
    f0_hz: p.hz,
  }));
  store.executeCommand({
    type: 'f0.draw',
    label: `写入方言调型「${t.name} ${t.chao}${t.checked ? '̚' : ''}」至音节「${syl.text}」`,
    payload: { id: `dialect_${syl.id}`, points: f0Pts },
  });
  store.pushToast(`已将 ${currentPack.value.name} ${t.name} 连续 F0 写入主时间轴`, 'success');
}

watch(dialectKey, (k) => loadDialectPack(k), { immediate: true });
watch([editableTones, editableSandhi, linkedSet, speakerPitchMinHz, speakerPitchMaxHz], () => {
  if (loadingPack || !props.editable) return;
  try {
    if (!hasUnsavedChanges.value) {
      localStorage.removeItem(dialectDraftKey(dialectKey.value));
      return;
    }
    const { poseSetId, pitchRangeHz, tones, sandhi } = getDraft();
    const original = readDialectDraft(dialectKey.value);
    localStorage.setItem(dialectDraftKey(dialectKey.value), JSON.stringify({ ...original, poseSetId, pitchRangeHz, tones, sandhi }));
  } catch { store.pushToast('本地空间不足，请先导出字典', 'warning'); }
}, { deep: true });
watch(speakerPitchRange, () => {
  if (!activeTone.value?.f0?.length && !isPreviewingRecordingF0.value) {
    rebuildF0OverlayFromActiveTone();
  }
});
watch(activeTone, (tone) => {
  confirmingToneDeletion.value = false;
  isPreviewingRecordingF0.value = false;
  toneNameDraft.value = tone?.name ?? '';
  rebuildF0OverlayFromActiveTone();
});

watchEffect(() => {
  publishPanelSnapshot('dialect', {
    packName: currentPack.value.name,
    tones: editableTones.value.map((t) => ({
      id: t.id,
      name: t.name,
      chao: t.chao,
      pts: [...t.pts],
      checked: t.checked,
      f0: t.f0?.map((p) => ({ ...p })),
    })),
    activeToneIdx: selectedToneIdx.value,
    sandboxInput: sandboxInput.value,
    sandboxTrace: sandboxTrace.value.map((row) => ({ ...row })),
  });
});
</script>

<template>
  <div class="dia-tools">
    <div class="dia-tool-bar" data-tour="dialect-tool-tabs">
      <div class="dia-tool-tabs seg" aria-label="方言工具">
        <button type="button" :class="{ active: toolTab === 'tone' }" @click="toolTab = 'tone'">调型</button>
        <button type="button" :class="{ active: toolTab === 'record' }" @click="toolTab = 'record'">采录</button>
        <button type="button" :class="{ active: toolTab === 'guide' }" @click="toolTab = 'guide'">指引</button>
      </div>
      <button
        v-if="editable"
        class="btn xs"
        :class="{ primary: hasUnsavedChanges }"
        type="button"
        @click="emit('save', getDraft(), 'all')"
      >
        <IconSvg name="check" :size="11" />
        <span>{{ hasUnsavedChanges ? '保存修改' : '已保存' }}</span>
      </button>
    </div>

    <div v-if="!editable" class="dia-readonly-banner">
      <span>内置方言为只读示例，可试听与沙盒试算。</span>
      <button type="button" class="btn xs" @click="emit('copy')">
        <IconSvg name="copy" :size="11" /> 复制后编辑
      </button>
    </div>

    <div v-show="toolTab === 'tone'" class="dia-center" data-tour="dialect-tone-board">
      <section class="dia-tone-section">
        <div class="dia-tone-head">
          <div class="dia-head-ctrls">
            <button type="button" class="btn xs" @click="auditionActiveTone">
              <IconSvg name="play" :size="11" />
              <span>试听</span>
            </button>
            <button
              type="button"
              class="btn xs primary"
              :title="selectedMainSyllable ? `将当前调型写入音节「${selectedMainSyllable.text}」` : '请先在语音合成或编曲页选中一个音节'"
              @click="applyToneToSelectedSyllable"
            >
              <span>写入主轨</span>
            </button>
            <button
              v-if="editable && isPreviewingRecordingF0"
              type="button"
              class="btn xs"
              @click="saveOverlayToTone"
            >
              应用到当前调类
            </button>
          </div>
        </div>

        <div class="dia-tone-controls">
          <div class="dia-tone-actions">
            <button v-if="editable" type="button" class="btn xs" @click="beginAddTone">
              <IconSvg name="plus" :size="11" /> 新增调类
            </button>
            <form v-if="editable && newToneName !== undefined" class="dia-tone-create" @submit.prevent="addTone"
              @keydown.esc.stop.prevent="newToneName = undefined">
              <input ref="newToneInput" v-model="newToneName" class="inp dia-tone-name" aria-label="新调类名称"
                placeholder="输入调类名称" maxlength="36" required />
              <button type="submit" class="btn xs primary">确认新增</button>
              <button type="button" class="btn xs" @click="newToneName = undefined">取消</button>
            </form>
            <template v-else-if="activeTone">
              <input
                v-model="toneNameDraft"
                class="inp dia-tone-name"
                aria-label="当前调类名称"
                maxlength="36"
                :readonly="!editable"
                @change="commitToneName"
                @keyup.enter="commitToneName"
              />
              <button
                v-if="editable"
                type="button"
                class="btn xs dia-tone-delete"
                :disabled="editableTones.length <= 1"
                :title="editableTones.length <= 1 ? '字典至少保留一个调类' : '删除当前调类'"
                @click="beginDeleteTone"
              >
                删除调类
              </button>
              <label class="dia-checked-chk">
                <input
                  v-model="activeTone.checked"
                  type="checkbox"
                  :disabled="!editable"
                  @change="syncChaoDigitsFromPts(activeTone)"
                />
                <span>入声不除阻 <span class="ipa">[◌̚]</span></span>
              </label>
            </template>
          </div>
          <div v-if="editable && confirmingToneDeletion && activeTone" class="dia-tone-actions" role="group" aria-label="确认删除调类">
            <span>删除「{{ activeTone.name }}」？</span>
            <button type="button" class="btn xs danger" @click="deleteTone">确认删除</button>
            <button type="button" class="btn xs" @click="confirmingToneDeletion = false">取消</button>
          </div>
          <div class="dia-tone-pills">
            <button
              v-for="(t, idx) in editableTones"
              :key="`${toneId(t, idx)}:${idx}`"
              type="button"
              class="btn xs"
              :class="{ active: selectedToneIdx === idx }"
              :aria-pressed="selectedToneIdx === idx"
              @click="selectedToneIdx = idx"
            >
              <span>{{ t.name }}</span>
              <span :class="t.checked ? 'ipa dia-chao-ipa' : 'mono'">{{ t.chao }}{{ t.checked ? '̚' : '' }}</span>
            </button>
          </div>
        </div>

        <div class="dialect-graphs">
          <div class="chao-board acoustic-plot">
            <header class="graph-legend">
              <i></i>
              <span>赵氏五度</span>
              <small>相对调值 · 起 / 中 / 尾</small>
            </header>
            <div class="dia-svg-host">
              <div class="dia-y-scale" aria-hidden="true">
                <span
                  v-for="lv in [5, 4, 3, 2, 1]"
                  :key="`y_${lv}`"
                  class="dia-y-tick mono"
                  :style="{ top: `${(levelToY(lv) / 130) * 100}%` }"
                >
                  {{ lv }} 度
                </span>
              </div>

              <div class="dia-svg-stage">
                <svg
                  class="dia-tone-svg"
                  :class="{ readonly: !editable }"
                  viewBox="0 0 300 130"
                  preserveAspectRatio="none"
                  @pointerdown="onToneSvgPointerDown($event, 'chao')"
                >
                  <!-- Chao 5-Level horizontal lines (5..1) -->
                  <line
                    v-for="lv in [5, 4, 3, 2, 1]"
                    :key="lv"
                    x1="6"
                    x2="294"
                    :y1="levelToY(lv)"
                    :y2="levelToY(lv)"
                    stroke="var(--chart-grid)"
                    stroke-opacity="0.58"
                    stroke-dasharray="3 3"
                    vector-effect="non-scaling-stroke"
                  />

                  <!-- Checked Tone Unreleased Stop Coda Cutoff Wall (vector only — label is crisp HTML overlay) -->
                  <g v-if="activeTone?.checked">
                    <rect x="174" y="14" width="120" height="96" fill="color-mix(in srgb, var(--danger) 10%, transparent)" />
                    <line
                      x1="174"
                      y1="14"
                      x2="174"
                      y2="110"
                      stroke="var(--danger)"
                      stroke-width="1.6"
                      stroke-dasharray="4 2"
                      vector-effect="non-scaling-stroke"
                    />
                  </g>

                  <!-- Chao 5-Level Curve -->
                  <path
                    :d="chaoCurvePath"
                    fill="none"
                    stroke="var(--chart-series)"
                    style="stroke-width: var(--chart-line)"
                    stroke-linecap="round"
                    vector-effect="non-scaling-stroke"
                  />
                </svg>

                <!-- Crisp HTML Checked-Tone Unreleased Stop Badge -->
                <div v-if="activeTone?.checked" class="dia-checked-overlay">
                  <strong class="dia-checked-title">入声闭塞不除阻 <span class="ipa">[p̚ / t̚ / k̚]</span></strong>
                  <span class="dia-checked-sub">无除阻脉冲 · 截面积归零</span>
                </div>

                <!-- Perfectly Circular Draggable Chao Control Handles -->
                <template v-if="activeTone">
                  <button
                    v-for="pt in chaoPointCoords"
                    :key="pt.idx"
                    type="button"
                    class="chao-handle-node"
                    :disabled="!editable"
                    :style="{ left: `${pt.pctX}%`, top: `${pt.pctY}%` }"
                    :title="editable ? `拖曳调节五度控制点 ${pt.idx + 1}` : `五度控制点 ${pt.idx + 1}`"
                    @pointerdown="startDragChaoNode(pt.idx, $event)"
                    @keydown.up.prevent="editChao(activeTone!, pt.idx, pt.y - 20)"
                    @keydown.down.prevent="editChao(activeTone!, pt.idx, pt.y + 20)"
                  />
                </template>
              </div>
            </div>
          </div>

          <figure class="field-pitch acoustic-plot">
            <figcaption class="graph-legend">
              <i></i>
              <span>合成基频</span>
              <small>
                {{
                  isPreviewingRecordingF0
                    ? '录音预览 · 未写入调类'
                    : activeTone?.f0?.length
                      ? '已细修 Hz 曲线'
                      : speakerPitchRange
                        ? `调域换算 · ${speakerPitchRange.minHz}–${speakerPitchRange.maxHz} Hz`
                        : '五度换算 · 115–300 Hz'
                }}
              </small>
              <button
                v-if="editable && (activeTone?.f0?.length || isPreviewingRecordingF0)"
                type="button"
                class="btn xs dia-f0-reset"
                @click="resetToneF0"
              >
                重置为五度
              </button>
            </figcaption>
            <div class="pitch-scale"><span>{{ pitchBounds.max }} Hz</span><span>{{ pitchBounds.min }} Hz</span></div>
            <svg
              :class="{ readonly: !editable }"
              viewBox="0 0 300 130"
              preserveAspectRatio="none"
              aria-label="手绘合成基频"
              @pointerdown="onToneSvgPointerDown($event, 'f0')"
            >
              <line v-for="y in [16, 64, 112]" :key="y" x1="12" x2="288" :y1="y" :y2="y" stroke="var(--chart-grid)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />
              <g v-if="activeTone?.checked">
                <rect x="174" y="12" width="114" height="104" fill="color-mix(in srgb, var(--danger) 10%, transparent)" />
                <line x1="174" y1="12" x2="174" y2="116" stroke="var(--danger)" stroke-width="1.4" stroke-dasharray="4 2" vector-effect="non-scaling-stroke" />
              </g>
              <path :d="f0OverlayPath" stroke="var(--chart-peer)" fill="none" style="stroke-width: var(--chart-line)" vector-effect="non-scaling-stroke" />
            </svg>
          </figure>
        </div>
      </section>
    </div>

    <Teleport v-if="allowRules && ruleHost" :to="ruleHost">
      <section class="dia-sandhi-panel" aria-label="连读变调规则">
        <div v-if="!editable" class="dia-readonly-banner">
          <span>内置方言变调规则为只读，可直接在下方沙盒试算。</span>
          <button type="button" class="btn xs" @click="emit('copy')">
            <IconSvg name="copy" :size="11" /> 复制后编辑
          </button>
        </div>
        <div class="dia-head-ctrls dia-rule-toolbar">
          <button type="button" class="btn xs" @click="runSandhiSimulation">
            <IconSvg name="refresh" :size="11" />
            <span>运行沙盒校验</span>
          </button>
          <button v-if="editable" type="button" class="btn xs primary" @click="addSandhiRule">
            <IconSvg name="plus" :size="11" />
            <span>新增规则</span>
          </button>
          <button
            v-if="editable"
            type="button"
            class="btn xs"
            :class="{ primary: hasUnsavedChanges }"
            @click="emit('save', getDraft(), 'sandhi')"
          >
            <IconSvg name="check" :size="11" />
            <span>{{ hasUnsavedChanges ? '保存规则' : '已保存' }}</span>
          </button>
        </div>
        <div class="dia-sandhi-body">
          <article v-for="(rule, idx) in editableSandhi" :key="ruleRenderKey(rule)" class="dia-rule">
            <div class="dia-rule-head">
              <label><input v-model="rule.en" type="checkbox" :disabled="!editable" @change="runSandhiSimulation" /> 启用</label>
              <CustomSelect
                v-model="rule.type"
                :options="sandhiTypeOptions"
                :disabled="!editable"
                size="xs"
                aria-label="规则类型"
                @change="runSandhiSimulation"
              />
              <button v-if="editable" type="button" class="btn xs icon-only" aria-label="删除该规则" @click="removeSandhiRule(idx)">
                <IconSvg name="trash" :size="11" />
              </button>
            </div>
            <label class="dia-rule-field">
              <span>触发</span>
              <input v-model="rule.trig" type="text" class="inp dia-cell-inp dia-ipa-inp" :readonly="!editable" @change="runSandhiSimulation" />
            </label>
            <label class="dia-rule-field">
              <span>输出</span>
              <input v-model="rule.out" type="text" class="inp dia-cell-inp dia-ipa-inp" :readonly="!editable" @change="runSandhiSimulation" />
            </label>
            <label class="dia-rule-field dia-rule-note">
              <span>备注</span>
              <input v-model="rule.note" type="text" class="inp dia-cell-inp" :readonly="!editable" />
            </label>
          </article>
          <p v-if="!editableSandhi.length" class="muted dia-rule-empty">当前字典没有自定义变调规则。</p>
          <div class="sandbox-box">
            <div class="sandbox-input">
              <label class="sandbox-field">
                <span>测试调序</span>
                <input
                  v-model="sandboxInput"
                  class="inp"
                  placeholder="如 53 + 55 或 阴平 + 阴上"
                  @keyup.enter="runSandhiSimulation"
                />
              </label>
              <label class="sandbox-field">
                <span>例词（可选）</span>
                <input
                  v-model="sandboxWord"
                  class="inp"
                  placeholder="测 lexical 特例时填写"
                  @keyup.enter="runSandhiSimulation"
                />
              </label>
            </div>
            <div class="dia-head-ctrls">
              <button type="button" class="btn xs primary" @click="runSandhiSimulation">试算</button>
              <button type="button" class="btn xs" @click="sandboxInput = ''; sandboxWord = ''; sandboxTrace = []; sandboxNotice = ''">清空沙盒</button>
              <span v-if="sandboxNotice" class="dia-sandbox-notice">{{ sandboxNotice }}</span>
            </div>
          </div>
          <div v-if="sandboxTrace.length > 0" class="dia-trace-bar">
            <strong>变调试算</strong>
            <button type="button" class="btn xs" @click="sandboxTrace = []">清除结果</button>
            <span v-for="item in sandboxTrace" :key="item.index" class="metric-chip">
              <span>{{ item.text }}</span>
              <span :class="item.checked ? 'ipa dia-chao-ipa' : 'mono'">{{ item.levels }}{{ item.checked ? '̚' : '' }}</span>
              <span v-if="item.rewritten_by" class="tree-tag">{{ item.rewritten_by }}</span>
            </span>
          </div>
        </div>
      </section>
    </Teleport>

    <div v-show="toolTab === 'record'" class="p-body dia-left-body">
      <label class="dia-library">
        <span>音标构型套装</span>
        <CustomSelect
          v-model="linkedSet"
          :disabled="!editable"
          aria-label="字典关联的音标构型套装"
          size="sm"
          :options="ipaPoseSets.map(item => ({ value: item.id, label: item.name }))"
        />
      </label>
      <div class="param-sec">
        <div class="param-sec-title">
          <span>字词采录 · SwiftF0</span>
        </div>
        <input v-model="recordText" class="inp" placeholder="录音字词，可输入单字、双字或短语" />
        <div class="dia-rec-acts">
          <button
            type="button"
            class="btn xs"
            :class="{ danger: isRecording || requestingMic }"
            @click="toggleSingleWordRecord"
          >
            <IconSvg name="mic" :size="12" />
            <span>{{ isRecording ? '停止并提取' : requestingMic ? '取消授权等待' : '录制字词' }}</span>
          </button>
          <button type="button" class="btn xs" :class="{ active: recDenoise }" @click="recDenoise = !recDenoise">
            <span>DPDFNet 降噪 {{ recDenoise ? '开' : '关' }}</span>
          </button>
        </div>
        <div class="dia-pitch-range-row">
          <input
            v-model.number="speakerPitchMinHz"
            type="number"
            min="1"
            step="5"
            class="inp mono"
            :readonly="!editable"
            placeholder="调域下限 Hz"
            aria-label="说话人调域下限 Hz"
          />
          <input
            v-model.number="speakerPitchMaxHz"
            type="number"
            min="1"
            step="5"
            class="inp mono"
            :readonly="!editable"
            placeholder="调域上限 Hz"
            aria-label="说话人调域上限 Hz"
          />
          <button
            type="button"
            class="btn xs"
            :disabled="!editable"
            title="根据本包已采录的多条基频自动估算 5%–95% 调域"
            @click="summarizePackPitchRange"
          >
            汇总调域
          </button>
        </div>
        <div v-if="speakerPitchRangeHint" class="dia-f0-note muted">{{ speakerPitchRangeHint }}</div>
        <div class="dia-rec-acts">
          <label class="btn xs">
            载入本地音频
            <input hidden type="file" accept="audio/*" @change="e => { const i = e.target as HTMLInputElement; const f = i.files?.[0]; if (f) analyzeRecording(f, f.name); i.value = ''; }" />
          </label>
          <button
            type="button"
            class="btn xs"
            :disabled="!editable || !speakerPitchRange || f0OverlayPoints.length < 3"
            title="使用当前说话人参考调域对数换算五度并写入选中调类"
            @click="applyFittedChaoToActiveTone"
          >
            按调域写入调类
          </button>
        </div>
        <div v-for="r in localRecordings" :key="r.url" class="dia-take-item">
          <div class="dia-take-head">
            <button type="button" class="btn xs" @click="showRecording(r)">{{ r.text }} · 查看基频</button>
            <button type="button" class="btn xs" @click="toggleTakeNoise(r)">{{ r.clean ? '恢复原音' : 'DPDFNet 降噪' }}</button>
            <button type="button" class="btn xs icon-only" aria-label="移除该录音" title="移除该录音" @click="removeRecording(r)">
              <IconSvg name="trash" :size="11" />
            </button>
          </div>
          <audio controls preload="none" :src="r.url" class="dia-take-audio" />
        </div>
        <div class="dia-f0-note muted">
          <template v-for="(seg, sIdx) in splitIpaText(extractedF0Summary)" :key="sIdx">
            <span v-if="seg.isIpa" class="ipa">{{ seg.text }}</span>
            <template v-else>{{ seg.text }}</template>
          </template>
        </div>
      </div>
    </div>

    <div v-show="toolTab === 'guide'" class="dia-guide">
      <div class="p-body dia-guide-body">
        <div class="editorial-card">
          <strong>双画布联动调型</strong>
          <p>上方「赵氏五度」画布可直接拖曳起、中、尾三个圆点或一笔勾画，自动同步五度调值（如 55 / 35 / 214 / 51）并换算下方基频曲线。</p>
          <p>下方「合成基频」画布以 Hz 显示试听和写入主轨所用的基频，可直接拖画细修，也可随时重置为五度换算曲线。</p>
        </div>

        <div class="editorial-card">
          <strong>粤语与入声不除阻 <span class="ipa">[◌̚]</span></strong>
          <p>勾选「入声不除阻 <span class="ipa">[◌̚]</span>」后，音节时长自动缩短，声道末端在闭塞点处截面积归零并关闭除阻脉冲（对应 <span class="ipa">[p̚ / t̚ / k̚]</span>）。</p>
        </div>

        <div v-if="allowRules" class="editorial-card">
          <strong>变调规则的优先级</strong>
          <p>内核按 <code>lexical</code>（词项特例）→ <code>word_pattern</code>（吴语广用式整词调型）→ <code>pair</code>（邻接双字变调）顺序单次扫描，每个音节最多改写一次，保证确定性收敛不死循环。</p>
        </div>

        <div class="editorial-card">
          <strong>采录单字、双字和多字调</strong>
          <p>输入要采录的字词，录制或载入音频。SwiftF0 提取实际有声帧。单字可以按说话人调域拟合五度，多字保留整词曲线和原音。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dia-tools {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  min-height: 0;
}
.dia-tool-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
}
.dia-tool-tabs { align-self: flex-start; }
.dia-readonly-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--muted);
  font-size: 0.85rem;
}
.dia-guide, .dia-left-body, .dia-center { min-width: 0; min-height: 0; }
.dia-left-body,
.dia-guide-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
}

.dia-rec-acts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100px, 100%), 1fr));
  gap: 6px;
}

.dia-pitch-range-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 5px;
  align-items: center;
}
.dia-pitch-range-row .inp { min-width: 0; width: 100%; }

.dia-take-item {
  display: grid;
  gap: 5px;
  padding: 6px;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
}
.dia-take-head {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}
.dia-take-audio {
  width: 100%;
  height: 26px;
}

.dia-f0-note {
  margin-top: 2px;
  font-size: 0.833333rem;
  line-height: 1.4;
}

.dia-tone-name { flex: 1 1 110px; width: 110px; min-width: 72px; max-width: 16rem; }
.dia-tone-delete { color: var(--danger); }

.dia-center {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dia-tone-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dia-tone-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex-wrap: wrap;
}

.dia-head-ctrls button { white-space: normal; }

.dia-head-ctrls {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.dia-tone-controls {
  flex: none;
  padding: 6px 0;
  border-top: 1px solid color-mix(in srgb, var(--panel-border) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--panel-border) 60%, transparent);
  display: grid;
  gap: 6px;
}

.dia-tone-actions, .dia-tone-create, .dia-tone-pills {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.dia-checked-chk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--danger);
  cursor: pointer;
}

.dia-chao-ipa {
  font-size: 0.958333rem;
  line-height: 1.15;
}

.dia-svg-host {
  flex: 1;
  min-height: 0;
  padding: 4px 8px 6px;
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.dia-y-scale {
  width: 34px;
  flex: none;
  position: relative;
  user-select: none;
}

.dia-y-tick {
  position: absolute;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  text-align: right;
  font-size: 0.816667rem;
  line-height: 1;
  color: var(--muted);
  white-space: nowrap;
}

.dia-svg-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  position: relative;
}

.dia-tone-svg {
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair;
  touch-action: none;
}
.dia-tone-svg.readonly,
.field-pitch svg.readonly {
  cursor: default;
}

.dia-checked-overlay {
  position: absolute;
  top: 12%;
  left: 59.5%;
  right: 2.5%;
  padding: 5px 8px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid color-mix(in srgb, var(--danger) 42%, transparent);
  display: flex;
  flex-direction: column;
  gap: 2px;
  pointer-events: none;
}

.dia-checked-title {
  font-size: 0.866667rem;
  line-height: 1.3;
  color: var(--danger);
  font-weight: 700;
}

.dia-checked-sub {
  font-size: 0.8rem;
  line-height: 1.25;
  color: var(--muted);
}

.chao-handle-node {
  position: absolute;
  width: 12px;
  height: 12px;
  padding: 0;
  border-radius: 50%;
  background: var(--ctrl-bg);
  border: 2px solid var(--accent);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--text) 18%, transparent);
  transform: translate(-50%, -50%);
  cursor: ns-resize;
  z-index: var(--z-base);
  touch-action: none;
}

.chao-handle-node:disabled {
  cursor: default;
  opacity: 0.75;
}

.chao-handle-node:not(:disabled):hover {
  transform: translate(-50%, -50%) scale(1.16);
  background: var(--selected);
}

.dia-sandhi-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dia-rule-toolbar { margin: 0; }

.dia-sandhi-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dia-cell-inp {
  width: 100%;
  height: 22px;
  font-size: 0.9rem;
  padding: 0 5px;
}

.dia-ipa-inp {
  font-family: "PTBIPAPlus", "PTB-Doulos", "Doulos SIL", var(--font-ui);
}

.dia-trace-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
  border: 1px solid var(--panel-border);
  font-size: 0.875rem;
}

.dia-guide-body p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--muted);
}

.dia-guide-body code {
  font-family: var(--font-mono);
  font-size: 0.833333rem;
  color: var(--accent);
}

.dialect-graphs {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: clamp(180px, 25vh, 252px);
  gap: 8px;
}
.dialect-graphs > .acoustic-plot { grid-column: 1 / -1; }

.sandbox-box {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--panel-border);
  border-radius: var(--r-ctrl);
  background: var(--ctrl-bg);
}
.sandbox-input {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px;
}
.sandbox-field {
  display: grid;
  gap: 3px;
  font-size: 0.85rem;
  color: var(--muted);
}
.sandbox-field .inp { width: 100%; min-width: 0; }
.dia-sandbox-notice {
  color: var(--danger);
  font-size: 0.85rem;
}

.dia-rule { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; padding: 6px; border: 1px solid var(--panel-border); border-radius: var(--r-ctrl); }
.dia-rule-head { grid-column: 1 / -1; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 5px; align-items: center; }
.dia-rule-head label { white-space: nowrap; }
.dia-rule-field { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px; align-items: center; }
.dia-rule-field .inp { min-width: 0; }
.dia-rule-note { grid-column: 1 / -1; }
.dia-rule-empty { margin: 4px 0; }

.dia-left-body .param-sec { display: grid; gap: 9px; align-content: start; }
.dia-left-body .param-sec > .inp { width: 100%; min-width: 0; box-sizing: border-box; }
.dia-left-body .btn { min-height: 24px; height: auto; white-space: normal; }
.dia-library { display: grid; gap: 5px; color: var(--muted); }
.dia-left-body .param-sec > label.btn { justify-self: start; }

.chao-board { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.graph-legend, .field-pitch .graph-legend {
  display: flex;
  gap: 6px;
  padding: 5px 8px;
  align-items: center;
  justify-content: flex-start;
  font-weight: 650;
  font-size: 0.916667rem;
  white-space: nowrap;
  color: var(--text);
}
.graph-legend small { overflow: hidden; text-overflow: ellipsis; font-weight: 400; color: var(--muted); }
.graph-legend i { width: 14px; height: 3px; border-radius: 2px; background: var(--chart-series); flex: none; }
.field-pitch .graph-legend i { background: var(--chart-peer); }
.dia-f0-reset { margin-left: auto; flex: none; }

.field-pitch {
  position: relative;
  margin: 0;
  padding: 0;
  min-width: 0;
  min-height: 0;
}
.field-pitch svg {
  position: absolute;
  inset: 28px 4px 5px 48px;
  width: calc(100% - 52px);
  height: calc(100% - 33px);
  touch-action: none;
  cursor: crosshair;
}
.pitch-scale {
  position: absolute;
  inset: calc(28px + 8%) auto calc(5px + 8%) 6px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--muted);
}
</style>
