<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { F0_LIMIT_HZ, SAMPLE_RATE_HZ, TONIC_MIDI, type F0PinPoint, type F0PinSegment, type SongTonic } from '@vocalcut/core';
import { MAX_MIDI, MIN_MIDI, jianpuKeyLabel, midiHz, noteInRange, noteTranspositionLimits, type ArrangerTimeRange } from './arranger-edit';
import { INSTRUMENT_MIDI_RANGE } from './arranger-score';
import { validArrangerF0, type PitchTool } from './arranger-pitch';

import { gridSample, gridBeat, type NoteSpan, type BeatChange, type MeterChange } from './midi-score';

export type PianoKeyLabelMode = 'note' | 'jianpu' | 'hz';

export interface RollNote {
  eventId?: string;
  overlayColor?:string;
  overlayTrack?:string;
  velocity?: number;
  rowId: string;
  rowIndex: number;
  noteIndex: number;
  midi: number;
  startSmp: number;
  endSmp: number;
  char: string;
  dynamic: number;
  instrumental?: boolean;
  writtenBeats?: number;
}

export interface RollPhone {
  rowId: string;
  index: number;
  ipa: string;
  startSmp: number;
  endSmp: number;
  boundary?: { minSmp: number; maxSmp: number };
}

export interface SynthF0Point {
  t_smp: number;
  f0_hz: number;
}

const props = withDefaults(defineProps<{
  pencil?: boolean;
  verticalPencil?: boolean;
  rangeLyrics?: boolean;
  vocalRange?: boolean;
  ghostNotes?: readonly RollNote[];
  eventTrack?: boolean;
  locked?: boolean;
  division?: number;
  beatMap?: BeatChange[];
  meters?:MeterChange[];
  originSmp?: number;
  lyricTimes?: {id:string;text:string;start:number;end:number}[];
  pitchReference?: readonly { t_smp: number; f0_hz: number }[];
  referenceOrigin?: number;
  synthF0Points?: readonly SynthF0Point[];
  synthF0Kind?: 'actual' | 'preview';
  showSynthF0?: boolean;
  pitchTool?: PitchTool;
  pitchPins?: readonly F0PinSegment[];
  tonic?: SongTonic;
  rowHeight?: number;
  keyLabelMode?: PianoKeyLabelMode;
  notes: RollNote[];
  rests: { startSmp: number; endSmp: number }[];
  activeRow: string | null;
  activeNote: number;
  pxPerBeat: number;
  beatsPerMeasure?: 2 | 4;
  leadPixels: number;
  bpm: number;
  endSmp: number;
  playheadSmp: number | null;
  zoom: number;
  pressedMidi: number | null;
  hasInstruments?: boolean;
  cursorSmp?: number;
  selectedRange?: ArrangerTimeRange;
  gridBeats?: readonly number[];
  phones?: readonly RollPhone[];
}>(), {
  division:16, originSmp:0,
  tonic: 'C3',
  rowHeight: 24,
  beatsPerMeasure: 4,
  keyLabelMode: 'note',
  showSynthF0: true,
  synthF0Kind: 'preview',
  pitchTool: 'notes',
});

const emit = defineEmits<{
  select: [rowId: string, note: number];
  pitch: [rowId: string, note: number, midi: number];
  createNotes: [notes:NoteSpan[]];
  assignLyrics:[ids:string[]];
  changeEvent: [id:string,midi:number,start:number,end:number];
  removeEvent: [id:string];
  transpose: [semitones: number];
  voiceControls: [rowId: string, noteIndex: number, anchor: HTMLButtonElement];
  duration: [rowId: string, note: number, beats: number];
  strike: [midi: number, assign: boolean];
  drawPitch: [points: F0PinPoint[]];
  erasePitch: [startSmp: number, endSmp: number];
  cursor: [sample: number];
  range: [startSmp: number, endSmp: number];
  phoneBoundary: [rowId: string, index: number, sample: number];
  'update:zoom': [zoom: number];
  'update:rowHeight': [rowHeight: number];
  'update:keyLabelMode': [mode: PianoKeyLabelMode];
}>();

const KEY_W = 76;
const rulerH = computed(() => 24 + (props.lyricTimes?.length ? 18 : 0) + (props.phones?.length ? rowH.value : 0));
const black = new Set([1, 3, 6, 8, 10]);
const pitchNames = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (midi: number) => pitchNames[midi % 12] + (Math.floor(midi / 12) - 1);
const minMidi = computed(() => {
  const minimum=props.vocalRange ? MIN_MIDI : props.eventTrack ? 0 : props.hasInstruments ? INSTRUMENT_MIDI_RANGE[0] : MIN_MIDI;
  return props.ghostNotes?.reduce((low,n)=>Math.min(low,n.midi),minimum) ?? minimum;
});
const maxMidi = computed(() => {
  const maximum=props.vocalRange ? MAX_MIDI : props.eventTrack ? 127 : props.hasInstruments ? INSTRUMENT_MIDI_RANGE[1] : MAX_MIDI;
  return props.ghostNotes?.reduce((high,n)=>Math.max(high,n.midi),maximum) ?? maximum;
});
const keys = computed(() => Array.from({ length: maxMidi.value - minMidi.value + 1 }, (_, i) => maxMidi.value - i));

const keyModes: ReadonlyArray<{ id: PianoKeyLabelMode; short: string; title: string }> = [
  { id: 'note', short: '音名', title: '音名刻度 (C4, D4, E4…)' },
  { id: 'jianpu', short: '简谱', title: '首调简谱刻度 (按 1 = 主音实时换算)' },
  { id: 'hz', short: '频率', title: '十二平均律精确频率 (Hz)' },
];

const rowH = computed(() => Math.max(14, Math.min(42, Math.round(props.rowHeight || 24))));
const bodyHeight = computed(() => keys.value.length * rowH.value);
const scroller = ref<HTMLDivElement>();
const width = ref(700);
const drag = ref<{
  note: RollNote;
  x: number;
  y: number;
  midi: number;
  beats: number;
  startBeats: number;
  eventStart: number;
  eventEnd: number;
  scale: number;
  pointer: number;
  resize: boolean;
  group: boolean;
  semitones: number;
} | null>(null);
let observer: ResizeObserver | undefined;

const samplesPerBeat = computed(() => (SAMPLE_RATE_HZ * 60) / props.bpm);
const x = (sample: number) => (sample / samplesPerBeat.value) * props.pxPerBeat;
const y = (midi: number) => (maxMidi.value - midi) * rowH.value;
const midiAtHz = (hz: number) => 69 + 12 * Math.log2(hz / 440);
const pitchY = (hz: number) => y(midiAtHz(hz)) + rowH.value / 2;

const pitchGesture = ref<{
  pointer: number;
  tool: 'draw' | 'erase';
  points: F0PinPoint[];
  fromSmp: number;
  toSmp: number;
} | null>(null);
watch(() => props.pitchTool, () => { pitchGesture.value = null; });

function pitchStrokePath(points: readonly F0PinPoint[]) {
  return points.map(({ t_smp, f0_hz }, index) => `${index ? 'L' : 'M'}${x(t_smp).toFixed(2)} ${pitchY(f0_hz).toFixed(2)}`).join(' ');
}

const draftPitchPath = computed(() => (props.pitchPins ?? []).map(pin => pitchStrokePath(pin.points)).join(' '));
const gesturePitchPath = computed(() => pitchStrokePath(pitchGesture.value?.points ?? []));
const eraseRange = computed(() => {
  const gesture = pitchGesture.value;
  if (gesture?.tool !== 'erase') return undefined;
  const halfWidthSmp = Math.ceil(samplesPerBeat.value * 4 / props.pxPerBeat);
  return {
    startSmp: Math.max(0, Math.min(gesture.fromSmp, gesture.toSmp) - halfWidthSmp),
    endSmp: Math.min(props.endSmp, Math.max(gesture.fromSmp, gesture.toSmp) + halfWidthSmp),
  };
});
const rangeDrag = ref<{ pointer: number; x: number; moved: boolean; startSmp: number; endSmp: number }>();
const rollRange = computed(() => {
  const range = rangeDrag.value?.moved ? rangeDrag.value : props.selectedRange;
  return range && {
    startSmp: Math.min(range.startSmp, range.endSmp),
    endSmp: Math.max(range.startSmp, range.endSmp),
  };
});
const rangeLimits = computed(() => noteTranspositionLimits(props.notes.filter(note => noteInRange(note, props.selectedRange))));
const phoneDrag = ref<{ pointer: number; rowId: string; index: number; sample: number }>();
const sampleOn = (event: PointerEvent | MouseEvent, element: HTMLElement) =>
  Math.max(0, Math.min(props.endSmp, Math.round(
    (event.clientX - element.getBoundingClientRect().left) * element.offsetWidth /
    Math.max(1, element.getBoundingClientRect().width) * samplesPerBeat.value / props.pxPerBeat,
  )));

function movePhoneBoundary(event: PointerEvent, phone: RollPhone, finish = false) {
  const field = phone.boundary;
  const handle = event.currentTarget as HTMLElement;
  if (!field || !handle.parentElement) return;
  const sample = Math.max(field.minSmp, Math.min(field.maxSmp, sampleOn(event, handle.parentElement)));
  if (event.type === 'pointerdown') handle.setPointerCapture(event.pointerId);
  else if (phoneDrag.value?.pointer !== event.pointerId) return;
  if (finish) {
    phoneDrag.value = undefined;
    emit('phoneBoundary', phone.rowId, phone.index, sample);
  } else phoneDrag.value = { pointer: event.pointerId, rowId: phone.rowId, index: phone.index, sample };
}

function nudgePhoneBoundary(phone: RollPhone, direction: number) {
  if (!phone.boundary) return;
  emit('phoneBoundary', phone.rowId, phone.index, Math.max(phone.boundary.minSmp,
    Math.min(phone.boundary.maxSmp, phone.startSmp + direction * SAMPLE_RATE_HZ / 200)));
}

function gridCoordinates(event: PointerEvent, grid: HTMLElement) {
  const rect = grid.getBoundingClientRect();
  const px = (event.clientX - rect.left) * grid.offsetWidth / Math.max(1, rect.width);
  const py = (event.clientY - rect.top) * grid.offsetHeight / Math.max(1, rect.height);
  return {
    t_smp: Math.round(px * samplesPerBeat.value / props.pxPerBeat),
    f0_hz: midiHz(maxMidi.value + 0.5 - py / rowH.value),
  };
}

function beginRange(event: PointerEvent) {
  if (event.button !== 0 || rangeDrag.value || !props.endSmp) return;
  const lane = event.currentTarget as HTMLElement;
  event.preventDefault();
  lane.setPointerCapture(event.pointerId);
  const sample = sampleOn(event, lane);
  rangeDrag.value = { pointer: event.pointerId, x: event.clientX, moved: false, startSmp: sample, endSmp: sample };
}

const beatMap = computed(() => props.beatMap ?? [{beat:0,sample:props.originSmp,samplesPerBeat:samplesPerBeat.value}]);
const gridStep = computed(() => 4/props.division);
const snapIndex = (sample:number) => Math.max(0,Math.round(gridBeat(sample,beatMap.value)/gridStep.value));
const atIndex = (index:number) => gridSample(index*gridStep.value,beatMap.value);
interface PencilGesture {
  pointer:number; midi:number; first:number; last:number; cells:Map<number,number>;
}
const pencilDrag = ref<PencilGesture>();
const pencilSpans = computed<NoteSpan[]>(() => {
  const drag=pencilDrag.value;
  if (!drag) return [];
  const lo=Math.min(drag.first,drag.last), hi=Math.max(lo+1,drag.first,drag.last);
  if (!props.verticalPencil) return [{midi:drag.midi,startSmp:atIndex(lo),endSmp:atIndex(hi)}];
  const notes:NoteSpan[]=[];
  for (let cell=lo;cell<hi;cell++) {
    const midi=drag.cells.get(cell) ?? drag.midi;
    const previous=notes.at(-1);
    if(previous?.midi===midi) previous.endSmp=atIndex(cell+1);
    else notes.push({midi,startSmp:atIndex(cell),endSmp:atIndex(cell+1)});
  }
  return notes;
});
watch(()=>[props.pencil,props.verticalPencil,props.locked,props.division,props.beatMap],()=>{pencilDrag.value=undefined;});
type SelectionCorner={sample:number; midi:number};
const lyricBox=ref<{pointer:number;start:SelectionCorner;end:SelectionCorner}>();
function selectionCorner(event:PointerEvent, grid:HTMLElement):SelectionCorner {
  const point=gridCoordinates(event,grid);
  return {sample:point.t_smp,midi:Math.round(midiAtHz(point.f0_hz))};
}
const boxBounds=computed(()=>{
  const b=lyricBox.value;
  if(b) return {left:Math.min(b.start.sample,b.end.sample),right:Math.max(b.start.sample,b.end.sample)+1,
    low:Math.min(b.start.midi,b.end.midi),high:Math.max(b.start.midi,b.end.midi)};
});
watch(()=>[props.rangeLyrics,props.locked,props.notes],()=>{lyricBox.value=undefined;});
function beginPitchGesture(event: PointerEvent) {
  if (event.button !== 0 || pitchGesture.value) return;
  const grid = event.currentTarget as HTMLElement;
  if (props.rangeLyrics && !props.locked) {
    const start=selectionCorner(event,grid);
    grid.setPointerCapture(event.pointerId);
    event.preventDefault();
    lyricBox.value={pointer:event.pointerId,start,end:start};
    return;
  }
  if (props.pencil && !props.locked && !event.shiftKey && !(event.target as HTMLElement).closest('.roll-note')) {
    const point=gridCoordinates(event,grid);
    const first=snapIndex(point.t_smp);
    const midi=Math.max(minMidi.value,Math.min(maxMidi.value,Math.round(midiAtHz(point.f0_hz))));
    grid.setPointerCapture(event.pointerId);
    event.preventDefault();
    pencilDrag.value={pointer:event.pointerId,midi,first,last:first,cells:new Map([[first,midi]])};
    return;
  }
  if (props.locked || props.pitchTool === 'notes' || props.pitchTool === 'range') {
    if (event.shiftKey || !(event.target as HTMLElement).closest('.roll-note')) beginRange(event);
    return;
  }
  const { t_smp, f0_hz } = gridCoordinates(event, grid);
  if (t_smp < 0 || t_smp >= props.endSmp || (props.pitchTool === 'draw' && !validArrangerF0(f0_hz).ok)) return;
  event.preventDefault();
  grid.setPointerCapture(event.pointerId);
  pitchGesture.value = { pointer: event.pointerId, tool: props.pitchTool, fromSmp: t_smp, toSmp: t_smp, points: [] };
  movePitchGesture(event);
}

function movePitchGesture(event: PointerEvent) {
  if(lyricBox.value?.pointer===event.pointerId) {lyricBox.value.end=selectionCorner(event,event.currentTarget as HTMLElement);return;}
  if (pencilDrag.value?.pointer===event.pointerId) {
    const drag=pencilDrag.value;
    const grid=event.currentTarget as HTMLElement;
    const events=event.getCoalescedEvents?.() ?? [];
    for (const point of [...events,event]) {
      const {t_smp,f0_hz}=gridCoordinates(point,grid);
      const index=snapIndex(t_smp);
      if (props.verticalPencil) {
        const midi=Math.max(minMidi.value,Math.min(maxMidi.value,Math.round(midiAtHz(f0_hz))));
        const from=drag.last, to=index;
        for(let i=Math.min(from,to);i<Math.max(from,to);i++) drag.cells.set(i,drag.midi);
        // A vertical move on a boundary chooses the pitch of the next time cell.
        drag.midi=midi;
        drag.cells.set(index,midi);
      }
      drag.last=index;
    }
    return;
  }
  if (rangeDrag.value?.pointer === event.pointerId) {
    rangeDrag.value.moved ||= Math.abs(event.clientX - rangeDrag.value.x) >= 4;
    rangeDrag.value.endSmp = sampleOn(event, event.currentTarget as HTMLElement);
    return;
  }
  const gesture = pitchGesture.value;
  if (!gesture || gesture.pointer !== event.pointerId) return;
  const grid = event.currentTarget as HTMLElement;
  if (gesture.tool === 'erase') {
    const { t_smp } = gridCoordinates(event, grid);
    gesture.toSmp = Math.max(0, Math.min(props.endSmp, t_smp));
    return;
  }
  const coalesced = event.getCoalescedEvents?.() ?? [];
  for (const pointEvent of coalesced.length ? coalesced : [event]) {
    const point = gridCoordinates(pointEvent, grid);
    if (point.t_smp >= 0 && point.t_smp < props.endSmp && validArrangerF0(point.f0_hz).ok) gesture.points.push(point);
  }
}

function releasePitchGesture(event: PointerEvent) {
  if(lyricBox.value?.pointer===event.pointerId) {
    movePitchGesture(event);
    const b=boxBounds.value!;
    const hits=props.notes.filter(n=>n.eventId && n.startSmp<b.right && n.endSmp>b.left && n.midi>=b.low && n.midi<=b.high);
    lyricBox.value=undefined;
    emit('assignLyrics',hits.map(n=>n.eventId!));
    return;
  }
  if (pencilDrag.value?.pointer===event.pointerId) {
    movePitchGesture(event);
    const spans=pencilSpans.value;
    pencilDrag.value=undefined;
    if(spans.length && !props.locked) emit('createNotes',spans);
    return;
  }
  if (rangeDrag.value?.pointer === event.pointerId) {
    movePitchGesture(event);
    const { startSmp, endSmp, moved } = rangeDrag.value;
    rangeDrag.value = undefined;
    if (moved && startSmp !== endSmp) emit('range', Math.min(startSmp, endSmp), Math.max(startSmp, endSmp));
    else emit('cursor', endSmp);
    return;
  }
  const gesture = pitchGesture.value;
  if (!gesture || gesture.pointer !== event.pointerId) return;
  movePitchGesture(event);
  if (eraseRange.value) emit('erasePitch', eraseRange.value.startSmp, eraseRange.value.endSmp);
  if (gesture.points.length) emit('drawPitch', gesture.points);
  pitchGesture.value = null;
}

function cancelPitchGesture(event: PointerEvent) {
  if(lyricBox.value?.pointer===event.pointerId) lyricBox.value=undefined;
  if (pencilDrag.value?.pointer===event.pointerId) pencilDrag.value=undefined;
  if (pitchGesture.value?.pointer === event.pointerId) pitchGesture.value = null;
  if (rangeDrag.value?.pointer === event.pointerId) rangeDrag.value = undefined;
}

function isTonicDegree(midi: number): boolean {
  return ((midi - TONIC_MIDI[props.tonic]) % 12 + 12) % 12 === 0;
}

function keyDisplayLabel(midi: number): string {
  if (props.keyLabelMode === 'jianpu') {
    return jianpuKeyLabel(midi, props.tonic);
  }
  if (props.keyLabelMode === 'hz') {
    const hz = midiHz(midi).toFixed(1);
    return black.has(midi % 12) ? hz : `${hz} Hz`;
  }
  return noteName(midi);
}

function keyTooltip(midi: number): string {
  return `${noteName(midi)} · 简谱 ${jianpuKeyLabel(midi, props.tonic)} (1=${props.tonic}) · ${midiHz(midi).toFixed(1)} Hz`;
}

const referencePath = computed(() => {
  let previous = -Infinity;
  return (props.pitchReference ?? [])
    .filter(({ f0_hz }) => Number.isFinite(f0_hz) && f0_hz >= F0_LIMIT_HZ.min && f0_hz <= F0_LIMIT_HZ.max)
    .map(({ t_smp, f0_hz }) => {
      const cmd = t_smp - previous > 480 ? 'M' : 'L';
      previous = t_smp;
      const midi = midiAtHz(f0_hz);
      return `${cmd}${x(t_smp - (props.referenceOrigin ?? 0)).toFixed(2)} ${(y(midi) + rowH.value / 2).toFixed(2)}`;
    })
    .join(' ');
});

function buildSmoothSegmentPath(pts: ReadonlyArray<{ px: number; py: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].px.toFixed(2)} ${pts[0].py.toFixed(2)}`;
  if (pts.length === 2) {
    return `M${pts[0].px.toFixed(2)} ${pts[0].py.toFixed(2)} L${pts[1].px.toFixed(2)} ${pts[1].py.toFixed(2)}`;
  }
  const cmds = [`M${pts[0].px.toFixed(2)} ${pts[0].py.toFixed(2)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.px + (p2.px - p0.px) / 6;
    const c1y = p1.py + (p2.py - p0.py) / 6;
    const c2x = p2.px - (p3.px - p1.px) / 6;
    const c2y = p2.py - (p3.py - p1.py) / 6;
    cmds.push(`C${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.px.toFixed(2)} ${p2.py.toFixed(2)}`);
  }
  return cmds.join(' ');
}

const synthF0Path = computed(() => {
  if (!props.showSynthF0 || !props.synthF0Points?.length) return '';
  const maxGapSmp = 1440; // >30 ms gap splits voiced phrases cleanly across rests / voiceless stops
  const segments: Array<Array<{ px: number; py: number }>> = [];
  let current: Array<{ px: number; py: number }> = [];
  let prevSmp = -Infinity;

  for (const { t_smp, f0_hz } of props.synthF0Points) {
    if (!Number.isFinite(f0_hz) || f0_hz < F0_LIMIT_HZ.min || f0_hz > F0_LIMIT_HZ.max) {
      if (current.length) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    if (t_smp - prevSmp > maxGapSmp && current.length) {
      segments.push(current);
      current = [];
    }
    prevSmp = t_smp;
    const midi = midiAtHz(f0_hz);
    current.push({
      px: x(t_smp),
      py: y(midi) + rowH.value / 2,
    });
  }
  if (current.length) segments.push(current);
  return segments.map(buildSmoothSegmentPath).filter(Boolean).join(' ');
});

function currentDrag(note: RollNote) {
  const active = drag.value;
  return active?.note.rowId === note.rowId && active.note.noteIndex === note.noteIndex ? active : null;
}

function displayedMidi(note: RollNote) {
  const active = drag.value;
  if (active?.group && noteInRange(note, props.selectedRange)) {
    const { min, max } = rangeLimits.value;
    return note.midi + Math.max(min, Math.min(max, active.semitones));
  }
  return currentDrag(note)?.midi ?? note.midi;
}

const rollWidth = computed(() => {
  const pageWidth = width.value - KEY_W;
  const end = x((props.ghostNotes ?? []).reduce((last,n)=>Math.max(last,n.endSmp),props.endSmp));
  return end > pageWidth ? end + pageWidth : Math.max(pageWidth, end + props.pxPerBeat * 1.5);
});
const measureWidth = computed(() => props.pxPerBeat * props.beatsPerMeasure);
const measures = computed(() => Math.max(1, Math.ceil((rollWidth.value - props.leadPixels) / measureWidth.value)));
const expressiveBeats = computed(() => (props.gridBeats ?? []).map((sample, beat) => ({
  x: x(sample), measure: beat % props.beatsPerMeasure === 0,
})));
const eventMeasures = computed(() => {
  if (!props.eventTrack) return [];
  const endBeat=gridBeat(rollWidth.value*samplesPerBeat.value/props.pxPerBeat,beatMap.value);
  const meters=props.meters ?? [{beat:0,numerator:props.beatsPerMeasure,denominator:4}];
  const labels:number[]=[];
  for(const [i,meter] of meters.entries()) {
    const limit=Math.min(endBeat,meters[i+1]?.beat ?? Infinity);
    const length=meter.numerator*4/meter.denominator;
    for(let b=meter.beat; b<limit && labels.length<20000; b+=length) labels.push(x(gridSample(b,beatMap.value)));
  }
  return labels;
});
const measureLabels = computed(() => props.eventTrack ? eventMeasures.value
  : props.gridBeats
  ? expressiveBeats.value.filter(beat => beat.measure).map(beat => beat.x)
  : Array.from({ length: measures.value }, (_, index) => props.leadPixels + index * measureWidth.value));

watch(() => props.playheadSmp, sample => {
  const element = scroller.value;
  if (sample === null || !element) return;
  const pageWidth = element.clientWidth - KEY_W;
  if (pageWidth <= 0) return;
  const position = x(sample);
  if (position >= element.scrollLeft + pageWidth || position < element.scrollLeft) {
    element.scrollLeft = position;
  }
});

function centerPitch(midi?: number) {
  const element = scroller.value;
  if (element) {
    element.scrollTop = Math.max(0, y(midi ?? props.notes[0]?.midi ?? 57) - (element.clientHeight - rulerH.value) / 2);
  }
}

onMounted(() => {
  const target = scroller.value;
  if (!target) return;
  observer = new ResizeObserver(() => { width.value = target.clientWidth; });
  observer.observe(target);
  centerPitch();
});
onBeforeUnmount(() => observer?.disconnect());

function zoomAt(event: WheelEvent) {
  const element = scroller.value;
  if (!element) return;

  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const scale = rect.height / Math.max(1, element.offsetHeight);
    const inViewY = Math.max(0, (event.clientY - rect.top) / scale - rulerH.value);
    const beforeY = element.scrollTop + inViewY;
    const prevH = rowH.value;
    const delta = event.deltaY < 0 ? 2 : -2;
    const nextH = Math.max(14, Math.min(42, prevH + delta));
    if (nextH !== prevH) {
      emit('update:rowHeight', nextH);
      void nextTick(() => {
        element.scrollTop = Math.max(0, (beforeY * nextH) / prevH - inViewY);
      });
    }
    return;
  }

  if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.deltaX) {
    event.preventDefault();
    element.scrollLeft += event.deltaY;
    return;
  }

  if (!(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  const rect = element.getBoundingClientRect();
  const scale = rect.width / Math.max(1, element.offsetWidth);
  const inView = Math.max(0, (event.clientX - rect.left) / scale - KEY_W);
  const before = element.scrollLeft + inView;
  const factor = Math.exp(-Math.max(-160, Math.min(160, event.deltaY)) * 0.004);
  const previous = props.zoom;
  const next = Math.max(0.3, Math.min(6, previous * factor));
  emit('update:zoom', next);
  void nextTick(() => { element.scrollLeft = (before * next) / previous - inView; });
}

function selectNote(event: PointerEvent, note: RollNote) {
  if (event.button !== 0 || event.shiftKey) return;
  if (props.locked) {emit('select',note.rowId,note.noteIndex); return;}
  const button = event.currentTarget as HTMLButtonElement;
  const startBeats = note.writtenBeats ?? (note.endSmp - note.startSmp) / samplesPerBeat.value;
  const group = !props.eventTrack && noteInRange(note, props.selectedRange);
  const resize = !group && (event.target as HTMLElement).classList.contains('note-end');
  drag.value = {
    note,
    x: event.clientX,
    y: event.clientY,
    midi: note.midi,
    beats: startBeats,
    startBeats, eventStart:note.startSmp,eventEnd:note.endSmp,
    scale: button.getBoundingClientRect().height / Math.max(1, button.offsetHeight),
    pointer: event.pointerId,
    resize,
    group,
    semitones: 0,
  };
  button.setPointerCapture(event.pointerId);
  emit('select', note.rowId, note.noteIndex);
}

function moveNote(event: PointerEvent) {
  const active = drag.value;
  if (!active || active.pointer !== event.pointerId) return;
  if (active.note.eventId) {
    const dx=(event.clientX-active.x)/active.scale;
    const delta=dx*samplesPerBeat.value/props.pxPerBeat;
    const n=active.note;
    if (Math.abs(dx)>=3 && active.resize) {
      const minEnd=gridSample(gridBeat(n.startSmp,beatMap.value)+gridStep.value,beatMap.value);
      active.eventEnd=Math.max(minEnd,atIndex(snapIndex(n.endSmp+delta)));
    } else if (Math.abs(dx)>=3) {
      active.eventStart=atIndex(snapIndex(n.startSmp+delta));
      active.eventEnd=active.eventStart+n.endSmp-n.startSmp;
    } else {active.eventStart=n.startSmp;active.eventEnd=n.endSmp;}
    if (!active.resize) active.midi=Math.max(0,Math.min(127,n.midi+Math.round((active.y-event.clientY)/(rowH.value*active.scale))));
    return;
  }
  if (active.resize) {
    const change = Math.round(((event.clientX - active.x) * 16) / (props.pxPerBeat * active.scale)) / 16;
    active.beats = change === 0 ? active.startBeats : Math.max(1 / 16, active.startBeats + change);
  } else {
    const delta = Math.round((active.y - event.clientY) / (rowH.value * active.scale));
    if (active.group) active.semitones = delta;
    else {
      const [min, max] = active.note.instrumental ? INSTRUMENT_MIDI_RANGE : [MIN_MIDI, MAX_MIDI];
      active.midi = Math.max(min, Math.min(max, active.note.midi + delta));
    }
  }
}

function releaseNote(event: PointerEvent) {
  if (!drag.value || drag.value.pointer !== event.pointerId) return;
  moveNote(event);
  const { note, midi, beats, startBeats, group, semitones,eventStart,eventEnd } = drag.value;
  drag.value = null;
  if (note.eventId) {
    if (!props.locked && (midi!==note.midi || eventStart!==note.startSmp || eventEnd!==note.endSmp)) emit('changeEvent',note.eventId,midi,eventStart,eventEnd);
    else if(!props.locked) emit('voiceControls',note.rowId,note.noteIndex,event.currentTarget as HTMLButtonElement);
    return;
  }
  if (group && semitones) emit('transpose', semitones);
  else if (note.midi !== midi) emit('pitch', note.rowId, note.noteIndex, midi);
  else if (beats !== startBeats) emit('duration', note.rowId, note.noteIndex, beats);
  else if (note.instrumental) emit('strike', midi, false);
  else emit('voiceControls', note.rowId, note.noteIndex, event.currentTarget as HTMLButtonElement);
}

function nudgeNotePitch(note: RollNote, semitones: number) {
  if (noteInRange(note, props.selectedRange)) {
    emit('transpose', semitones);
    return;
  }
  const { min, max } = noteTranspositionLimits([note]);
  if (semitones >= min && semitones <= max) emit('pitch', note.rowId, note.noteIndex, note.midi + semitones);
}

function prepareNoteAudition(event: KeyboardEvent, note: RollNote) {
  if (event.isComposing || event.keyCode === 229 || event.repeat) return;
  emit('select', note.rowId, note.noteIndex);
  if (note.instrumental) {
    event.preventDefault();
    emit('strike', note.midi, false);
  }
}

function revealTransposedNotes(notes: readonly RollNote[], semitones: number) {
  const element = scroller.value;
  if (!element) return;
  const width = element.clientWidth - KEY_W;
  const height = element.clientHeight - rulerH.value;
  const withinView = notes.filter(note => x(note.startSmp) < element.scrollLeft + width && x(note.endSmp) > element.scrollLeft);
  const visiblePitch = (midi: number) => y(midi) < element.scrollTop + height && y(midi) + rowH.value > element.scrollTop;
  if (withinView.some(note => visiblePitch(note.midi + semitones))) return;
  const anchor = withinView.find(note => visiblePitch(note.midi)) ?? withinView[0] ?? notes[0];
  if (anchor) centerPitch(anchor.midi + semitones);
}

function showRow(rowId: string) {
  const element = scroller.value;
  const note = props.notes.find(item => item.rowId === rowId);
  if (!element || !note) return;
  const start = x(note.startSmp);
  const end = x(note.endSmp);
  const visible = element.clientWidth - KEY_W;
  if (start < element.scrollLeft + 8 || end > element.scrollLeft + visible - 8) {
    element.scrollLeft = Math.max(0, start - 18);
  }
  const top = y(note.midi);
  if (top < element.scrollTop || top + rowH.value > element.scrollTop + element.clientHeight - rulerH.value) {
    centerPitch(note.midi);
  }
}

defineExpose({ showRow, centerPitch, revealTransposedNotes });
</script>

<template>
  <div ref="scroller" class="piano-scroll" :class="{ compact: rowH < 19, 'hz-mode': keyLabelMode === 'hz' }" aria-label="钢琴卷帘" tabindex="0" @wheel="zoomAt">
    <div
      class="piano-layout"
      :class="{ 'expressive-grid': !!gridBeats || eventTrack, 'note-pencil':pencil }"
      :style="{
        '--key-width': KEY_W + 'px',
        '--key-height': rowH + 'px',
        '--ruler-height': rulerH + 'px',
        '--beat-width': pxPerBeat + 'px',
        '--measure-width': measureWidth + 'px',
        '--first-beat': leadPixels + 'px',
        width: KEY_W + rollWidth + 'px',
      }"
    >
      <div class="piano-corner">
        <div class="corner-caption">琴键 · 小节</div>
        <div class="key-mode-pills" role="group" aria-label="琴键刻度切换">
          <button
            v-for="mode in keyModes"
            :key="mode.id"
            type="button"
            class="key-mode-pill"
            :class="{ active: keyLabelMode === mode.id }"
            :aria-pressed="keyLabelMode === mode.id"
            :title="mode.title"
            @click="emit('update:keyLabelMode', mode.id)"
          >
            {{ mode.short }}
          </button>
        </div>
      </div>
      <div class="piano-ruler" :aria-label="`时间标尺，每小节 ${beatsPerMeasure} 拍`" title="点击跳播，横向拖动选段"
        @pointerdown="beginRange" @pointermove="movePitchGesture" @pointerup="releasePitchGesture"
        @pointercancel="cancelPitchGesture" @lostpointercapture="cancelPitchGesture">
        <i v-for="(beat, index) in expressiveBeats" :key="index" class="tempo-beat" :class="{ measure: beat.measure }" :style="{ left: beat.x + 'px' }" />
        <span v-for="(position, index) in measureLabels" :key="index" :style="{ left: position + 'px' }">{{ index + 1 }}</span>
        <div v-if="lyricTimes?.length" class="sung-tier" aria-label="实际演唱字界">
          <div v-for="word in lyricTimes" :key="word.id" class="phone-span" :style="{left:x(word.start)+'px',width:x(word.end-word.start)+'px'}" :title="'演唱字界 · '+word.text">{{word.text}}</div>
        </div>
        <div v-if="phones?.length" class="phone-tier" aria-label="音素" @click.stop>
          <div v-for="phone in phones" :key="phone.rowId + ':' + phone.index" class="phone-span"
            :style="{ left: x(phone.startSmp) + 'px', width: Math.max(1, x(phone.endSmp - phone.startSmp)) + 'px' }"
            :title="phone.ipa" translate="no">{{ phone.ipa }}</div>
          <button v-for="phone in phones.filter(item => item.boundary)" :key="'boundary:' + phone.rowId + ':' + phone.index"
            class="phone-boundary" type="button" :aria-label="'音素边界 ' + phone.ipa"
            :style="{ left: x(phoneDrag?.rowId === phone.rowId && phoneDrag.index === phone.index ? phoneDrag.sample : phone.startSmp) + 'px' }"
            @pointerdown.stop="movePhoneBoundary($event, phone)"
            @pointermove="movePhoneBoundary($event, phone)"
            @pointerup.stop="movePhoneBoundary($event, phone, true)"
            @lostpointercapture="phoneDrag = undefined"
            @keydown.left.prevent="nudgePhoneBoundary(phone, -1)"
            @keydown.right.prevent="nudgePhoneBoundary(phone, 1)" />
        </div>
      </div>
      <div class="piano-keys">
        <div v-for="midi in keys" :key="midi" class="key-slot">
          <button
            type="button"
            class="piano-key"
            :class="{
              black: black.has(midi % 12),
              pressed: midi === pressedMidi,
              'is-tonic': keyLabelMode === 'jianpu' && isTonicDegree(midi),
            }"
            :title="keyTooltip(midi)"
            :data-midi="midi"
            :aria-label="keyTooltip(midi)"
            @click="emit('strike', midi, true)"
          >
            <span>{{ keyDisplayLabel(midi) }}</span>
          </button>
        </div>
      </div>
      <div
        class="piano-grid"
        :class="{ 'pitch-draw': pitchTool === 'draw', 'pitch-erase': pitchTool === 'erase', 'range-tool': pitchTool === 'range', 'lyric-selection-tool':rangeLyrics }"
        :style="{ height: bodyHeight + 'px' }"
        @pointerdown="beginPitchGesture"
        @pointermove="movePitchGesture"
        @pointerup="releasePitchGesture"
        @pointercancel="cancelPitchGesture"
        @lostpointercapture="cancelPitchGesture"
      >
        <i v-for="left in eventMeasures" :key="'bar:'+left" class="tempo-beat measure" :style="{left:left+'px'}" />
        <template v-if="eventTrack"><i v-for="(section,i) in beatMap" :key="i" class="note-grid-lines" :style="{left:x(section.sample)+'px', width:Math.max(0,(beatMap[i+1]?x(beatMap[i+1].sample):rollWidth)-x(section.sample))+'px', backgroundSize:x(section.samplesPerBeat*gridStep)+'px 100%',backgroundPositionX:-x((section.beat % gridStep)*section.samplesPerBeat)+'px'}" /></template>
        <div v-for="n in ghostNotes" :key="'ghost:'+(n.overlayTrack ?? '')+':'+n.rowId+':'+n.noteIndex" class="ghost-note" aria-hidden="true"
          :style="{background:n.overlayColor,left:x(n.startSmp)+'px',top:y(n.midi)+2+'px',width:x(n.endSmp-n.startSmp)+'px',height:(rowH-4)+'px'}" />
        <i v-if="boxBounds" class="lyric-box" :style="{left:x(boxBounds.left)+'px',width:Math.max(2,x(boxBounds.right-boxBounds.left))+'px',top:y(boxBounds.high)+'px',height:(boxBounds.high-boxBounds.low+1)*rowH+'px'}" />
        <div v-for="n in pencilSpans" :key="n.startSmp" class="roll-note pencil-preview" :style="{left:x(n.startSmp)+'px',width:x(n.endSmp-n.startSmp)+'px',top:y(n.midi)+'px'}"></div>
        <i v-for="(beat, index) in expressiveBeats" :key="'beat:' + index" class="tempo-beat" :class="{ measure: beat.measure }" :style="{ left: beat.x + 'px' }" />
        <div
          v-for="midi in keys"
          :key="midi"
          class="key-guide"
          :class="{
            dark: black.has(midi % 12),
            octave: midi % 12 === 0,
            'tonic-guide': keyLabelMode === 'jianpu' && isTonicDegree(midi),
          }"
          :style="{ top: y(midi) + 'px' }"
        />
        <svg v-if="referencePath" class="pitch-reference" :width="rollWidth" :height="bodyHeight" role="img" aria-label="原音频 F0 参考曲线">
          <path :d="referencePath" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="4 3" />
        </svg>
        <div
          v-for="rest in rests"
          :key="rest.startSmp"
          class="piano-rest"
          :style="{ left: x(rest.startSmp) + 'px', width: Math.max(1, x(rest.endSmp - rest.startSmp)) + 'px' }"
          title="休止"
        />
        <button
          v-for="note in notes"
          :key="note.eventId ?? note.rowId + '-' + note.noteIndex"
          type="button"
          class="roll-note"
          :class="{
            selected: note.rowId === activeRow,
            current: note.rowId === activeRow && note.noteIndex === activeNote,
            'range-selected': noteInRange(note, rollRange),
          }"
          :data-row="note.rowIndex"
          :data-note="note.noteIndex"
          :data-midi="note.midi"
          :data-arranger-syllable-target="note.instrumental ? undefined : ''"
          :tabindex="pitchTool === 'notes' || (pitchTool === 'range' && noteInRange(note, selectedRange)) ? undefined : -1"
          :aria-description="noteInRange(note, rollRange) ? '已选中，上下拖动或按方向键可整体移调' : undefined"
          :title="`${note.char} · ${noteName(note.midi)} (${jianpuKeyLabel(note.midi, tonic)}) · ${midiHz(note.midi).toFixed(1)} Hz · ${(note.startSmp / SAMPLE_RATE_HZ).toFixed(3)} 秒${noteInRange(note, rollRange) ? ' · 已选中' : ''}`"
          :style="{
            left: x(currentDrag(note)?.eventStart ?? note.startSmp) + 'px',
            top: y(displayedMidi(note)) + (rowH < 18 ? 1.5 : 2.5) + 'px',
            width: Math.max(2, note.eventId && currentDrag(note) ? x(currentDrag(note)!.eventEnd-currentDrag(note)!.eventStart) : currentDrag(note)?.resize ? currentDrag(note)!.beats * pxPerBeat : x(note.endSmp - note.startSmp)) + 'px',
          }"
          @pointerdown="selectNote($event, note)"
          @pointermove="moveNote"
          @pointerup="releaseNote"
          @pointercancel="drag = null"
          @lostpointercapture="drag = null"
          @keydown.delete.prevent="!locked && note.eventId && emit('removeEvent',note.eventId)"
          @keydown.enter.prevent="emit('select', note.rowId, note.noteIndex); note.instrumental && !note.eventId ? emit('strike', note.midi, false) : emit('voiceControls', note.rowId, note.noteIndex, $event.currentTarget as HTMLButtonElement)"
          @keydown.space.exact="prepareNoteAudition($event, note)"
          @keydown.up.prevent="nudgeNotePitch(note, 1)"
          @keydown.down.prevent="nudgeNotePitch(note, -1)"
        >
          <span>{{ note.char }}</span><span class="note-end" aria-hidden="true" />
        </button>
        <svg
          v-if="synthF0Path"
          class="synth-f0-overlay"
          :class="synthF0Kind === 'actual' ? 'is-actual' : 'is-preview'"
          :width="rollWidth"
          :height="bodyHeight"
          role="img"
          :aria-label="synthF0Kind === 'actual' ? '合成人声实际 50 Hz F0 曲线' : 'qTA 预览基频曲线'"
        >
          <path class="f0-halo" :d="synthF0Path" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          <path class="f0-stroke" :d="synthF0Path" fill="none" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-if="draftPitchPath || gesturePitchPath || eraseRange" class="pitch-edit-layer" :width="rollWidth" :height="bodyHeight" aria-hidden="true">
          <path v-if="draftPitchPath" class="pitch-edit-stroke" :d="draftPitchPath" />
          <path v-if="gesturePitchPath" class="pitch-edit-stroke gesture" :d="gesturePitchPath" />
          <rect v-if="eraseRange" class="pitch-erase-range" :x="x(eraseRange.startSmp)" :width="x(eraseRange.endSmp - eraseRange.startSmp)" :height="bodyHeight" />
        </svg>
        <div v-if="rollRange" class="roll-selection" :style="{ left: x(rollRange.startSmp) + 'px', width: x(rollRange.endSmp - rollRange.startSmp) + 'px' }" />
        <div v-if="playheadSmp !== null || cursorSmp" class="piano-playhead" :style="{ left: x(playheadSmp ?? cursorSmp ?? 0) + 'px' }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.piano-scroll {
  min-height: 0;
  min-width: 0;
  height: 100%;
  overflow: auto;
  overscroll-behavior: contain;
  border-radius: var(--r-panel, 10px);
  background: var(--panel);
}
.piano-layout {
  display: grid;
  grid-template-columns: var(--key-width) 1fr;
  grid-template-rows: var(--ruler-height) auto;
}
.piano-corner,
.piano-ruler {
  position: sticky;
  top: 0;
  color: var(--muted);
  background: color-mix(in srgb, var(--sidebar) 94%, var(--panel));
}
.piano-corner {
  left: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 2px 3px;
  border: 1px solid var(--border);
}
.corner-caption {
  font-size: 0.791667rem;
  line-height: 1.1;
  color: var(--muted);
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.key-mode-pills {
  display: inline-flex;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 4px;
  overflow: hidden;
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
}
.key-mode-pill {
  flex: 1 1 0;
  min-width: 0;
  height: 16px;
  padding: 0 1px;
  border: 0;
  border-right: 1px solid var(--border);
  background: transparent;
  color: var(--muted);
  font-size: 0.766667rem;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
}
.key-mode-pill:last-child {
  border-right: 0;
}
.key-mode-pill:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--selected) 65%, transparent);
}
.key-mode-pill.active {
  background: var(--accent);
  color: var(--on-accent, #ffffff);
  font-weight: 600;
}
.piano-ruler {
  z-index: 4;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
}
.piano-ruler span {
  position: absolute;
  z-index: 2;
  top: 11px;
  margin-left: 7px;
  font: 11.5px var(--font-mono, monospace);
}
.piano-ruler { cursor: crosshair; touch-action: none; user-select: none; }
.expressive-grid .piano-ruler::before,
.expressive-grid .piano-ruler::after,
.expressive-grid .piano-grid::before,
.expressive-grid .piano-grid::after { display: none; }
.tempo-beat {
  position: absolute;
  inset-block: 0;
  border-left: 1px dashed color-mix(in srgb, var(--text) 20%, transparent);
  pointer-events: none;
  z-index: 1;
}
.tempo-beat.measure {
  border-left-style: solid;
  border-left-color: color-mix(in srgb, var(--text) 28%, var(--panel));
}
.note-pencil .piano-grid { cursor:crosshair; }
.ghost-note {position:absolute;pointer-events:none;z-index:1;box-sizing:border-box;border:1px dashed var(--muted);background:var(--muted);opacity:.25;border-radius:4px;}
.pencil-preview {pointer-events:none;opacity:.6;}
.note-grid-lines {position:absolute;inset-block:0;pointer-events:none;z-index:1;background-image:linear-gradient(to right,var(--border) 1px,transparent 1px);mask-image:repeating-linear-gradient(to bottom,black 0 3px,transparent 3px 6px);}
.lyric-selection-tool {cursor:crosshair;}
.lyric-selection-tool .roll-note {pointer-events:none;}
.lyric-box {position:absolute;z-index:8;pointer-events:none;border:1px solid var(--accent);background:color-mix(in srgb,var(--accent) 22%,transparent);}
.sung-tier {position:absolute;left:0;right:0;top:24px;height:18px;overflow:hidden;}
.phone-tier {
  position: absolute;
  inset: auto 0 0;
  height:var(--key-height);
  box-sizing:border-box;
  z-index: 3;
  border-top: 1px solid var(--border);
  background: var(--panel);
  cursor: default;
}
.phone-span {
  position: absolute;
  inset-block: 2px;
  padding: 2px 3px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: color-mix(in srgb, var(--accent) 11%, var(--panel));
  color: var(--text);
  font-size: .91rem;
  white-space: nowrap;
  overflow: hidden;
}
.phone-boundary {
  position: absolute;
  inset-block: 2px;
  width: 9px;
  transform: translateX(-50%);
  padding: 0;
  border: 0;
  background: transparent;
  cursor: ew-resize;
  touch-action: none;
}
.phone-boundary:is(:hover, :focus-visible, :active) {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}
.piano-keys {
  position: sticky;
  left: 0;
  z-index: 5;
  box-shadow: 5px 0 12px rgba(15, 23, 42, 0.18);
  background: #354255;
}
.key-slot {
  height: var(--key-height);
  background: linear-gradient(180deg, #f4f6fb, #c5cfdd);
  border-bottom: 1px solid #a4afbf;
}
.piano-key {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0 4px 4px 0;
  padding: 0 7px 0 3px;
  cursor: pointer;
  font: 11px var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  color: #26364f;
  background: linear-gradient(180deg, #fdfefe, #e3e7ed);
  box-shadow: inset 0 1px 1px #fff, inset 0 -3px 0 #c4cddd, inset -2px 0 0 #c6ceda;
  white-space: nowrap;
  overflow: hidden;
}
.piano-key.is-tonic:not(.black) {
  background: linear-gradient(180deg, #eef6ff, #d4e4fa);
  color: #123c7a;
  font-weight: 700;
}
.piano-key.black {
  width: 64%;
  height: calc(100% + 1px);
  position: relative;
  z-index: 1;
  padding: 0 5px 0 2px;
  border-radius: 0 4px 4px 0;
  background: linear-gradient(175deg, #53657d 0%, #253348 52%, #172437 100%);
  color: #f3f7ff;
  box-shadow: inset 0 1px 1px #8596ae, inset 0 -3px 0 #111c2d, inset -2px 0 0 #152037, 2px 2px 4px rgba(15, 23, 43, 0.35);
  font-size: 0.833333rem;
}
.piano-key.black.is-tonic {
  color: #93c5fd;
  font-weight: 700;
}
.hz-mode .piano-key {
  font-size: 0.816667rem;
  padding-right: 5px;
}
.hz-mode .piano-key.black {
  font-size: 0.75rem;
  padding-right: 4px;
}
.compact .piano-key {
  font-size: 0.791667rem;
}
.compact .piano-key.black {
  font-size: 0.733333rem;
}
.piano-key:hover,
.piano-key.pressed,
.piano-key:active {
  background: linear-gradient(180deg, #b2d7ff, #74a6ec);
  color: #152e5b;
  box-shadow: inset 0 2px 5px rgba(26, 76, 142, 0.45), inset -2px -2px 0 #5e90d0;
}
.piano-grid {
  position: relative;
  overflow: hidden;
  background: var(--panel);
  user-select: none;
}
.piano-grid.pitch-draw,
.piano-grid.pitch-erase { touch-action: none; user-select: none; }
.piano-grid.pitch-draw { cursor: crosshair; }
.piano-grid.pitch-erase { cursor: col-resize; }
.pitch-draw .roll-note,
.pitch-erase .roll-note,
.range-tool .roll-note:not(.range-selected) { pointer-events: none; }
.range-tool { cursor: crosshair; touch-action: none; }
.roll-selection {
  position: absolute;
  inset-block: 0;
  border-inline: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  pointer-events: none;
  z-index: 1;
}
.piano-ruler::before,
.piano-ruler::after,
.piano-grid::before,
.piano-grid::after {
  content: '';
  position: absolute;
  inset: 0 0 0 var(--first-beat);
  z-index: 1;
  pointer-events: none;
}
.piano-ruler::before,
.piano-grid::before {
  background-image: repeating-linear-gradient(to right,
    color-mix(in srgb, var(--text) 20%, transparent) 0 1px, transparent 1px var(--beat-width));
  mask-image: repeating-linear-gradient(to bottom, black 0 4px, transparent 4px 8px);
}
.piano-ruler::after,
.piano-grid::after {
  background-image: repeating-linear-gradient(to right,
    color-mix(in srgb, var(--text) 28%, var(--panel)) 0 1px, transparent 1px var(--measure-width));
}
.key-guide {
  position: absolute;
  width: 100%;
  height: var(--key-height);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
}
.key-guide.dark {
  background: color-mix(in srgb, var(--text) 4.5%, transparent);
}
.key-guide.octave {
  border-bottom-color: color-mix(in srgb, var(--text) 22%, transparent);
}
.key-guide.tonic-guide {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.pitch-reference {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  color: color-mix(in srgb, var(--violet, var(--accent)) 78%, transparent);
}
.piano-rest {
  position: absolute;
  inset-block: 0;
  z-index: 1;
  background: repeating-linear-gradient(140deg, transparent 0 6px, color-mix(in srgb, var(--text) 8%, transparent) 6px 7px);
}
.roll-note {
  position: absolute;
  z-index: 2;
  height: calc(var(--key-height) - 5px);
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
  border: 1px solid color-mix(in srgb, var(--accent) 68%, var(--text));
  color: var(--text);
  background: color-mix(in srgb, var(--accent) 28%, var(--panel));
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.22);
  font-size: 0.958333rem;
  white-space: nowrap;
  overflow: hidden;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
}
.compact .roll-note {
  height: calc(var(--key-height) - 3px);
  font-size: 0.833333rem;
  padding: 0 3px;
}
.roll-note.selected {
  background: color-mix(in srgb, var(--accent) 50%, var(--panel));
}
.roll-note.current,
.roll-note:focus-visible {
  outline: 1.5px solid var(--accent);
  outline-offset: 1px;
}
.roll-note.range-selected {
  color: #10372c;
  border-color: #c9ffe9;
  background: #82dcb7;
  box-shadow: 0 0 0 1px #245841;
}
.roll-note.range-selected .note-end { display: none; }
.roll-note span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.note-end {
  position: absolute;
  width: min(7px, 38%);
  inset: 0 0 0 auto;
  cursor: ew-resize;
}
.roll-note:hover .note-end,
.roll-note.current .note-end {
  background: color-mix(in srgb, var(--accent) 48%, transparent);
}
.synth-f0-overlay {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}
.synth-f0-overlay .f0-halo {
  stroke: color-mix(in srgb, var(--panel) 78%, transparent);
  stroke-width: 4.2px;
}
.synth-f0-overlay.is-actual .f0-stroke {
  stroke: var(--teal);
  stroke-width: 2.2px;
}
.synth-f0-overlay.is-preview .f0-stroke {
  stroke: var(--warning);
  stroke-width: 1.9px;
  stroke-dasharray: 6 3;
}
.pitch-edit-layer {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
}
.pitch-edit-stroke {
  fill: none;
  stroke: var(--accent);
  stroke-width: 2px;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pitch-edit-stroke.gesture { stroke-width: 3px; }
.pitch-erase-range { fill: color-mix(in srgb, var(--danger) 18%, transparent); }
.piano-playhead {
  pointer-events: none;
  position: absolute;
  inset-block: 0;
  z-index: 4;
  width: 2px;
  background: var(--danger, var(--accent));
}
</style>
