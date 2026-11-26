<script setup lang="ts">
import IconSvg from '@/components/common/IconSvg.vue';

defineProps<{
  acquiring: boolean;
  recording: boolean;
  elapsed: string;
  bars: readonly number[];
  quiet: boolean;
  announceQuiet?: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <div class="mic-control">
    <div class="mic-actions">
      <slot />
      <button
        type="button"
        class="btn sm"
        :class="{ 'mic-recording': recording }"
        :disabled="acquiring"
        @click="emit('toggle')"
      >
        <i v-if="recording" class="record-dot" aria-hidden="true" />
        <IconSvg v-else name="mic" :size="12" />
        <span>{{ recording ? '结束录音' : '麦克风录音' }}</span>
        <span v-if="recording" class="mono record-time" aria-hidden="true">{{ elapsed }}</span>
      </button>
    </div>
    <div v-if="recording" class="mic-level" aria-hidden="true">
      <i v-for="(bar, index) in bars" :key="index" :style="{ transform: `scaleY(${0.1 + bar * 0.9})` }" />
    </div>
    <small v-if="recording && quiet" class="mic-quiet" :role="announceQuiet ? 'status' : undefined">
      未检测到声音，请检查麦克风输入
    </small>
  </div>
</template>

<style scoped>
.mic-control {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.mic-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.mic-recording {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 60%, var(--border));
  background: color-mix(in srgb, var(--danger) 11%, var(--panel));
}

.record-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  animation: record-pulse 1.35s ease-in-out infinite;
}

@keyframes record-pulse {
  50% { opacity: 0.48; transform: scale(0.76); }
}

.record-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.mic-level {
  display: grid;
  grid-template-columns: repeat(18, 1fr);
  align-items: center;
  gap: 3px;
  width: min(100%, 280px);
  height: 22px;
  padding: 0 6px;
  border-radius: var(--r-ctrl);
  background: color-mix(in srgb, var(--danger) 8%, var(--panel));
}

.mic-level i {
  height: 16px;
  min-width: 0;
  border-radius: 2px;
  background: var(--danger);
  transition: transform 70ms ease-out;
}

.mic-quiet {
  color: var(--danger);
  font-size: 0.916667rem;
}

@media (prefers-reduced-motion: reduce) {
  .record-dot { animation: none; }
  .mic-level i { transition: none; }
}
</style>
