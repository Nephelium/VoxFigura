<script setup lang="ts">
import { computed } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import GuideModuleArticle from '@/components/guide/GuideModuleArticle.vue';
import { getGuideModuleById } from '@/data/guide-content';
import { getTourDefinition, type TourPageId } from '@/data/onboarding-tours';
import { useOnboardingStore } from '@/stores/onboarding';
import { useWorkbenchStore } from '@/stores/workbench';

const store = useWorkbenchStore();
const onboarding = useOnboardingStore();
const currentModule = computed(() => getGuideModuleById(store.activeModuleGuide.value));
const currentTourId = computed<TourPageId | null>(() => {
  const id = currentModule.value?.id;
  if (!id) return null;
  return getTourDefinition(id as TourPageId) ? (id as TourPageId) : null;
});
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
      <div class="panel mg-dialog guide-reading-scope">
        <header class="p-head mg-head">
          <div class="mg-title-row">
            <IconSvg :name="currentModule.icon" :size="17" />
            <strong>{{ currentModule.title }}</strong>
            <span class="tree-tag">{{ currentModule.perspectiveBadge }}</span>
          </div>
          <div class="mg-actions">
            <button
              v-if="currentTourId"
              type="button"
              class="btn sm"
              title="回到页面并重新播放交互式操作指引"
              @click="onboarding.openTourAndNavigate(store, currentTourId)"
            >
              <IconSvg name="play" :size="13" />
              <span>重看操作指引</span>
            </button>
            <button
              type="button"
              class="btn sm"
              title="打开整合全部模块的系统使用说明"
              @click="store.openGuideSection(currentModule.sectionAnchor)"
            >
              <IconSvg name="book" :size="14" />
              <span>完整系统使用说明</span>
            </button>
            <button
              type="button"
              class="btn sm icon-only"
              aria-label="关闭使用说明"
              @click="store.closeModuleGuide()"
            >
              <IconSvg name="close" :size="15" />
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
  background: var(--overlay);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
  padding: 20px;
}

.mg-dialog {
  --guide-fs-title: 1.16rem;
  --guide-fs-lead: 1.08rem;
  --guide-fs-subhead: 1.04rem;
  --guide-fs-body: 1rem;
  --guide-fs-text: 0.95rem;
  --guide-fs-code: 0.9rem;
  --guide-fs-meta: 0.86rem;
  --guide-ink-body: color-mix(in srgb, var(--text) 88%, var(--muted));
  width: min(95vw, 1240px);
  height: min(90vh, 960px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  box-shadow: var(--panel-shadow);
}

.mg-head {
  flex: none;
  padding: 12px 18px;
  gap: 12px;
}

.mg-title-row {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  overflow: hidden;
}

.mg-title-row strong {
  font-size: var(--guide-fs-title);
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mg-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.mg-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px 22px;
}

.guide-reading-scope :deep(.p-head) {
  font-size: var(--guide-fs-title);
  min-height: 36px;
}

.guide-reading-scope :deep(.param-sec-title) {
  font-size: var(--guide-fs-subhead);
  line-height: 1.45;
  color: var(--text);
}

.guide-reading-scope :deep(.param-sec-title .muted) {
  font-size: var(--guide-fs-meta);
}

.guide-reading-scope :deep(.tree-tag) {
  font-size: var(--guide-fs-meta);
  padding: 2px 7px;
}

.guide-reading-scope :deep(.btn.sm) {
  min-height: 28px;
  padding: 3px 10px;
  font-size: var(--guide-fs-meta);
}

.guide-reading-scope :deep(.btn.xs) {
  min-height: 24px;
  padding: 2px 8px;
  font-size: var(--guide-fs-meta);
}

.guide-reading-scope :deep(.tech-chart-title-row) {
  font-size: var(--guide-fs-subhead);
  line-height: 1.45;
}

.guide-reading-scope :deep(.tech-chart-sub) {
  font-size: var(--guide-fs-text);
  line-height: 1.58;
  color: var(--guide-ink-body);
}

.guide-reading-scope :deep(.tech-chart-cap) {
  font-size: var(--guide-fs-text);
  line-height: 1.66;
  color: var(--guide-ink-body);
  padding: 10px 14px;
}
</style>
