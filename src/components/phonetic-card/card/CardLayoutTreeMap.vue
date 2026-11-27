<script setup lang="ts">
import { computed } from 'vue';
import {
  CARD_MODULE_MAP,
  normalizeRatios,
  type CardLayoutNode,
  type CardModuleId,
} from './layout-tree';

defineOptions({ name: 'CardLayoutTreeMap' });

const props = defineProps<{
  node: CardLayoutNode;
  selectedLeafId: string | null;
  depth?: number;
}>();

const emit = defineEmits<{
  (e: 'select', leafId: string, moduleId: CardModuleId | null): void;
}>();

const ratios = computed(() =>
  props.node.kind === 'split'
    ? normalizeRatios(props.node.ratios, props.node.children.length)
    : [],
);

function leafLabel(modId: CardModuleId | null): string {
  return modId ? (CARD_MODULE_MAP.get(modId)?.shortTitle ?? modId) : '留白';
}
</script>

<template>
  <button
    v-if="node.kind === 'leaf'"
    type="button"
    class="tree-leaf-tile"
    :class="{
      active: selectedLeafId === node.id,
      empty: node.moduleId === null,
    }"
    :title="node.moduleId ? `${leafLabel(node.moduleId)} · 点击选中编辑占比与模块` : '留白空槽 · 点击选中后可填入模块或保留留白'"
    @click="emit('select', node.id, node.moduleId)"
  >
    <span class="tile-name">{{ leafLabel(node.moduleId) }}</span>
  </button>

  <div
    v-else
    class="tree-split-box"
    :class="node.dir === 'row' ? 'is-row' : 'is-col'"
  >
    <div
      v-for="(child, idx) in node.children"
      :key="child.id"
      class="tree-split-branch"
      :style="{ flexGrow: Math.max(0.12, ratios[idx] ?? 1) }"
    >
      <CardLayoutTreeMap
        :node="child"
        :selected-leaf-id="selectedLeafId"
        :depth="(depth ?? 0) + 1"
        @select="(lid, mid) => emit('select', lid, mid)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-split-box {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  display: flex;
  gap: 3px;
}

.tree-split-box.is-row {
  flex-direction: row;
}

.tree-split-box.is-col {
  flex-direction: column;
}

.tree-split-branch {
  flex-basis: 0;
  min-width: 0;
  min-height: 0;
  display: flex;
}

.tree-leaf-tile {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 24px;
  padding: 2px 4px;
  border-radius: max(2px, calc(var(--r-ctrl) - 2px));
  border: var(--border-w, 1px) solid var(--panel-border);
  background: var(--panel);
  color: var(--text);
  font-size: 0.72rem;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out-expo), background-color var(--dur-fast) var(--ease-out-expo);
}

.tree-leaf-tile:hover {
  border-color: var(--accent);
}

.tree-leaf-tile.empty {
  border-style: dashed;
  background: color-mix(in srgb, var(--app) 70%, transparent);
  color: var(--muted);
}

.tree-leaf-tile.active {
  border-color: var(--accent);
  background: var(--selected);
  color: var(--accent);
  font-weight: 700;
  box-shadow: inset 0 0 0 1px var(--accent);
}

.tile-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
</style>
