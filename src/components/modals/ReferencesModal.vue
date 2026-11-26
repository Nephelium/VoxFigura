<script setup lang="ts">
import { computed, ref } from 'vue';
import { METHOD_REFERENCES, type MethodReference } from '@/data/references';
import { useWorkbenchStore } from '@/stores/workbench';
import CustomSelect, { type SelectOption } from '@/components/common/CustomSelect.vue';
import IconSvg from '@/components/common/IconSvg.vue';

defineProps<{ inline?: boolean }>();
const store = useWorkbenchStore();

const query = ref('');
const groupFilter = ref<'all' | 'academic' | 'software'>('all');
const moduleFilter = ref<string>('ALL');

const MODULE_DISPLAY_ORDER: readonly string[] = [
  '核心引擎与模型',
  '工作台与基础架构',
  '语音合成',
  '国际音标表 Plus',
  '声道动态重建',
  '发声调音台',
  '声道连续统',
  '发音字典管理',
  '编曲',
  '剪辑',
  '发音卡工坊',
];

const allModules = computed<SelectOption[]>(() => {
  const countsMap = new Map<string, number>();
  for (const r of METHOD_REFERENCES) {
    for (const m of r.modules) {
      countsMap.set(m, (countsMap.get(m) ?? 0) + 1);
    }
  }
  const sorted = [...countsMap.keys()].sort((a, b) => {
    const ia = MODULE_DISPLAY_ORDER.indexOf(a);
    const ib = MODULE_DISPLAY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b, 'zh-CN');
  });
  return [
    { value: 'ALL', label: `全部模块 (${METHOD_REFERENCES.length})` },
    ...sorted.map((m) => ({ value: m, label: `${m} (${countsMap.get(m) ?? 0})` })),
  ];
});

const counts = computed(() => {
  let academic = 0;
  let software = 0;
  for (const r of METHOD_REFERENCES) {
    if (r.acknowledgement_group === 'academic') academic += 1;
    else software += 1;
  }
  return { total: METHOD_REFERENCES.length, academic, software };
});

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return METHOD_REFERENCES.filter((r) => {
    if (groupFilter.value === 'academic' && r.acknowledgement_group !== 'academic') return false;
    if (groupFilter.value === 'software' && r.acknowledgement_group === 'academic') return false;
    if (moduleFilter.value !== 'ALL' && !r.modules.includes(moduleFilter.value)) return false;
    if (!q) return true;
    const hay = `${r.id} ${r.title} ${r.authors} ${r.modules.join(' ')} ${r.citation} ${r.license} ${r.reference_note}`.toLowerCase();
    return hay.includes(q);
  }).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
});

function formatGb7714(r: MethodReference): string {
  if (r.citation && r.citation.trim()) return r.citation.trim();
  const url = Object.values(r.urls)[0] ?? '';
  return `${r.authors || 'Contributors'}. ${r.title}[EB/OL]${url ? `. ${url}` : ''}.`;
}

async function copyCitation(r: MethodReference): Promise<void> {
  const txt = formatGb7714(r);
  try {
    await navigator.clipboard.writeText(txt);
    store.pushToast(`已复制引用信息：${r.id}`, 'success', 2200);
  } catch {
    store.pushToast('剪贴板不可用，请手动选中复制', 'warning');
  }
}

async function copyAllFiltered(): Promise<void> {
  const txt = filtered.value.map((r, i) => `[${i + 1}] ${formatGb7714(r)}`).join('\n');
  try {
    await navigator.clipboard.writeText(txt);
    store.pushToast(`已复制当前筛选的 ${filtered.value.length} 条引用信息`, 'success', 2400);
  } catch {
    store.pushToast('剪贴板复制失败', 'warning');
  }
}

function close(): void {
  store.referencesModalOpen.value = false;
}
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <div
      v-if="inline || store.referencesModalOpen.value"
      :class="inline ? 'references-inline' : 'export-modal-mask'"
      :role="inline ? 'region' : 'dialog'"
      :aria-modal="inline ? undefined : true"
      aria-label="学术引用与开源软件致谢清单"
      @click.self="!inline && close()"
    >
      <div class="export-modal-card ref-modal-card">
        <div class="p-head">
          <span style="display: flex; align-items: center; gap: 8px">
            <strong>学术引用与开源软件致谢</strong>
            <span class="tree-tag">共 {{ counts.total }} 条（学术 {{ counts.academic }} · 开源 {{ counts.software }}）</span>
          </span>
          <button v-if="!inline" type="button" class="btn xs icon-only" title="关闭" @click="close">
            <IconSvg name="close" :size="13" />
          </button>
        </div>

        <div class="ref-toolbar">
          <div class="seg">
            <button type="button" :class="{ active: groupFilter === 'all' }" @click="groupFilter = 'all'">
              全部 ({{ counts.total }})
            </button>
            <button type="button" :class="{ active: groupFilter === 'academic' }" @click="groupFilter = 'academic'">
              学术文献 ({{ counts.academic }})
            </button>
            <button type="button" :class="{ active: groupFilter === 'software' }" @click="groupFilter = 'software'">
              开源软件与数据 ({{ counts.software }})
            </button>
          </div>

          <CustomSelect
            size="sm"
            style="width: 190px"
            :min-menu-width="210"
            :model-value="moduleFilter"
            :options="allModules"
            @update:model-value="(v) => (moduleFilter = String(v))"
          />

          <input
            v-model="query"
            class="inp"
            style="flex: 1; min-width: 160px; height: 24px"
            placeholder="检索作者、标题、模块或 DOI…"
          />

          <button type="button" class="btn sm primary" @click="copyAllFiltered">
            <IconSvg name="copy" :size="12" />
            <span>复制筛选 ({{ filtered.length }})</span>
          </button>
        </div>

        <div class="p-body ref-list-body">
          <div v-if="filtered.length === 0" class="muted" style="text-align: center; padding: 32px 0">
            没有匹配的文献或开源致谢条目。
          </div>

          <article v-for="item in filtered" :key="item.id" class="ref-row">
            <div class="ref-row-top">
              <div style="display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap">
                <span class="mono muted" style="font-size: 0.833333rem">{{ item.id }}</span>
                <span class="tree-tag">{{ item.acknowledgement_group === 'academic' ? '学术文献' : '开源/资产' }}</span>
                <span v-for="m in item.modules" :key="m" class="ref-mod-pill mono">{{ m }}</span>
                <span v-if="item.license" class="ref-lic-pill mono">{{ item.license }}</span>
              </div>
              <button type="button" class="btn xs" @click="copyCitation(item)">
                <IconSvg name="copy" :size="11" />
                <span>复制引用信息</span>
              </button>
            </div>

            <h4 class="ref-title selectable">{{ item.title }}</h4>
            <div v-if="item.authors" class="muted selectable" style="font-size: 0.883333rem">作者/维护者：{{ item.authors }}</div>
            <div class="ref-cite selectable">{{ formatGb7714(item) }}</div>
            <div v-if="item.reference_note" class="muted" style="font-size: 0.866667rem">{{ item.reference_note }}</div>

            <div v-if="Object.keys(item.urls).length > 0" class="ref-links">
              <a
                v-for="(href, label) in item.urls"
                :key="label"
                :href="href"
                target="_blank"
                rel="noopener noreferrer"
                class="ref-link-item"
              >
                <span>{{ label }}</span>
                <IconSvg name="external-link" :size="10" />
              </a>
            </div>
          </article>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ref-modal-card {
  width: 880px;
  max-width: 96vw;
  height: 84vh;
}

.ref-toolbar {
  flex: none;
  padding: 9px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--sidebar) 45%, transparent);
}

.ref-list-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

.ref-row {
  border: var(--border-w, 1px) solid var(--panel-border);
  border-radius: var(--r-ctrl);
  padding: 9px 11px;
  background: color-mix(in srgb, var(--app) 62%, transparent);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ref-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ref-title {
  margin: 0;
  font-size: 1.016667rem;
  color: var(--text);
}

.ref-cite {
  font-size: 0.9rem;
  line-height: 1.55;
  padding: 4px 8px;
  border-left: 2px solid var(--accent);
  background: color-mix(in srgb, var(--panel) 72%, transparent);
  border-radius: 0 4px 4px 0;
}

.ref-mod-pill,
.ref-lic-pill {
  font-size: 0.791667rem;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--panel-border);
  background: color-mix(in srgb, var(--panel) 80%, transparent);
  color: var(--muted);
}

.ref-links {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.ref-link-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.866667rem;
}
.references-inline .ref-modal-card { width:100%; max-width:none; height:auto; max-height:none; position:static; margin:0; box-sizing:border-box; }
.references-inline .ref-list-body { overflow:visible; }
</style>
