<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { DEEPSEEK_API_BASE, isDeepSeekApiBase } from '@/data/deepseek';
import { useWorkbenchStore } from '@/stores/workbench';

const store = useWorkbenchStore();
const emit = defineEmits<{ saved: [] }>();
const base = ref(store.aiToolsBaseUrl.value);
const model = ref(store.aiToolsModel.value);
const key = ref(store.aiToolsApiKey.value);
const deepSeekAsr = ref(store.deepSeekAsrEnabled.value);
const isDeepSeek = computed(() => isDeepSeekApiBase(base.value));
const asrHelpId = useId();
const deepSeekChatModel = 'deepseek-flash';
const error = ref('');
const presets = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { name: 'DeepSeek', url: DEEPSEEK_API_BASE },
  { name: '自定义', url: '' },
];

function choose(baseUrl: string) {
  if (base.value === baseUrl) return;
  base.value = baseUrl;
  key.value = '';
  model.value = baseUrl === DEEPSEEK_API_BASE ? deepSeekChatModel : '';
  error.value = '';
}

function save() {
  try {
    const endpoint = new URL(base.value.trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
    if (!(endpoint.protocol === 'https:' || local && endpoint.protocol === 'http:') ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
  } catch {
    error.value = '请输入 HTTPS 服务地址。本机服务也可使用 HTTP。';
    return;
  }
  const modelId = model.value.trim() || (isDeepSeek.value ? deepSeekChatModel : '');
  if (!modelId || !key.value.trim()) {
    error.value = '请填写模型 ID 和 API Key。';
    return;
  }
  model.value = modelId;
  store.setAiToolsCredentials(base.value, key.value, modelId, deepSeekAsr.value);
  error.value = '';
  store.pushToast('模型连接配置已保存', 'success');
  emit('saved');
}

function forget() {
  key.value = '';
  store.setAiToolsCredentials(store.aiToolsBaseUrl.value, '', store.aiToolsModel.value);
  store.pushToast('已清除本页密钥', 'info');
}
</script>

<template>
  <form class="model-config" @submit.prevent="save">
    <div class="config-presets seg" aria-label="模型服务商">
      <button v-for="item in presets" :key="item.name" type="button" :class="{ active: item.url ? base === item.url : !presets.some(p => p.url && p.url === base) }" @click="choose(item.url)">{{ item.name }}</button>
    </div>
    <label>服务地址 <input v-model="base" class="inp mono" type="url" autocomplete="off" required placeholder="https://…/v1" @input="key = ''" /></label>
    <label>模型 ID <input v-model="model" class="inp mono" autocomplete="off" :required="!isDeepSeek" :placeholder="isDeepSeek ? deepSeekChatModel : '填写平台提供的模型 ID'" /></label>
    <label>API Key <input v-model="key" class="inp mono" type="password" autocomplete="off" spellcheck="false" required placeholder="输入此服务的 API Key" /></label>
    <label class="asr-option">
      <input v-model="deepSeekAsr" type="checkbox" :disabled="!isDeepSeek" :aria-describedby="asrHelpId" />
      用 DeepSeek 自动识别声道重建的参考文本
    </label>
    <p :id="asrHelpId">{{ isDeepSeek
      ? '启用后，点击「自动识别文本」会将当前录音发送给 DeepSeek，按音频时长计费。'
      : '选择 DeepSeek 并填写 API Key 即可启用云端语音识别。' }}</p>
    <p>支持 Chat Completions 兼容接口。密钥仅保留在当前页面内存中，刷新后需要重新输入。</p>
    <p v-if="error" class="config-error" role="alert">{{ error }}</p>
    <div class="config-actions">
      <button class="btn primary sm" type="submit">保存配置</button>
      <button v-if="store.aiToolsApiKey.value" class="btn sm" type="button" @click="forget">清除密钥</button>
    </div>
  </form>
</template>
<style scoped>
.model-config { display:grid; gap:12px; width:100%; max-width:480px; color:var(--text); }
.config-presets { justify-self:start; }
.model-config label { display:grid; gap:5px; font-weight:600; font-size:0.916667rem; }
.model-config input { width:100%; min-width:0; height:32px; font-weight:400; }
.model-config .asr-option { display:flex; align-items:center; gap:8px; }
.model-config .asr-option input { width:16px; height:16px; margin:0; }
.model-config p { margin:0; font-size:0.916667rem; line-height:1.65; color:var(--muted); }
.model-config .config-error { color:var(--danger); }
.config-actions { display:flex; gap:8px; }
</style>
