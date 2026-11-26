<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PhonationAnchor } from '@vocalcut/core';
import { defaultVoqsHeight, VOQS_GROUPS, voqsAnchorLabel, voqsAudioUrl, voqsProfile, type VoqsGroup, type VoqsProfile, type VoqsTake } from '@/data/voqs-library';

const props = defineProps<{
  anchor?: PhonationAnchor; symbol?: string; referenceId?: string; renderHeight?: number; mediaOwned?: boolean;
  groups?: readonly VoqsGroup[];
}>();
const emit = defineEmits<{ apply: [profile: VoqsProfile, take: VoqsTake, height?: number] }>();
const symbol = ref('V');
const takeId = ref('');
const showAudio = ref(false);
const height = ref<number>();
const availableGroups = computed(() => props.groups ?? VOQS_GROUPS);
const allowedSymbols = computed(() => new Set(availableGroups.value.flatMap(group => group.profiles.map(item => item.symbol))));
const profile = computed(() => voqsProfile(props.symbol ?? symbol.value));
const take = computed(() => props.referenceId
  ? profile.value?.takes.find(item => item.id === props.referenceId)
  : profile.value?.takes.find(item => item.id === takeId.value) ?? profile.value?.takes[0]);
const modeledHeight = computed(() => defaultVoqsHeight(profile.value?.symbol ?? ''));
const pickedHeight = computed(() => props.mediaOwned ? props.renderHeight : height.value);
const validHeight = computed(() => modeledHeight.value === undefined || (typeof pickedHeight.value === 'number'
  && Number.isFinite(pickedHeight.value) && Math.abs(pickedHeight.value) <= 1 && pickedHeight.value * modeledHeight.value > 0));

watch(availableGroups, () => {
  if (!props.symbol && !allowedSymbols.value.has(symbol.value)) {
    symbol.value = allowedSymbols.value.has('V') ? 'V' : (availableGroups.value[0]?.profiles[0]?.symbol ?? 'V');
  }
}, { immediate: true });
watch(() => props.anchor, anchor => {
  if (anchor?.voqs && voqsProfile(anchor.voqs.symbol) && allowedSymbols.value.has(anchor.voqs.symbol)) {
    symbol.value = anchor.voqs.symbol;
    takeId.value = anchor.voqs.source_id;
  }
}, { immediate: true });
watch(profile, current => {
  height.value = current?.symbol === props.anchor?.voqs?.symbol
    ? props.anchor?.larynx_height_cm ?? defaultVoqsHeight(current?.symbol ?? '') : defaultVoqsHeight(current?.symbol ?? '');
}, { immediate: true });
</script>

<template>
  <div class="voqs-picker">
    <select v-if="!props.symbol" v-model="symbol" class="inp ipa" aria-label="实录 VoQS 类型">
      <optgroup v-for="group in availableGroups" :key="group.id" :label="group.label">
        <option v-for="item in group.profiles" :key="item.symbol" :value="item.symbol">{{ item.symbol }} · {{ item.label }}</option>
      </optgroup>
    </select>
    <template v-if="profile && take">
      <select v-if="profile.takes.length > 1 && !referenceId" :value="take.id" class="inp" aria-label="VoQS 参考实录" @change="takeId = ($event.target as HTMLSelectElement).value">
        <option v-for="item in profile.takes" :key="item.id" :value="item.id">{{ item.tagged ? '已标声段' : '录音工程' }} · {{ item.id }}</option>
      </select>
      <label v-if="profile.group === 'height' && !mediaOwned" class="voqs-height">喉位控制量（cm）
        <input v-model.number="height" class="inp" aria-label="VoQS 喉位控制量" type="number"
          :min="(modeledHeight ?? 0) > 0 ? 0.05 : -1" :max="(modeledHeight ?? 0) > 0 ? 1 : -0.05" step="0.05" />
      </label>
      <div class="voqs-actions">
        <button type="button" class="btn xs primary" :disabled="!validHeight" @click="emit('apply', profile, take, pickedHeight)">写入声门锚点</button>
        <button v-if="!mediaOwned" type="button" class="btn xs" :aria-expanded="showAudio" @click="showAudio = !showAudio">参考录音</button>
      </div>
      <audio v-if="showAudio" :key="take.id" :src="voqsAudioUrl(take)" controls preload="none" aria-label="VoQS 实录音频" />
      <small class="muted">{{ take.id }} · 第 {{ take.frame + 1 }} 帧 · {{ take.glottis.pr_pa.toFixed(0) }} Pa</small>
      <small v-if="profile.group === 'height' && !mediaOwned" class="muted">声门参数取自实录。喉位控制量由此输入，单位 cm。</small>
      <small v-if="!mediaOwned" class="muted">锚点参数保持至下一点。专用过渡模型待接入。</small>
    </template>
    <small v-else class="muted">{{ mediaOwned ? '这条实录尚无可写入锚点的代表帧。' : '暂无对应 VoQS 实录声门估计。' }}</small>
    <small v-if="anchor" class="muted">当前锚点 {{ voqsAnchorLabel(anchor) }}</small>
  </div>
</template>

<style scoped>
.voqs-picker { display:grid; gap:4px; min-width:0; }
.voqs-picker select,.voqs-picker audio { width:100%; min-width:0; }
.voqs-picker small { line-height:1.4; }
.voqs-actions { display:flex; flex-wrap:wrap; gap:5px; }
.voqs-height { display:flex; align-items:center; gap:6px; font-size:0.916667rem; }
.voqs-height input { width:65px; }
</style>
