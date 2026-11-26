<script setup lang="ts">
import { computed, ref } from 'vue';
import { panelSnapshots } from '@/data/panel-snapshots';
import { m27Session } from '@/components/research/m27-session';
import IconSvg from '@/components/common/IconSvg.vue';
import type { CardPlaybackSourceId } from './playback-sources';
import {
  CARD_MODULES,
  type CardModuleCategory,
  type CardModuleId,
  type CardModuleMeta,
} from './layout-tree';

const props = defineProps<{
  selectedIds: readonly CardModuleId[];
}>();

const emit = defineEmits<{
  (e: 'toggle', id: CardModuleId): void;
  (e: 'apply-preset', ids: CardModuleId[], source?: CardPlaybackSourceId): void;
  (e: 'drag-module-start', id: CardModuleId, ev: DragEvent): void;
}>();

const category = ref<CardModuleCategory>('all');

const categories: ReadonlyArray<{ id: CardModuleCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'explore', label: '声道声学' },
  { id: 'ipa-synth', label: '音标合成' },
  { id: 'reconstruct-mixer', label: '重建调音' },
  { id: 'continuum-dialect', label: '连续统方言' },
  { id: 'studio', label: '编曲剪辑' },
];

const presets: ReadonlyArray<{ id: string; label: string; modules: CardModuleId[]; source?: CardPlaybackSourceId }> = [
  {
    id: 'quad-acoustic',
    label: '声道四联',
    modules: ['tract-profile', 'cross-lip', 'transfer-fn', 'vowel-space'],
  },
  {
    id: 'synth-demo',
    label: '合成演播',
    modules: ['tract-profile', 'synth-timeline', 'vowel-space', 'transfer-fn'],
    source: 'auto',
  },
  {
    id: 'ipa-recon',
    label: '音标+重建',
    modules: ['ipa-wave-spec', 'ipa-lexicon'],
  },
  {
    id: 'mixer-cont',
    label: '调音连续统',
    modules: ['continuum-grid', 'voice-mixer', 'artic-metrics'],
  },
  {
    id: 'song-stage',
    label: '编曲旋律',
    modules: ['arranger-roll', 'tract-profile', 'transfer-fn'],
  },
];

const visibleModules = computed<CardModuleMeta[]>(() =>
  category.value === 'all' ? [...CARD_MODULES] : CARD_MODULES.filter((m) => m.category === category.value),
);

function orderIndex(id: CardModuleId): number {
  return props.selectedIds.indexOf(id);
}

function hasLiveData(id: CardModuleId): boolean {
  switch (id) {
    case 'ipa-wave-spec':
    case 'ipa-lexicon':
      return Boolean(panelSnapshots.ipa.value);
    case 'synth-timeline':
      return Boolean(panelSnapshots.synthesis.value?.audioBuffer || panelSnapshots.synthesis.value?.clip?.syllable_order.length);
    case 'm27-reconstruct':
      return m27Session.rows.value.length > 0;
    case 'voice-mixer':
      return Boolean(panelSnapshots.mixer.value?.outputBlob || panelSnapshots.mixer.value);
    case 'continuum-grid':
      return Boolean(panelSnapshots.continuum.value?.cells.length);
    case 'dialect-sandhi':
      return Boolean(panelSnapshots.dialect.value?.tones.length);
    case 'arranger-roll':
      return Boolean(panelSnapshots.arranger.value?.notes.length);
    default:
      return true;
  }
}

function onNativeDragStart(id: CardModuleId, ev: DragEvent): void {
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', id);
  }
  emit('drag-module-start', id, ev);
}
</script>

<template>
  <aside class="module-gallery" aria-label="发音卡可选模块库">
    <div class="gallery-top">
      <div class="gallery-title-row">
        <strong>模块元素库</strong>
        <span class="mono muted">已选 {{ selectedIds.length }} 项</span>
      </div>
      <p class="gallery-sub muted">点击勾选或拖入右侧卡面，声道模型与各页模块均可自由增删。</p>

      <div class="preset-heading">推荐组合</div>
      <div class="preset-strip" role="group" aria-label="推荐组合">
        <button
          v-for="p in presets"
          :key="p.id"
          type="button"
          class="preset-chip"
          @click="emit('apply-preset', p.modules, p.source)"
        >
          {{ p.label }}
        </button>
        <button
          type="button"
          class="preset-chip clear-chip"
          :disabled="selectedIds.length === 0"
          @click="emit('apply-preset', [])"
        >
          清空
        </button>
      </div>

      <div class="cat-tabs" role="tablist" aria-label="模块分类筛选">
        <button
          v-for="c in categories"
          :key="c.id"
          type="button"
          role="tab"
          class="cat-tab"
          :class="{ active: category === c.id }"
          :aria-selected="category === c.id"
          @click="category = c.id"
        >
          {{ c.label }}
        </button>
      </div>
    </div>

    <div class="gallery-list">
      <button
        v-for="mod in visibleModules"
        :key="mod.id"
        type="button"
        class="mod-card"
        :class="{ selected: orderIndex(mod.id) >= 0 }"
        :aria-pressed="orderIndex(mod.id) >= 0"
        draggable="true"
        @click="emit('toggle', mod.id)"
        @dragstart="onNativeDragStart(mod.id, $event)"
      >
        <!-- Vector Miniature Preview Thumbnail (Zero Emoji) -->
        <div class="mod-thumb" aria-hidden="true">
          <svg viewBox="0 0 88 56" fill="none">
            <rect x="1" y="1" width="86" height="54" rx="5" class="th-bg" />
            <template v-if="mod.id === 'tract-profile'">
              <path d="M24 45V32C24 21 32 13 44 13c9 0 16 4 20 11l7 2-3 3 3 3-5 3c-2 6-7 8-14 8H40" class="th-line-strong" />
              <path d="M28 41c3-9 10-15 20-15 5 0 10 2 14 5-6 6-14 10-27 11z" class="th-fill" />
              <path d="M29 28c4-7 13-11 22-10m-9 15h7m-3-3v6" class="th-grid" />
              <circle cx="46" cy="33" r="2" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'glottis-model'">
              <ellipse cx="29" cy="28" rx="10.5" ry="16" class="th-grid-box" />
              <path d="M29 14c5 10 5 18 0 27-5-9-5-17 0-27z" class="th-fill" />
              <path d="M46 12v32m18-32v32" class="th-dash" />
              <path d="M51 40V17h9l-2 9-3 5zm26 0V17h-9l2 9 3 5z" class="th-fill" />
              <path d="M53 35c0-7 3-9 5-14m17 14c0-7-3-9-5-14" class="th-accent" />
            </template>
            <template v-else-if="mod.id === 'cross-lip'">
              <path d="M16 28h22m-11-11v22m17-25v28" class="th-grid" />
              <ellipse cx="27" cy="28" rx="9" ry="7" class="th-fill" />
              <circle cx="27" cy="28" r="1.8" class="th-dot" />
              <path d="M49 28c5-7 10-10 16-8 6-2 11 1 15 8-5 6-10 8-15 8s-11-2-16-8z" class="th-fill" />
              <path d="M54 28c4-3 8-4 11-3 3-1 7 0 10 3-4 3-7 4-10 4s-7-1-11-4z" class="th-line-sub" />
            </template>
            <template v-else-if="mod.id === 'area-fn'">
              <path d="M13 17v27h65m-65-10h65m-65-10h65" class="th-grid" />
              <path d="M14 41l9-10 8 3 9-14 10 8 9 12 8-8 10-13v25H14z" class="th-fill" />
              <path d="M14 41l9-10 8 3 9-14 10 8 9 12 8-8 10-13" class="th-line-strong" />
              <path d="M59 17v23" class="th-dash" />
              <circle cx="59" cy="40" r="2.5" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'transfer-fn'">
              <path d="M12 18v26h66M12 34h66M12 24h66" class="th-grid" />
              <path d="M14 42c7-2 9-9 12-19s4-12 7-1 5 14 8 10c4-3 5-12 8-12 4 0 5 13 10 14 4 1 6-10 10-10 3 0 3 8 8 10v10H14z" class="th-soft-fill" />
              <path d="M14 42c7-2 9-9 12-19s4-12 7-1 5 14 8 10c4-3 5-12 8-12 4 0 5 13 10 14 4 1 6-10 10-10 3 0 3 8 8 10" class="th-line-strong" />
              <circle cx="29.7" cy="15.5" r="2.3" class="th-dot" />
              <circle cx="49" cy="20" r="2.3" class="th-dot" />
              <circle cx="69" cy="24" r="2.3" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'vowel-space'">
              <path d="M22 15v30h56m-56-10h53m-53-10h53m-38-10v30m15-30v30m15-30v30" class="th-grid" />
              <path d="M24 18l49 1-9 23-24-1z" class="th-dash" />
              <path d="M31 23c8 9 19 13 31 2" class="th-accent" />
              <circle cx="31" cy="23" r="2.8" class="th-dot" />
              <path d="m62 21 4 4-4 4-4-4z" class="th-fill" />
              <circle cx="47" cy="35" r="1.8" class="th-point" />
            </template>
            <template v-else-if="mod.id === 'artic-metrics'">
              <rect x="13" y="12" width="62" height="32" rx="4" class="th-grid-box" />
              <path d="M13 22h62m-42-10v32M34 33h40" class="th-grid" />
              <path d="M19 17h8m-8 10h8m-8 12h8m14-22h26m-26 10h19m-19 12h12" class="th-line-sub" />
              <path d="M42 27h15m-15 12h9" class="th-accent" />
              <circle cx="59" cy="27" r="2" class="th-dot" />
              <circle cx="53" cy="39" r="2" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'ipa-wave-spec'">
              <rect x="12" y="11" width="64" height="14" rx="2.5" class="th-grid-box" />
              <rect x="12" y="29" width="64" height="15" rx="2.5" class="th-grid-box" />
              <path d="M16 18h9l3-2 3 5 3-7 3 8 3-4h5l4-3 4 6 4-7 4 8 3-4h8" class="th-line-sub" />
              <path d="M19 39h14m-10-4h6m8 3h20m-16-5h10m4 8h15m-8-6h6" class="th-accent" />
              <path d="M47 10v35" class="th-dash" />
            </template>
            <template v-else-if="mod.id === 'ipa-lexicon'">
              <rect x="16" y="12" width="28" height="32" rx="4" class="th-fill" />
              <text x="30" y="35" text-anchor="middle" class="th-ipa">ɑ</text>
              <path d="M51 17h23m-23 10h19m-19 10h12" class="th-line-sub" />
              <path d="M51 17h12" class="th-accent" />
              <circle cx="69" cy="37" r="2" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'synth-timeline'">
              <rect x="13" y="12" width="63" height="11" rx="2.5" class="th-grid-box" />
              <rect x="13" y="26" width="63" height="8" rx="2" class="th-grid-box" />
              <path d="M33 13v9m22-9v9M23 27v6m12-6v6m22-6v6m11-6v6" class="th-grid" />
              <path d="M33 15h20v5H33zm3 12h12v6H36z" class="th-soft-fill" />
              <path d="M15 43c12 0 18-6 28-5s14-4 21-4l11 3" class="th-line-strong" />
              <path d="M48 10v35" class="th-dash" />
              <circle cx="48" cy="38" r="2" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'm27-reconstruct'">
              <path d="M14 14h60v10H14z" class="th-grid-box" />
              <path d="M17 19h8l2-3 3 6 3-4 4 1 3-3 4 6 4-4 3 1 3-2 2 4 4-4 3 2h8" class="th-accent" />
              <path d="M14 33h60m-60 8h60" class="th-grid" />
              <path d="M15 39c8 0 12-9 23-8s16 5 24 4l11-3m-58 9c12 4 17 3 27 1 14-3 18 1 31-1" class="th-line-sub" />
              <path d="M43 13v32" class="th-dash" />
              <circle cx="43" cy="32" r="2" class="th-dot" />
            </template>
            <template v-else-if="mod.id === 'voice-mixer'">
              <path d="M16 17h56m-56 11h56m-56 11h56" class="th-line-sub" />
              <path d="M16 17h20m-20 11h35m-35 11h12" class="th-accent" />
              <circle cx="36" cy="17" r="4" class="th-fill" />
              <circle cx="51" cy="28" r="4" class="th-fill" />
              <circle cx="28" cy="39" r="4" class="th-fill" />
              <path d="M64 34v10m4-8v6m4-10v14" class="th-dash" />
            </template>
            <template v-else-if="mod.id === 'continuum-grid'">
              <rect x="12" y="15" width="13" height="25" rx="2.5" class="th-grid-box" />
              <rect x="29" y="15" width="13" height="25" rx="2.5" class="th-grid-box" />
              <rect x="46" y="15" width="13" height="25" rx="2.5" class="th-fill" />
              <rect x="63" y="15" width="13" height="25" rx="2.5" class="th-grid-box" />
              <path d="M15 33q4-5 7-3m10 2q3-6 7-4m10 3q3-7 7-5m10 3q3-8 7-6" class="th-line-sub" />
              <path d="M18 45h52l-3-3m3 3-3 3" class="th-accent" />
            </template>
            <template v-else-if="mod.id === 'dialect-sandhi'">
              <path d="M13 17h42m-42 7h42m-42 7h42m-42 7h42m-42 7h42" class="th-grid" />
              <path d="M16 24l14 14 20-17" class="th-line-strong" />
              <path d="M16 20h14l20 10" class="th-accent" />
              <circle cx="16" cy="24" r="2" class="th-point" />
              <circle cx="50" cy="30" r="2.1" class="th-dot" />
              <rect x="61" y="14" width="15" height="11" rx="2" class="th-fill" />
              <rect x="61" y="32" width="15" height="11" rx="2" class="th-grid-box" />
              <path d="M68.5 26v5m-2-2 2 2 2-2" class="th-dash" />
            </template>
            <template v-else-if="mod.id === 'arranger-roll'">
              <path d="M15 14h60v29H15z" class="th-grid-box" />
              <path d="M25 14v29m13-29v29m13-29v29m13-29v29m-49-22h60m-60 7h60m-60 7h60" class="th-grid" />
              <path d="M15 21h6m-6 7h6m-6 7h6" class="th-line-sub" />
              <rect x="25" y="34" width="12" height="5" rx="1.4" class="th-fill" />
              <rect x="38" y="27" width="10" height="5" rx="1.4" class="th-fill" />
              <rect x="50" y="20" width="12" height="5" rx="1.4" class="th-fill" />
              <rect x="64" y="24" width="8" height="5" rx="1.4" class="th-fill" />
            </template>
            <template v-else-if="mod.id === 'stage-nle'">
              <path d="M13 13h62m-48 0v4m12-4v4m12-4v4m12-4v4" class="th-grid" />
              <rect x="13" y="19" width="35" height="9" rx="2" class="th-fill" />
              <rect x="50" y="19" width="25" height="9" rx="2" class="th-grid-box" />
              <rect x="13" y="33" width="61" height="10" rx="2" class="th-grid-box" />
              <path d="M17 38h5l3-2 3 4 4-2 4-1 4 2 4-3 4 4 4-2 5 1 4-2 4 1h4" class="th-line-sub" />
              <path d="M47.5 13v31m-3-31h6l-3 4z" class="th-accent" />
            </template>
          </svg>
          <span v-if="orderIndex(mod.id) >= 0" class="mod-order mono">{{ orderIndex(mod.id) + 1 }}</span>
        </div>

        <div class="mod-info">
          <div class="mod-head-line">
            <strong class="mod-name">{{ mod.shortTitle }}</strong>
            <span class="mod-page-tag" :class="{ live: hasLiveData(mod.id) }">{{ mod.sourcePage }}</span>
          </div>
          <span class="mod-desc muted">{{ mod.desc }}</span>
        </div>

        <span class="mod-check" aria-hidden="true">
          <IconSvg :name="orderIndex(mod.id) >= 0 ? 'check' : 'plus'" :size="12" />
        </span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.module-gallery {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--panel-border);
  background: var(--panel);
}

.gallery-top {
  padding: 11px 12px 9px;
  border-bottom: 1px solid var(--panel-border);
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: none;
}

.gallery-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.958333rem;
}

.gallery-sub {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.42;
}

.preset-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.preset-heading {
  color: var(--muted);
  font-size: 0.791667rem;
  font-weight: 600;
}

.preset-chip {
  height: 26px;
  padding: 0 4px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--selected);
  color: var(--accent);
  font-size: 0.791667rem;
  font-weight: 600;
  cursor: pointer;
}
.preset-chip:not(:disabled):hover {
  border-color: var(--accent);
}
.clear-chip {
  background: var(--ctrl-bg);
  color: var(--muted);
}
.clear-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.cat-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  border-top: 1px solid var(--panel-border);
  padding-top: 8px;
}

.cat-tab {
  height: 22px;
  padding: 0 4px;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: transparent;
  color: var(--muted);
  font-size: 0.791667rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cat-tab:hover {
  color: var(--text);
  border-color: var(--border);
}
.cat-tab.active {
  background: var(--selected);
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}

.gallery-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  scrollbar-width: thin;
}

.mod-card {
  width: 100%;
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  text-align: left;
  border-radius: var(--r-ctrl);
  border: 1px solid var(--panel-border);
  background: var(--ctrl-bg);
  color: var(--text);
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.mod-card:hover {
  border-color: var(--accent);
}

.mod-card.selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--selected) 75%, var(--panel));
}

.mod-thumb {
  position: relative;
  width: 74px;
  height: 47px;
  border-radius: 4px;
  overflow: hidden;
  color: var(--text);
}

.mod-thumb svg {
  width: 100%;
  height: 100%;
  display: block;
}

.th-bg {
  fill: color-mix(in srgb, var(--app) 86%, var(--panel));
  stroke: color-mix(in srgb, var(--panel-border) 80%, var(--muted));
  stroke-width: 1;
}
.th-line-strong {
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.th-line-sub {
  stroke: var(--muted);
  stroke-width: 1.35;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.th-fill {
  fill: color-mix(in srgb, var(--accent) 22%, transparent);
  stroke: currentColor;
  stroke-width: 1.4;
}
.th-grid {
  stroke: var(--panel-border);
  stroke-width: 1.1;
}
.th-grid-box {
  fill: var(--panel);
  stroke: var(--panel-border);
  stroke-width: 1.1;
}
.th-dash {
  stroke: var(--muted);
  stroke-width: 1.2;
  stroke-dasharray: 3 2.5;
}
.th-dot { fill: var(--accent); }
.th-point { fill: var(--panel); stroke: var(--muted); stroke-width: 1; }
.th-soft-fill { fill: color-mix(in srgb, var(--accent) 16%, transparent); }
.th-accent {
  stroke: var(--accent);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.th-ipa {
  font: 700 20px var(--font-ipa);
  fill: currentColor;
}

.mod-order {
  position: absolute;
  top: 2px;
  left: 2px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border-radius: 4px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 0.72rem;
  font-weight: 700;
  display: grid;
  place-items: center;
}

.mod-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mod-head-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.mod-name {
  font-size: 0.875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mod-page-tag {
  flex: none;
  font-size: 0.72rem;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--panel-border);
  color: var(--muted);
}

.mod-page-tag.live {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--panel-border));
  color: var(--accent);
}

.mod-desc {
  font-size: 0.775rem;
  line-height: 1.32;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.mod-check {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--muted);
  background: var(--panel);
  border: 1px solid var(--panel-border);
}

.mod-card.selected .mod-check {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}
</style>
