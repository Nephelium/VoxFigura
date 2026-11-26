<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { SAMPLE_RATE_HZ } from '@vocalcut/core';
import { useWorkbenchStore } from '@/stores/workbench';
import { synthesisGainMode } from '@/data/voice-renderer';
import { VOQS_GROUPS, voqsProfile } from '@/data/voqs-library';
import { M27CurveEditor, type MorphKnot } from '@/vendor/m27-voice-morph/curve-editor.js';
import { withImportedTractFrames } from '@/components/research/annotation-edit';
import { parseWavDataDurationSmp } from '@/data/workspace-transfer';
import { outputPoses, transferAnchors, transferOutputClip, transferRange, voiceTransferOperand, type TransferChoice, type VoiceTransferResult } from './voice-transfer';

const props = defineProps<{
  choices: TransferChoice[];
  save: (value: VoiceTransferResult) => Promise<void>;
  replaceClip: (value: VoiceTransferResult, target: TransferChoice) => Promise<void>;
}>();
const panel = ref<HTMLDetailsElement>();
const store = useWorkbenchStore();
const groups = [
  { id: 'speaker', label: '音色' },
  { id: 'tract_all', label: '声道' },
  { id: 'glottis', label: '声门' },
  { id: 'f0_pr', label: '基频与气压' },
] as const;
type Group = typeof groups[number]['id'];
const reusable = (): MorphKnot[] => [{ t: 0, v: 0 }, { t: 1, v: 1 }];
const curves = ref<Record<Group, MorphKnot[]>>({ speaker: reusable(), tract_all: reusable(), glottis: reusable(), f0_pr: reusable() });
const enabled = ref<Group[]>(['tract_all']);
const drawing = ref<Group>('tract_all');
const targetId = ref('');
const sourceId = ref('');
const sourceKind = ref<'clip' | 'voqs'>('clip');
const voqsSymbol = ref('V̤');
const voqsTakeId = ref('');
const voqs = computed(() => voqsProfile(voqsSymbol.value));
const voqsTake = computed(() => voqs.value?.takes.find(take => take.id === voqsTakeId.value) ?? voqs.value?.takes[0]);
const targetFrom = ref(0);
const targetTo = ref(0);
const sourceFrom = ref(0);
const sourceTo = ref(0);
const target = computed(() => props.choices.find(choice => choice.id === targetId.value));
const source = computed(() => props.choices.find(choice => choice.id === sourceId.value));
const rhythm = ref(false);
const voicingGate = ref(true);
const canvas = ref<HTMLCanvasElement>();
const status = ref('');
const busy = ref(false);
const saving = ref(false);
const saved = ref(false);
const replaced = ref(false);
const preview = ref<VoiceTransferResult>();
const replacementTarget = ref<TransferChoice>();
const previewUrl = ref('');
let editor: M27CurveEditor | undefined;
let renderVersion = 0;
let cancel: AbortController | undefined;

const duration = (choice: TransferChoice | undefined) => (choice?.durationSmp ?? 0) / SAMPLE_RATE_HZ;
const usable = computed(() => Boolean(target.value && (sourceKind.value === 'voqs' ? voqsTake.value : source.value &&
  (targetId.value !== sourceId.value || targetFrom.value !== sourceFrom.value || targetTo.value !== sourceTo.value))));
const canBlendSpeaker = computed(() => Boolean(target.value?.audio && source.value?.audio));
const visibleGroups = computed(() => sourceKind.value === 'voqs' ? groups.filter(group => group.id === 'glottis' || group.id === 'f0_pr') : groups);
const resultSeconds = computed(() => Math.max(0, rhythm.value ? sourceTo.value - sourceFrom.value : targetTo.value - targetFrom.value));
const allowRender = computed(() => usable.value && (rhythm.value || enabled.value.length > 0));
const title = (choice: TransferChoice) => `${choice.label} · ${duration(choice).toFixed(2)} 秒 · ${choice.audio ? '音频' : '轨迹'}`;
defineExpose({
  openFor(id: string) {
    if (!panel.value || !props.choices.some(choice => choice.id === id)) return;
    targetId.value = id;
    if (!sourceId.value || sourceId.value === id) sourceId.value = props.choices.find(choice => choice.id !== id)?.id ?? '';
    panel.value.open = true;
    panel.value.scrollIntoView({ block: 'nearest' });
  },
});
watch(() => props.choices, list => {
  if (!list.some(choice => choice.id === targetId.value)) targetId.value = list[0]?.id ?? '';
  if (!list.some(choice => choice.id === sourceId.value)) sourceId.value = list.find(choice => choice.id !== targetId.value)?.id ?? '';
}, { immediate: true });
watch(targetId, () => { targetFrom.value = 0; targetTo.value = Math.min(15, duration(target.value)); }, { immediate: true });
watch(sourceId, () => { sourceFrom.value = 0; sourceTo.value = Math.min(15, duration(source.value)); }, { immediate: true });
watch(canBlendSpeaker, available => {
  if (!available) {
    enabled.value = enabled.value.filter(group => group !== 'speaker');
    if (drawing.value === 'speaker') drawing.value = 'tract_all';
  }
});
watch(sourceKind, kind => {
  if (kind === 'voqs') {
    enabled.value = ['glottis'];
    drawing.value = 'glottis';
    rhythm.value = false;
  } else {
    enabled.value = ['tract_all'];
    drawing.value = 'tract_all';
  }
});

const alignedBoundaries = computed(() => {
  if (!usable.value || sourceKind.value === 'voqs') return [];
  try {
    return transferAnchors(transferRange(target.value!, targetFrom.value, targetTo.value), transferRange(source.value!, sourceFrom.value, sourceTo.value));
  } catch { return []; }
});

function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  preview.value = undefined;
  replacementTarget.value = undefined;
  saved.value = false;
  replaced.value = false;
}

watch([targetId, sourceId, sourceKind, voqsSymbol, voqsTakeId, targetFrom, targetTo, sourceFrom, sourceTo, rhythm, voicingGate, curves, enabled], () => {
  renderVersion++;
  cancel?.abort();
  busy.value = false;
  status.value = '';
  clearPreview();
}, { deep: true });

function updateEditor() {
  editor?.setKnots(curves.value[drawing.value], true);
  const clock = rhythm.value ? source.value : target.value;
  const offset = (clock?.startSmp ?? 0) + Math.round((rhythm.value ? sourceFrom.value : targetFrom.value) * SAMPLE_RATE_HZ);
  const samples = clock?.audio?.getChannelData(0);
  const step = Math.ceil(resultSeconds.value * SAMPLE_RATE_HZ / 96);
  const waveformPeaks = samples && step > 0 ? Array.from({ length: 96 }, (_, i) => {
    const start = offset + i * step;
    let peak = 0;
    for (let s = start; s < Math.min(samples.length, start + step); s += 4) peak = Math.max(peak, Math.abs(samples[s]));
    return peak;
  }) : [];
  editor?.setVisualContext({ durSec: resultSeconds.value, smoothMs: 25, enableGate: voicingGate.value, waveformPeaks });
}

watch(canvas, element => {
  editor?.destroy();
  editor = element ? new M27CurveEditor(element, { onChange: knots => { curves.value[drawing.value] = knots; } }) : undefined;
  updateEditor();
}, { flush: 'post' });
watch([drawing, resultSeconds, voicingGate, targetFrom, sourceFrom, targetId, sourceId, rhythm, store.resolvedColorMode, store.paletteId, store.customAccentHex], updateEditor);

function resetDrawing(value: number | null) {
  curves.value[drawing.value] = value === null ? reusable() : [{ t: 0, v: value }, { t: 1, v: value }];
  updateEditor();
}

async function render() {
  if (!allowRender.value || busy.value) return;
  clearPreview();
  busy.value = true;
  status.value = '';
  const version = ++renderVersion;
  cancel = new AbortController();
  try {
    const targetRange = transferRange(target.value!, targetFrom.value, targetTo.value);
    const sourceRange = sourceKind.value === 'clip' ? transferRange(source.value!, sourceFrom.value, sourceTo.value) : null;
    const project = store.project.value;
    const [operandA, operandB] = await Promise.all([voiceTransferOperand(targetRange, project), sourceRange ? voiceTransferOperand(sourceRange, project) : null]);
    if (version !== renderVersion) return;
    const response = await fetch('/api/models/voice-transfer', {
      method: 'POST', signal: cancel.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: operandA, source: operandB, anchors: sourceRange ? transferAnchors(targetRange, sourceRange) : [],
        voqs_source_id: sourceRange ? undefined : voqsTake.value?.id, audio_gain: synthesisGainMode.value,
        curves: Object.fromEntries(enabled.value.map(group => [group, curves.value[group]])), rhythm: rhythm.value, voicing_gate: voicingGate.value }),
    });
    const data = await response.json();
    if (version !== renderVersion) return;
    if (!response.ok || !data.ok) throw new Error(data.hint || data.error?.hint || `声音属性迁移失败（${response.status}）`);
    const bytes = Uint8Array.from(atob(data.audio_base64), character => character.charCodeAt(0));
    const title = `${targetRange.choice.label.replace(/\.[^./\\]+$/, '')} · 属性迁移`;
    const file = new File([bytes], title + '.wav', { type: 'audio/wav' });
    const durationSmp = parseWavDataDurationSmp(bytes, data.rate_hz) || Math.round((data.rows_pa?.length ?? 0) / 50 * SAMPLE_RATE_HZ);
    const frames = outputPoses(data.rows_pa);
    const clip = transferOutputClip(targetRange, durationSmp, rhythm.value ? data.target_frame_map : undefined);
    preview.value = { file, label: title, rowsPa: data.rows_pa, frames,
      clip: clip && enabled.value.includes('tract_all') ? withImportedTractFrames(clip, frames) : clip };
    const destination = targetRange.choice;
    if (destination.stageClip && targetRange.startSmp === destination.startSmp &&
        targetRange.endSmp - targetRange.startSmp === destination.stageClip.lengthSmp) replacementTarget.value = destination;
    previewUrl.value = URL.createObjectURL(file);
    const alignment = data.align_mode === 'voqs' ? `VoQS 实录 ${voqsSymbol.value} · ${voqsTake.value?.id}` : data.align_mode === 'textgrid' ? '已有标注锚点' : 'DTW';
    status.value = `${alignment} · ${data.label} · ${(durationSmp / SAMPLE_RATE_HZ).toFixed(2)} 秒`;
  } catch (error) {
    if (version === renderVersion) status.value = error instanceof Error ? error.message : '声音属性迁移失败';
  } finally { if (version === renderVersion) busy.value = false; }
}

async function savePreview(replace = false) {
  if (!preview.value || saving.value || (replace ? replaced.value : saved.value)) return;
  const result = preview.value;
  saving.value = true;
  try {
    if (replace && replacementTarget.value) {
      await props.replaceClip(result, replacementTarget.value);
      if (preview.value === result) replaced.value = true;
    } else {
      await props.save(result);
      if (preview.value === result) saved.value = true;
    }
  } catch (error) { status.value = error instanceof Error ? error.message : '无法保存迁移结果'; }
  finally { saving.value = false; }
}

onBeforeUnmount(() => {
  renderVersion++;
  cancel?.abort();
  editor?.destroy();
  clearPreview();
});
</script>

<template>
  <details ref="panel" class="voice-transfer">
    <summary>声音属性迁移</summary>
    <fieldset :disabled="busy || saving" class="transfer-body">
      <section class="transfer-pair">
        <label>目标片段 <select v-model="targetId"><option value="">选择目标</option><option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ title(choice) }}</option></select></label>
        <div v-if="target" class="transfer-range">
          <label>目标入点 (s)<input v-model.number="targetFrom" type="number" min="0" :max="duration(target)" step="0.001" /></label>
          <label>目标出点 (s)<input v-model.number="targetTo" type="number" min="0" :max="duration(target)" step="0.001" /></label>
        </div>
        <label>属性来源 <select v-model="sourceKind"><option value="clip">时间线片段或素材</option><option value="voqs">VoQS 实录发声类型</option></select></label>
        <label v-if="sourceKind === 'clip'">来源片段 <select v-model="sourceId"><option value="">选择来源</option><option v-for="choice in choices" :key="choice.id" :value="choice.id">{{ title(choice) }}</option></select></label>
        <div v-if="sourceKind === 'clip' && source" class="transfer-range">
          <label>来源入点 (s)<input v-model.number="sourceFrom" type="number" min="0" :max="duration(source)" step="0.001" /></label>
          <label>来源出点 (s)<input v-model.number="sourceTo" type="number" min="0" :max="duration(source)" step="0.001" /></label>
        </div>
        <template v-if="sourceKind === 'voqs'">
          <label>VoQS 实录类型 <select v-model="voqsSymbol" class="ipa" translate="no">
            <optgroup v-for="group in VOQS_GROUPS" :key="group.id" :label="group.label">
              <option v-for="profile in group.profiles" :key="profile.symbol" :value="profile.symbol" :disabled="group.id === 'height'">{{ profile.symbol }} · {{ profile.label }}</option>
            </optgroup>
          </select></label>
          <label v-if="voqs && voqs.takes.length > 1">VoQS 实录样本 <select :value="voqsTake?.id" @change="voqsTakeId = ($event.target as HTMLSelectElement).value">
            <option v-for="take in voqs.takes" :key="take.id" :value="take.id">{{ take.id }}</option>
          </select></label>
          <p>喉位高低需要独立喉位控制，当前声道迁移支持其余发声类型。</p>
        </template>
      </section>
      <p v-if="!usable">选择两个片段，或从同一素材选取两个不同区间。</p>
      <template v-else>
        <div class="transfer-checks" aria-label="要迁移的属性">
          <label v-for="group in visibleGroups" :key="group.id"><input v-model="enabled" type="checkbox" :value="group.id" :disabled="group.id === 'speaker' && !canBlendSpeaker" />{{ group.label }}</label>
          <label v-if="sourceKind === 'clip'"><input v-model="rhythm" type="checkbox" />节奏<span v-if="rhythm"> · 用来源的时间轴</span></label>
        </div>
        <p v-if="sourceKind === 'clip' && !canBlendSpeaker">音色需同时提供两条参考音频。纯轨迹可用物理声管合成。</p>
        <label>编辑混合曲线<select v-model="drawing"><option v-for="group in visibleGroups" :key="group.id" :value="group.id" :disabled="group.id === 'speaker' && !canBlendSpeaker">{{ group.label }}</option></select></label>
        <canvas ref="canvas" aria-label="混合曲线，点击新增节点，拖动节点修改权重" />
        <div class="transfer-actions">
          <button type="button" @click="resetDrawing(null)">渐变</button><button type="button" @click="resetDrawing(1)">全量</button><button type="button" @click="resetDrawing(0)">清零</button>
        </div>
        <p>0% 保留目标，100% 使用来源。每段选区最长 15 秒。</p>
        <div class="transfer-checks"><label><input v-model="voicingGate" type="checkbox" />保护清音和静音</label></div>
        <p>{{ sourceKind === 'voqs' ? '保留目标的时间轴与声道构型。' : alignedBoundaries.length ? `已匹配 ${alignedBoundaries.length} 个标注边界` : '将按声道轨迹 DTW 对齐' }}</p>
      </template>
      <button type="button" class="transfer-primary" :disabled="!allowRender" @click="render">{{ busy ? '正在重合成…' : '生成试听' }}</button>
    </fieldset>
    <div v-if="status || previewUrl" class="transfer-results" aria-live="polite">
      <p v-if="status">{{ status }}</p>
      <audio v-if="previewUrl" :src="previewUrl" controls preload="metadata" />
      <div v-if="previewUrl" class="transfer-actions">
        <button type="button" :disabled="saved || saving" @click="savePreview()">{{ saved ? '已保存为新素材' : '保存为新素材' }}</button>
        <button v-if="replacementTarget" type="button" :disabled="replaced || saving"
          @click="savePreview(true)">{{ replaced ? '已替换原片段' : '替换原片段' }}</button>
      </div>
      <p v-if="previewUrl && target?.stageClip && !replacementTarget">若要回写此选区，可先在时间线上切分，再迁移整个片段。</p>
    </div>
  </details>
</template>

<style scoped>
.voice-transfer {
  border-bottom: 1px solid var(--border);
  padding: 8px 0;
  --vm-canvas-bg: var(--app);
  --vm-grid-line: color-mix(in srgb, var(--border) 68%, transparent);
  --vm-muted: var(--muted);
  --vm-wave-color: color-mix(in srgb, var(--wave, var(--accent)) 32%, transparent);
  --vm-gate-block: color-mix(in srgb, var(--danger) 18%, transparent);
  --vm-curve-raw: color-mix(in srgb, var(--violet) 74%, transparent);
  --vm-curve-eff: var(--accent);
  --vm-curve-fill: var(--selection);
  --vm-knot-fill: var(--panel);
  --vm-knot-stroke: var(--accent);
  --vm-knot-active: var(--warning);
}
summary { cursor: pointer; font-weight: 600; padding-block: 4px; }
.transfer-body, .transfer-results, .transfer-pair { display: grid; gap: 7px; min-width: 0; }
.transfer-body { margin: 5px 0 0; border: 0; padding: 0; }
.transfer-results { margin-top: 8px; }
.transfer-body label { display: grid; gap: 3px; }
.transfer-body select, .transfer-body input:not([type='checkbox']), button { box-sizing: border-box; min-width: 0; min-height: 26px; font: inherit; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 5px; padding: 2px 5px; }
.transfer-body select { width: 100%; }
.transfer-range { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.transfer-checks, .transfer-actions { display: flex; gap: 5px 8px; flex-wrap: wrap; }
.transfer-checks label { display: flex; align-items: center; gap: 4px; }
.transfer-checks input { margin: 0; accent-color: var(--accent); }
button { cursor: pointer; }
button:disabled { opacity: 0.55; cursor: default; }
.transfer-primary { border-color: var(--accent); }
p { color: var(--muted); margin: 0; line-height: 1.45; }
canvas { display: block; width: 100%; height: 134px; border-radius: 5px; border: 1px solid var(--border); touch-action: none; }
audio { width: 100%; height: 30px; }
</style>
