<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import ModelConnection from '@/components/ai/ModelConnection.vue';
import { renderMarkdown } from '@/components/ai/markdown-render';
import { renderChatMath } from './explore-math';
import { useWorkbenchStore } from '@/stores/workbench';
import { KANSHAN_ASSETS, KANSHAN_QUIPS } from './cases';
import * as session from './session';
import type { KanshanMood } from './session';
import {
  runKanshanChatTurn,
  type KanshanExploreSnapshot,
  type KanshanUiMessage,
} from './kanshan-ai';

const props = defineProps<{
  getExploreSnapshot: () => KanshanExploreSnapshot;
  recordings?: boolean;
  phonationDemo?: boolean;
}>();

const emit = defineEmits<{
  quickAction: [action: 'demo' | 'compare' | 'auditionAb' | 'reset'];
}>();

const wb = useWorkbenchStore();
const configured = computed(
  () =>
    Boolean(
      wb.aiToolsApiKey.value.trim() &&
        wb.aiToolsBaseUrl.value.trim() &&
        wb.aiToolsModel.value.trim(),
    ),
);

const configOpen = ref(false);
const askInput = ref('');
const messages = ref<KanshanUiMessage[]>([]);
const chatBusy = ref(false);
const chatStage = ref('');
const feedRef = ref<HTMLDivElement | null>(null);
const imgFallback = ref(false);
const bouncing = ref(false);
let activeAbort: AbortController | null = null;
let msgSeq = 1;

const starterPrompts = [
  '检索知乎上关于当前音的讨论，并结合声道构型讲讲发音要领',
  '对比当前音 A 与音 B 的舌位、唇形和共振峰差异',
  '查查本地项目知识库里 VTL 2.4 与 Tract2Vox-Lite 是怎么协同工作的',
];

const MOOD_CYCLE: KanshanMood[] = ['idle', 'greet', 'sway', 'computer', 'dribble', 'sleepy'];
let quipIdx = 0;

const assetInfo = computed(
  () => KANSHAN_ASSETS[session.exploreKanshanMood.value] ?? KANSHAN_ASSETS.idle,
);

function onClickAvatar(): void {
  const curIdx = MOOD_CYCLE.indexOf(session.exploreKanshanMood.value);
  const nextMood = MOOD_CYCLE[(curIdx + 1) % MOOD_CYCLE.length];
  session.exploreKanshanMood.value = nextMood;
  session.exploreKanshanText.value = KANSHAN_QUIPS[quipIdx % KANSHAN_QUIPS.length];
  quipIdx += 1;
  bouncing.value = false;
  requestAnimationFrame(() => {
    bouncing.value = true;
    window.setTimeout(() => {
      bouncing.value = false;
    }, 520);
  });
}

async function scrollFeedToBottom(): Promise<void> {
  await nextTick();
  if (feedRef.value) {
    feedRef.value.scrollTop = feedRef.value.scrollHeight;
  }
}

function abortChat(): void {
  activeAbort?.abort();
  activeAbort = null;
  chatBusy.value = false;
  chatStage.value = '';
  session.exploreKanshanMood.value = 'idle';
}

function stopChat(): void {
  abortChat();
  messages.value.push({ id: `e_${msgSeq++}`, role: 'assistant', text: '本轮对话已停止。', error: true });
  void scrollFeedToBottom();
}

function clearConversation(): void {
  abortChat();
  messages.value = [];
}

async function sendQuestion(overrideText?: string): Promise<void> {
  const q = (overrideText ?? askInput.value).trim();
  if (!q || chatBusy.value) return;

  if (!configured.value) {
    configOpen.value = true;
    if (!overrideText) askInput.value = q;
    wb.pushToast('请先在此配置模型 API Key，即可直接与刘看山对话', 'info', 2600);
    return;
  }

  configOpen.value = false;
  const priorHistory = [...messages.value];
  messages.value.push({
    id: `u_${msgSeq++}`,
    role: 'user',
    text: q,
  });
  if (!overrideText) askInput.value = '';
  const ctrl = new AbortController();
  activeAbort = ctrl;
  chatBusy.value = true;
  chatStage.value = '刘看山正在思考…';
  session.exploreKanshanMood.value = 'computer';
  void scrollFeedToBottom();

  try {
    const { reply, sources, continuation } = await runKanshanChatTurn({
      history: priorHistory,
      userText: q,
      apiKey: wb.aiToolsApiKey.value.trim(),
      baseUrl: wb.aiToolsBaseUrl.value.trim(),
      model: wb.aiToolsModel.value.trim(),
      getSnapshot: props.getExploreSnapshot,
      getZhihuHeaders: () => session.getZhihuHeaders(),
      onStatus: (stage) => {
        chatStage.value = stage;
      },
      signal: ctrl.signal,
    });
    if (ctrl.signal.aborted) return;
    messages.value.push({
      id: `a_${msgSeq++}`,
      role: 'assistant',
      text: reply,
      sources,
      continuation,
    });
    session.exploreKanshanMood.value = 'greet';
  } catch (err) {
    if (ctrl.signal.aborted) return;
    const errMsg = err instanceof Error ? err.message : '与刘看山对话未完成，请检查模型配置或网络。';
    messages.value.push({
      id: `e_${msgSeq++}`,
      role: 'assistant',
      text: errMsg,
      error: true,
    });
    session.exploreKanshanMood.value = 'sleepy';
  } finally {
    if (activeAbort === ctrl) {
      activeAbort = null;
      chatBusy.value = false;
      chatStage.value = '';
    }
    await scrollFeedToBottom();
  }
}

function onInputKeydown(ev: KeyboardEvent): void {
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    void sendQuestion();
  }
}

watch(configured, (ok) => {
  if (ok && configOpen.value) {
    configOpen.value = false;
  }
});

onBeforeUnmount(() => {
  activeAbort?.abort();
});

defineExpose({
  sendQuestion,
});
</script>

<template>
  <section class="kanshan-dock">
    <div class="kanshan-chat-bar">
      <strong class="chat-bar-label">与刘看山对话</strong>
      <div class="chat-bar-right">
        <button
          v-if="messages.length > 0"
          type="button"
          class="btn sm"
          :disabled="chatBusy"
          @click="clearConversation"
        >
          清空对话
        </button>
        <button
          type="button"
          class="btn sm"
          :class="{ active: configOpen }"
          @click="configOpen = !configOpen"
        >
          <i :class="configured ? 'dot-ok' : 'dot-warn'" style="margin-right: 4px" />
          <span>{{ configured ? '已连模型' : '配置 API' }}</span>
        </button>
      </div>
    </div>

    <div v-if="configOpen" class="kanshan-config-pop">
      <ModelConnection @saved="configOpen = false" />
    </div>

    <!-- Scrollable Inline Conversation Feed -->
    <div ref="feedRef" class="kanshan-chat-feed selectable">
      <div class="kanshan-hero-bar">
        <div class="kanshan-stage">
          <div class="kanshan-halo" aria-hidden="true" />
          <button
            type="button"
            class="kanshan-gif-btn"
            :class="{ bouncing }"
            title="点击切换刘看山动态神态"
            @click="onClickAvatar"
          >
            <img
              v-if="!imgFallback"
              :src="assetInfo.url"
              alt="刘看山智能伴读"
              @error="imgFallback = true"
            />
            <svg v-else viewBox="0 0 64 64" width="62" height="62" aria-label="刘看山">
              <circle cx="32" cy="36" r="18" fill="var(--panel)" stroke="var(--border)" stroke-width="2" />
              <polygon points="18,22 23,10 29,21" fill="var(--panel)" stroke="var(--border)" stroke-width="1.5" />
              <polygon points="46,22 41,10 35,21" fill="var(--panel)" stroke="var(--border)" stroke-width="1.5" />
              <circle cx="25" cy="33" r="2.3" fill="var(--text)" />
              <circle cx="39" cy="33" r="2.3" fill="var(--text)" />
              <ellipse cx="32" cy="39" rx="4" ry="2.6" fill="var(--accent)" />
            </svg>
          </button>
          <div class="kanshan-ground" />
        </div>
  
        <div class="kanshan-meta-col">
          <div class="kanshan-head-row">
            <strong class="kanshan-name">刘看山伴读</strong>
            <span class="kanshan-status-pill">{{ assetInfo.tag }}</span>
            <span class="readonly-pill" title="可检索知乎 CLI 与本地知识库/源码，只读不改工程文件">只读检索</span>
          </div>
  
          <p class="kanshan-tip">{{ session.exploreKanshanText.value }}</p>
  
          <div class="kanshan-actions">
            <button v-if="!phonationDemo && !recordings" type="button" class="btn sm" @click="emit('quickAction', 'demo')">过渡演示</button>
            <button type="button" class="btn sm" @click="emit('quickAction', 'compare')">{{ recordings ? '重叠对照' : '双音对照' }}</button>
            <button type="button" class="btn sm" @click="emit('quickAction', 'auditionAb')">{{ recordings ? '同步试听' : '顺序试听' }}</button>
            <button type="button" class="btn sm" @click="emit('quickAction', 'reset')">复位</button>
          </div>
        </div>
      </div>
  
        <template v-if="messages.length === 0">
        <div class="kanshan-empty-guide">
          <p class="muted">
            可以问当前发音，也可以查询知乎讨论和项目资料。
          </p>
          <div class="starter-list">
            <button
              v-for="sp in starterPrompts"
              :key="sp"
              type="button"
              class="starter-btn"
              @click="sendQuestion(sp)"
            >
              {{ sp }}
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="chat-msg"
          :class="[msg.role === 'user' ? 'is-user' : 'is-kanshan', { 'is-error': msg.error }]"
        >
          <div v-if="msg.role === 'assistant'" class="msg-author-row">
            <span class="msg-author-badge">刘看山</span>
            <span
              v-for="src in msg.sources ?? []"
              :key="src"
              class="msg-source-chip"
            >
              {{ src }}
            </span>
          </div>
          <div
            v-if="msg.role === 'assistant'"
            class="msg-markdown"
            v-html="renderChatMath(renderMarkdown(msg.text))"
          />
          <div v-else class="msg-user-text">{{ msg.text }}</div>
        </div>
      </template>

      <div v-if="chatBusy" class="chat-busy-row" role="status">
        <span class="busy-dot" />
        <span class="muted">{{ chatStage || '刘看山正在思考…' }}</span>
        <button type="button" class="btn sm" style="margin-left: auto" @click="stopChat">停止</button>
      </div>
    </div>

    <!-- Direct Inline Composer (Never opens global right-hand AiDrawer) -->
    <div class="kanshan-composer">
      <textarea
        v-model="askInput"
        aria-label="向刘看山提问"
        rows="2"
        class="inp kanshan-textarea"
        :placeholder="
          configured
            ? '向刘看山提问（回车发送，Shift+回车换行；可查知乎与本地知识库）…'
            : '先点击上方「配置 API」，即可在此与刘看山直接对话…'
        "
        @keydown="onInputKeydown"
      />
      <button
        type="button"
        class="btn sm primary"
        :disabled="chatBusy || !askInput.trim()"
        @click="sendQuestion()"
      >
        发送
      </button>
    </div>
  </section>
</template>

<style scoped>
.kanshan-dock {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}

.kanshan-hero-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 10px;
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--selected) 44%, var(--panel));
  border: var(--border-w, 1px) solid var(--panel-border);
  flex: none;
}

/* Enlarged Liu Kanshan stage with generous breathing room around the character */
.kanshan-stage {
  position: relative;
  width: 92px;
  height: 92px;
  padding: 10px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 16px;
  background: radial-gradient(
    circle at 50% 48%,
    color-mix(in srgb, var(--panel) 84%, var(--accent) 16%) 0%,
    color-mix(in srgb, var(--app) 58%, transparent) 100%
  );
  border: 1px solid color-mix(in srgb, var(--panel-border) 72%, transparent);
}

.kanshan-halo {
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--panel) 60%, var(--accent) 22%) 0%,
    transparent 74%
  );
  pointer-events: none;
}

.kanshan-ground {
  position: absolute;
  bottom: 7px;
  left: 50%;
  transform: translateX(-50%);
  width: 52px;
  height: 8px;
  border-radius: 50%;
  background: radial-gradient(
    ellipse at center,
    color-mix(in srgb, var(--accent) 26%, rgba(0, 0, 0, 0.24)) 0%,
    transparent 72%
  );
  pointer-events: none;
}

.kanshan-gif-btn {
  position: relative;
  width: 72px;
  height: 72px;
  flex: none;
  border: 0;
  padding: 2px;
  background: transparent;
  cursor: pointer;
  transition: transform 0.18s var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
  display: grid;
  place-items: center;
}

.kanshan-gif-btn:hover {
  transform: translateY(-2px) scale(1.05);
}

.kanshan-gif-btn.bouncing {
  animation: kanshanBounce 0.48s cubic-bezier(0.22, 1.25, 0.36, 1);
}

@keyframes kanshanBounce {
  0% {
    transform: scale(1, 1) translateY(0);
  }
  28% {
    transform: scale(1.08, 0.9) translateY(2px);
  }
  62% {
    transform: scale(0.96, 1.06) translateY(-6px) rotate(2deg);
  }
  100% {
    transform: scale(1, 1) translateY(0);
  }
}

.kanshan-gif-btn img {
  width: 68px;
  height: 68px;
  object-fit: contain;
  display: block;
  filter: drop-shadow(0 4px 10px rgba(8, 18, 40, 0.18));
}

.kanshan-meta-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kanshan-head-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
}

.kanshan-name {
  font-size: 0.958333rem;
  color: var(--accent);
}

.kanshan-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
  background: color-mix(in srgb, var(--app) 72%, transparent);
  border: 1px solid var(--panel-border);
  color: var(--teal);
}

.kanshan-status-pill::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.readonly-pill {
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 0.75rem;
  color: var(--muted);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--panel) 80%, transparent);
}

.kanshan-tip {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.44;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.kanshan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.kanshan-chat-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  flex: none;
}

.chat-bar-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}

.chat-bar-right {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.kanshan-config-pop {
  padding: 8px 9px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 68%, var(--panel));
  max-height: min(250px, 42%);
  overflow-y: auto;
  flex: none;
}

.kanshan-chat-feed {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: thin;
  padding: 8px 9px;
  border-radius: var(--r-panel);
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--app) 54%, var(--panel));
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-family: var(--font-ui);
  font-variant-numeric: lining-nums tabular-nums;
}

.kanshan-empty-guide {
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 0.833333rem;
  line-height: 1.48;
}

.kanshan-empty-guide p {
  margin: 0;
}

.starter-list {
  display: grid;
  grid-auto-rows: 1fr;
  gap: 5px;
}

.starter-btn {
  min-height: var(--control-height-sm);
  text-align: left;
  padding: 2px 8px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--panel);
  color: var(--text);
  font-size: var(--control-font-size-sm);
  line-height: 1.2;
  cursor: pointer;
}

.starter-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--selected);
}

.chat-msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.875rem;
  line-height: 1.54;
}

.chat-msg.is-user {
  align-self: flex-end;
  max-width: 88%;
  padding: 6px 9px;
  border-radius: 10px 10px 2px 10px;
  background: var(--accent);
  color: var(--on-accent);
}

.chat-msg.is-kanshan {
  align-self: stretch;
  padding: 7px 9px;
  border-radius: 10px 10px 10px 3px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  color: var(--text);
}

.chat-msg.is-error {
  border-color: color-mix(in srgb, var(--danger, #d93025) 55%, var(--panel-border));
}

.msg-author-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}

.msg-author-badge {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--accent);
}

.msg-source-chip {
  font-size: 0.72rem;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--selected) 68%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--panel-border));
  color: var(--muted);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-markdown :deep(p) {
  margin: 0 0 6px;
}
.msg-markdown :deep(p:last-child) {
  margin-bottom: 0;
}
.msg-markdown :deep(ul),
.msg-markdown :deep(ol) {
  margin: 3px 0 6px;
  padding-left: 18px;
}
.msg-markdown :deep(code) {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--selected);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}
.msg-markdown :deep(pre) {
  margin: 4px 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--app) 80%, transparent);
  overflow-x: auto;
}
.msg-markdown :deep(a) {
  color: var(--accent);
  text-decoration: underline;
}

.msg-markdown { overflow-wrap: anywhere; }
.msg-markdown :deep(.md-table-wrap) { overflow-x: auto; }
.msg-markdown :deep(table) { border-collapse: collapse; font-size: 0.85em; }
.msg-markdown :deep(th), .msg-markdown :deep(td) { padding: 3px 6px; border: 1px solid var(--panel-border); }
.msg-markdown :deep(h1), .msg-markdown :deep(h2), .msg-markdown :deep(h3) { font-size: 1.06em; margin: 5px 0; }
.msg-markdown :deep(blockquote) {
  margin: 4px 0;
  padding-left: 8px;
  border-left: 2px solid var(--accent);
}

.msg-user-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-busy-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  font-size: 0.8125rem;
}

.busy-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulseDot 1s ease-in-out infinite;
}

@keyframes pulseDot {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.88);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}

.kanshan-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  align-items: end;
  flex: none;
}

.kanshan-textarea {
  resize: none;
  min-height: 44px;
  max-height: 92px;
  padding: 5px 8px;
  line-height: 1.42;
  font-size: 0.875rem;
}
</style>
