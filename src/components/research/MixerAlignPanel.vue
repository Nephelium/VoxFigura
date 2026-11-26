<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { parseTextGrid, type TextGridDocument } from '@vocalcut/core';
import { M27Adapter } from '@vocalcut/model-adapters';
import CustomSelect from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';
import { isDeepSeekApiBase } from '@/data/deepseek';
import { useWorkbenchStore } from '@/stores/workbench';
import ReconstructionTranscriptionActions from './ReconstructionTranscriptionActions.vue';
import { useLocalAsrSetup } from './reconstruction-asr-setup';
import { requestTranscription } from './reconstruction-transcription';
import { blobToBase64 } from './research-utils';
import { cleanTextGridWordLabels } from './m27-session';
import type { MixerAudio, MixerDevice } from './voice-mixer';

const props = withDefaults(
  defineProps<{
    mode: 'preset' | 'dual';
    primaryAudio: MixerAudio | null;
    secondaryAudio?: MixerAudio | null;
    device: MixerDevice;
    disabled?: boolean;
    modelValue: string;
    compact?: boolean;
  }>(),
  {
    secondaryAudio: null,
    disabled: false,
    compact: false,
  },
);

const emit = defineEmits<{
  'update:modelValue': [text: string];
  'aligned-single': [grid: TextGridDocument];
  'aligned-dual': [payload: { a: TextGridDocument; b: TextGridDocument }];
  busy: [active: boolean];
}>();

const store = useWorkbenchStore();
const adapter = new M27Adapter();
const lang = ref<'auto' | 'zh' | 'en'>('auto');
const transcribing = ref(false);
const aligning = ref(false);
const statusMessage = ref('');
const statusFailed = ref(false);
let asrAbort: AbortController | null = null;
let alignGen = 0;

const langOptions = [
  { value: 'auto', label: '自动识别语种' },
  { value: 'zh', label: '普通话' },
  { value: 'en', label: '英语' },
];

const deepSeekAsrKey = computed(() =>
  store.deepSeekAsrEnabled.value && isDeepSeekApiBase(store.aiToolsBaseUrl.value)
    ? store.aiToolsApiKey.value
    : '',
);

const hasAudio = computed(() => Boolean(props.primaryAudio?.file));
const canAlignDual = computed(() => Boolean(props.primaryAudio?.file && props.secondaryAudio?.file));
const localAsr = useLocalAsrSetup(
  computed(() => hasAudio.value && !deepSeekAsrKey.value),
  store.localWhisperModel,
  store.setLocalWhisperModel,
);
const { status: localAsrStatus, message: localAsrMessage, pendingModel: localAsrPending } = localAsr;

const actionBlocked = computed(() => props.disabled || transcribing.value || aligning.value || !hasAudio.value);
const alignDisabled = computed(
  () =>
    actionBlocked.value ||
    !props.modelValue.trim() ||
    (props.mode === 'dual' && !canAlignDual.value),
);

watch([transcribing, aligning], ([t, a]) => emit('busy', t || a));
watch(deepSeekAsrKey, () => {
  if (transcribing.value) cancelTranscription();
});

function cancelTranscription() {
  asrAbort?.abort();
  asrAbort = null;
  transcribing.value = false;
}

function parseGuidedAlignment(textgrid: string): TextGridDocument {
  const parsed = parseTextGrid(textgrid);
  if (
    !parsed.ok ||
    !parsed.value.tiers.some(
      (tier) =>
        tier.kind === 'IntervalTier' &&
        /phone|音素/i.test(tier.name) &&
        tier.intervals.some((interval) => interval.text.trim()),
    )
  ) {
    throw new Error('Vox2Align-Lite v2 未返回有效音素区间');
  }
  return cleanTextGridWordLabels(parsed.value);
}

async function runTranscribe() {
  const file = props.primaryAudio?.file;
  if (!file || actionBlocked.value) return;
  const key = deepSeekAsrKey.value;
  cancelTranscription();
  const req = new AbortController();
  asrAbort = req;
  transcribing.value = true;
  statusFailed.value = false;
  statusMessage.value = key ? '正在通过 DeepSeek API 识别文本…' : '正在使用本地 Whisper 识别文本…';
  try {
    const result = await requestTranscription(file, lang.value, req.signal, {
      deepSeekKey: key,
      model: store.localWhisperModel.value,
    });
    if (asrAbort !== req || props.primaryAudio?.file !== file) return;
    emit('update:modelValue', result.text);
    statusMessage.value = key
      ? 'DeepSeek 已转写文本，可微调后点击「按原文对齐」'
      : `已识别${result.lang === 'zh' ? '普通话' : '英语'}文本，可校对后按原文对齐`;
  } catch (err) {
    if (asrAbort === req && props.primaryAudio?.file === file) {
      statusFailed.value = true;
      statusMessage.value = '自动识别未完成：' + (err instanceof Error ? err.message : String(err));
      if (!key) void localAsr.refresh();
    }
  } finally {
    if (asrAbort === req) cancelTranscription();
  }
}

async function runAlign() {
  const text = props.modelValue.trim();
  if (!text || alignDisabled.value || !props.primaryAudio?.file) return;
  const gen = ++alignGen;
  aligning.value = true;
  statusFailed.value = false;
  const computeDevice = props.device === 'cuda' ? 'cuda' : 'wasm-cpu';

  try {
    if (props.mode === 'preset') {
      statusMessage.value = '正在使用 Vox2Align-Lite v2 按原文对齐…';
      const wav = await blobToBase64(props.primaryAudio.file);
      if (gen !== alignGen) return;
      const res = await adapter.align({
        wav_base64: wav,
        filename: props.primaryAudio.name,
        text,
        lang: lang.value,
        alignment_mode: 'guided',
        compute_device: computeDevice,
      });
      if (gen !== alignGen) return;
      if (!res.ok) throw new Error(res.error.hint);
      const grid = parseGuidedAlignment(res.value.alignment.textgrid);
      emit('aligned-single', grid);
      statusMessage.value = '已完成 Vox2Align-Lite v2 原文对齐，音素边界已同步到曲线画布';
    } else {
      const fileB = props.secondaryAudio?.file;
      if (!fileB || !props.secondaryAudio) return;
      statusMessage.value = '正在使用 Vox2Align-Lite v2 对齐说话人 A 与 B…';
      const [wavA, wavB] = await Promise.all([blobToBase64(props.primaryAudio.file), blobToBase64(fileB)]);
      if (gen !== alignGen) return;
      const resA = await adapter.align({
        wav_base64: wavA,
        filename: props.primaryAudio.name,
        text,
        lang: lang.value,
        alignment_mode: 'guided',
        compute_device: computeDevice,
      });
      if (gen !== alignGen) return;
      if (!resA.ok) throw new Error(`说话人 A 对齐失败：${resA.error.hint}`);
      const resB = await adapter.align({
        wav_base64: wavB,
        filename: props.secondaryAudio.name,
        text,
        lang: lang.value,
        alignment_mode: 'guided',
        compute_device: computeDevice,
      });
      if (gen !== alignGen) return;
      if (!resB.ok) throw new Error(`说话人 B 对齐失败：${resB.error.hint}`);
      const gridA = parseGuidedAlignment(resA.value.alignment.textgrid);
      const gridB = parseGuidedAlignment(resB.value.alignment.textgrid);
      emit('aligned-dual', { a: gridA, b: gridB });
      statusMessage.value = '已完成 A / B 双轨原文对齐，可直接按精确音素边界混合';
    }
  } catch (err) {
    if (gen === alignGen) {
      statusFailed.value = true;
      statusMessage.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (gen === alignGen) aligning.value = false;
  }
}

function openDeepSeekSettings() {
  store.aiDrawerOpen.value = true;
  window.dispatchEvent(new CustomEvent('vocalcut:ai-config'));
}

onBeforeUnmount(() => {
  alignGen++;
  cancelTranscription();
});
</script>

<template>
  <div class="mx-align-box" :class="{ compact }">
    <div class="mx-align-top">
      <span class="mx-align-title">{{ mode === 'dual' ? '原文参考与小模型对齐' : '对齐参考文本（可选）' }}</span>
      <ReconstructionTranscriptionActions
        :cloud="!!deepSeekAsrKey"
        :blocked="actionBlocked"
        :transcribing="transcribing"
        :install="localAsrStatus"
        :install-message="localAsrMessage"
        :pending-model="localAsrPending"
        @transcribe="runTranscribe"
        @choose="localAsr.choose"
        @refresh="localAsr.refresh"
      />
    </div>

    <textarea
      :value="modelValue"
      class="inp mx-align-textarea"
      maxlength="4000"
      :rows="compact ? 2 : 2"
      :disabled="disabled || aligning"
      :placeholder="
        mode === 'dual'
          ? '手写两段录音对应的同一句原文，或按需点击自动识别（默认不识别）'
          : '可直接手写录音文本，或按需点击自动识别（默认不识别，留空也可直接调制）'
      "
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />

    <div class="mx-align-bar">
      <CustomSelect
        v-model="lang"
        size="xs"
        aria-label="原文对齐语种"
        :options="langOptions"
        :disabled="disabled || aligning"
      />
      <button type="button" class="btn xs" :disabled="alignDisabled" @click="runAlign">
        <IconSvg name="timeline" :size="11" />
        <span>{{ aligning ? '对齐中…' : mode === 'dual' ? '按原文对齐 A & B' : '按原文对齐' }}</span>
      </button>
      <button
        v-if="!deepSeekAsrKey"
        type="button"
        class="btn xs mx-link-btn"
        title="配置 DeepSeek API Key 后可在线识别文本"
        @click="openDeepSeekSettings"
      >
        配置 DeepSeek 转写
      </button>
      <span v-else class="tree-tag">DeepSeek ASR</span>
    </div>

    <p v-if="statusMessage || (localAsrMessage && !deepSeekAsrKey)" class="mx-align-note" :class="{ failed: statusFailed }" role="status">
      {{ statusMessage || localAsrMessage }}
    </p>
    <p v-else class="mx-align-note">
      可手写文本或配置 DeepSeek API 转写，再用 <code>Vox2Align-Lite v2</code> 按原文对齐。
    </p>
  </div>
</template>

<style scoped>
.mx-align-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.mx-align-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
}

.mx-align-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
}

.mx-align-textarea {
  width: 100%;
  min-height: 44px;
  font-size: 0.916667rem;
  line-height: 1.45;
  resize: vertical;
}

.mx-align-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mx-align-bar :deep(.vc-sel) {
  min-width: 108px;
}

.mx-link-btn {
  margin-left: auto;
  color: var(--accent);
}

.mx-align-note {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.45;
  color: var(--muted);
}

.mx-align-note.failed {
  color: var(--danger);
}

.mx-align-note code {
  font-family: var(--font-mono);
  font-size: 0.8rem;
}
</style>
