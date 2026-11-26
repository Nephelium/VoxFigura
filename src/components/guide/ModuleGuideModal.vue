<script setup lang="ts">
import { computed } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import GuideModuleArticle from '@/components/guide/GuideModuleArticle.vue';
import { getGuideModuleById } from '@/data/guide-content';
import { useWorkbenchStore } from '@/stores/workbench';

const store = useWorkbenchStore();
const currentModule = computed(() => getGuideModuleById(store.activeModuleGuide.value));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="currentModule"
      class="mg-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="`${currentModule.navTitle} 使用说明`"
      @click.self="store.closeModuleGuide()"
    >
      <div class="panel mg-dialog">
        <header class="p-head mg-head">
          <div class="mg-title-row">
            <IconSvg :name="currentModule.icon" :size="16" />
            <strong>{{ currentModule.title }}</strong>
            <span class="tree-tag">{{ currentModule.perspectiveBadge }}</span>
          </div>
          <div class="mg-actions">
            <button
              type="button"
              class="btn sm"
              title="打开整合全部模块的系统使用说明"
              @click="store.openGuideSection(currentModule.sectionAnchor)"
            >
              <IconSvg name="book" :size="13" />
              <span>完整系统使用说明</span>
            </button>
            <button
              type="button"
              class="btn sm icon-only"
              aria-label="关闭使用说明"
              @click="store.closeModuleGuide()"
            >
              <IconSvg name="close" :size="14" />
            </button>
          </div>
        </header>

        <div class="mg-scroll">
          <GuideModuleArticle :module="currentModule" standalone />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 220;
  background: rgba(8, 12, 22, 0.56);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  padding: 20px;
}

.mg-dialog {
  width: min(94vw, 1120px);
  height: min(88vh, 900px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.38);
}

.mg-head {
  flex: none;
  padding: 10px 14px;
  gap: 10px;
}

.mg-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.mg-title-row strong {
  font-size: 1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mg-actions {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: none;
}

.mg-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px 16px;
}
</style>
