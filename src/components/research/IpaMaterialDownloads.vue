<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ipaReferenceUrl, referenceTarget, type IpaReference } from '@/data/ipa-reference-library';
import { normalizeAudioFile, synthesisGainMode } from '@/data/voice-renderer';
import { triggerDownload } from '@/components/modals/download';

const props = defineProps<{ current?: IpaReference | null; personal?: Blob; count: number; canReconstruct: boolean }>();
const video = ref(false);
const currentBusy = ref(false);
const currentMessage = ref('');
const libraryMessage = ref('');
const status = ref<'idle' | 'building' | 'ready' | 'failed'>('idle');
const libraryBusy = ref(false);
const progress = ref('');
const libraryUrl = '/api/models/ipa-references/library-bundle';
const variant = computed(() => '?video=' + Number(video.value) + '&audio_gain=' + encodeURIComponent(synthesisGainMode.value));
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

watch([() => props.current?.id, () => props.personal], () => { currentMessage.value = ''; });
async function downloadCurrent() {
  const entry = props.current;
  if (!entry?.exists || currentBusy.value) return;
  if (props.personal) {
    currentBusy.value = true;
    try {
      const file = await normalizeAudioFile(props.personal, entry.id + '-个人录音.wav');
      triggerDownload(file, entry.id + '-个人录音.wav');
    } finally {
      currentBusy.value = false;
    }
    return;
  }
  const movie = video.value && entry.has_glottis;
  currentBusy.value = true;
  currentMessage.value = movie ? '正在生成声带视频…' : '正在打包当前录音…';
  try {
    const response = await fetch(ipaReferenceUrl(entry.id, movie ? 'bundle-video' : 'bundle', synthesisGainMode.value));
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.hint || '当前录音打包失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.id + '-IPA.zip';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    if (entry.id === props.current?.id) currentMessage.value = '已开始下载当前录音';
  } catch (error) {
    if (entry.id === props.current?.id) currentMessage.value = error instanceof Error ? error.message : '下载未完成';
  } finally {
    currentBusy.value = false;
  }
}

async function libraryRequest(start: boolean, version: number) {
  clearTimeout(timer);
  const reportError = start || status.value === 'building';
  libraryBusy.value = true;
  try {
    const response = await fetch(libraryUrl + (start ? '' : variant.value), {
      method: start ? 'POST' : 'GET',
      ...(start ? {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_video: video.value, audio_gain: synthesisGainMode.value }),
      } : {}),
      cache: 'no-store', signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (version !== revision) return;
    if (!response.ok || !result.ok) throw new Error(result.hint || '全库打包服务暂不可用');
    status.value = result.state;
    progress.value = result.finished + ' / ' + result.total;
    libraryMessage.value = result.state === 'failed' ? result.hint || '全库打包失败，可重试' : '';
    if (result.state === 'building') timer = setTimeout(() => void libraryRequest(false, version), 1800);
  } catch (error) {
    if (version !== revision) return;
    status.value = 'idle';
    if (reportError) libraryMessage.value = error instanceof Error ? error.message : '请检查本地引擎后重试';
  } finally {
    if (version === revision) libraryBusy.value = false;
  }
}
watch([video, synthesisGainMode], () => {
  status.value = 'idle';
  libraryMessage.value = '';
  void libraryRequest(false, ++revision);
}, { immediate: true });
onBeforeUnmount(() => { revision++; clearTimeout(timer); });
</script>

<template>
  <section class="ipa-downloads" aria-label="音标资料下载">
    <div class="download-actions">
      <button class="btn xs" type="button" :disabled="!current?.exists || currentBusy" @click="downloadCurrent">
        {{ personal ? '下载个人录音' : '下载当前音标' }}<span v-if="current?.exists"> [{{ referenceTarget(current) }}]</span>
      </button>
      <a v-if="status === 'ready'" class="btn xs" :href="libraryUrl + '/download' + variant"
         :download="video ? 'IPA-VoQS-全部录音及声带视频.zip' : 'IPA-VoQS-全部录音.zip'">下载全部音标 ZIP</a>
      <button v-else type="button" class="btn xs" :disabled="libraryBusy || status === 'building'" @click="libraryRequest(true, revision)">
        {{ status === 'building' ? '正在打包 ' + progress : '打包全部音标' }}
      </button>
      <label title="仅为有声门轨迹的录音生成 MP4。首次打包全库视频需要较长时间。"><input v-model="video" type="checkbox" />附声带运动视频</label>
    </div>
    <small v-if="currentMessage || libraryMessage" role="status" :title="[currentMessage, libraryMessage].filter(Boolean).join(' · ')">
      {{ [currentMessage, libraryMessage].filter(Boolean).join(' · ') }}
    </small>
    <small v-else-if="status === 'building'" role="status">正在逐项检查录音与缺项，可继续浏览音标。</small>
    <small v-else>
      <template v-if="current?.exists && !personal">当前含原录音{{ current.has_textgrid ? '、人工 TextGrid' : '' }}{{ canReconstruct ? '、重建音和构型轨迹' : current.voqs && current.has_glottis ? '、声门参数' : '' }} · </template>全库<span v-if="count"> {{ count }} 条</span> IPA 和 VoQS 录音，缺项见清单
    </small>
  </section>
</template>

<style scoped>
.ipa-downloads { flex:none; display:grid; grid-template-columns:minmax(0, 1fr); gap:3px; padding:5px 10px; border-top:1px solid var(--border); }
.download-actions { display:flex; align-items:center; flex-wrap:wrap; gap:4px 10px; }
.download-actions label { display:inline-flex; align-items:center; gap:4px; }
.download-actions a { text-decoration:none; }
.ipa-downloads small { color:var(--muted); line-height:16px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
</style>
