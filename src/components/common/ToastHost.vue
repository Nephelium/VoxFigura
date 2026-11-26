<script setup lang="ts">
import { useWorkbenchStore } from '@/stores/workbench';
import IconSvg from './IconSvg.vue';

const store = useWorkbenchStore();
</script>

<template>
  <Teleport to="body">
    <div class="vc-toast-host" aria-live="polite" aria-atomic="false">
      <div
        v-for="item in store.toasts.value"
        :key="item.id"
        class="vc-toast"
        :class="`kind-${item.kind}`"
      >
        <IconSvg
          :name="
            item.kind === 'success'
              ? 'check'
              : item.kind === 'danger' || item.kind === 'warning'
                ? 'warn'
                : 'info'
          "
          :size="14"
        />
        <span class="vc-toast-msg">{{ item.message }}</span>
        <button
          type="button"
          class="vc-toast-close"
          aria-label="关闭通知"
          @click="store.dismissToast(item.id)"
        >
          <IconSvg name="close" :size="12" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.vc-toast-host {
  position: fixed;
  right: 16px;
  bottom: 34px;
  z-index: 980;
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: 360px;
  pointer-events: none;
}

.vc-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border-radius: var(--r-panel);
  background: var(--popover-bg);
  backdrop-filter: var(--glass-backdrop);
  border: var(--border-w, 1px) solid var(--panel-border);
  border-left: 3.5px solid var(--accent);
  box-shadow: var(--popover-shadow);
  color: var(--text);
  font-size: 0.958333rem;
}

.vc-toast.kind-success {
  border-left-color: var(--success);
}
.vc-toast.kind-warning {
  border-left-color: var(--warning);
}
.vc-toast.kind-danger {
  border-left-color: var(--danger);
}

.vc-toast-msg {
  flex: 1;
  min-width: 0;
  line-height: 1.45;
  word-break: break-word;
}

.vc-toast-close {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 2px;
  display: inline-flex;
  align-items: center;
}

.vc-toast-close:hover {
  color: var(--text);
}
</style>
