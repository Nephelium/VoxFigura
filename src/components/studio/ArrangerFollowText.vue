<script setup lang="ts">
import { ref, watch } from 'vue';
import type { TextSpan } from './arranger-edit';

const props = defineProps<{ id: string; rows: number; placeholder: string; mono?: boolean; span?: TextSpan }>();
const text = defineModel<string>({ required: true });
const emit = defineEmits<{ apply: [] }>();
const editor = ref<HTMLTextAreaElement>();
const readout = ref<HTMLElement>();
const highlight = ref<HTMLElement>();
const focused = ref(false);

function syncScroll() {
  if (editor.value && readout.value) readout.value.scrollTop = editor.value.scrollTop;
}

watch(() => [props.span, focused.value], () => {
  const viewport = readout.value;
  const word = highlight.value;
  const input = editor.value;
  if (!viewport || !word || !input || focused.value) return;
  syncScroll();
  const rect = viewport.getBoundingClientRect();
  const item = word.getBoundingClientRect();
  const scale = Math.max(.01, rect.height / viewport.offsetHeight);
  const top = (item.top - rect.top) / scale;
  const bottom = (item.bottom - rect.top) / scale;
  if (top < 4) viewport.scrollTop += top - 4;
  else if (bottom > viewport.clientHeight - 4) viewport.scrollTop += bottom - viewport.clientHeight + 4;
  input.scrollTop = viewport.scrollTop;
}, { flush: 'post' });
</script>

<template>
  <div class="follow-field" :class="{ following: span && !focused, mono }">
    <textarea :id="id" ref="editor" v-model="text" class="inp follow-editor" :class="mono ? 'score-input mono' : 'lyric-input'"
      :rows="rows" :placeholder="placeholder" :spellcheck="!mono" @focus="focused = true" @blur="focused = false"
      @scroll="syncScroll" @keydown.ctrl.enter.prevent="emit('apply')" />
    <div v-if="span && !focused" ref="readout" class="follow-readout" aria-hidden="true">{{ text.slice(0, span.start) }}<mark ref="highlight">{{ text.slice(span.start, span.end) }}</mark>{{ text.slice(span.end) }}</div>
  </div>
</template>

<style scoped>
.follow-field { position: relative; flex: 0 0 auto; line-height: 0; }
.follow-editor, .follow-readout { width: 100%; padding: 6px 8px; font-family: inherit; font-size: .958333rem; line-height: 1.5; font-variant-numeric: tabular-nums; }
.follow-editor { min-height: 52px; resize: vertical; }
.follow-field.mono .follow-editor, .follow-field.mono .follow-readout { font-size:.84rem; }
.score-input { min-height: 40px; }
.follow-readout {
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  border: var(--border-w, 1px) solid transparent; white-space: pre-wrap; overflow-wrap: break-word;
  scrollbar-gutter: stable; color: var(--text);
}
.following .follow-editor { color: transparent; }
.follow-readout mark {
  color: var(--text); background: color-mix(in srgb, var(--accent) 32%, var(--panel));
  border-radius: 3px; box-shadow: inset 0 -2px var(--accent);
}
</style>
