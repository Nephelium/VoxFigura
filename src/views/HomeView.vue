<script setup lang="ts">
import { computed } from 'vue';
import IconSvg from '@/components/common/IconSvg.vue';
import NavArtwork from '@/components/common/NavArtwork.vue';
import CustomSelect from '@/components/common/CustomSelect.vue';
import SpeakerReferenceControls from '@/components/common/SpeakerReferenceControls.vue';
import VoiceRenderSelect from '@/components/common/VoiceRenderSelect.vue';
import { openCardStudio } from '@/components/phonetic-card/session';
import { APP_BRAND_NAME } from '@/data/app-branding';
import { describeEngineStatus } from '@/data/engine-status';
import { textPoseOptions, textPoseSource } from '@/data/ipa-pose-source';
import { recentToolIds, type RecentToolId } from '@/data/recent-tools';
import { selectWorkbenchNav, WORKBENCH_NAV_ITEMS } from '@/data/workbench-nav';
import { workspaceIconUrl } from '@/data/workspace-images';
import { useWorkbenchStore } from '@/stores/workbench';
import { mix } from '@/styles/themes';

interface HomeToolEntry {
  id: RecentToolId;
  fallbackLabel: string;
  detail: string;
}

interface HomeToolGroup {
  code: string;
  label: string;
  icon: string;
  entries: readonly HomeToolEntry[];
}

const store = useWorkbenchStore();
const navMap = new Map(WORKBENCH_NAV_ITEMS.map((item) => [item.id, item]));

// Map sprite luminance to the current palette while keeping the original alpha and shading.
const homeArtworkRamp = computed(() => {
  const palette = store.activePalette.value;
  const accent = palette['--accent'];
  const dark = store.resolvedColorMode.value === 'dark';
  const colors = [
    mix(accent, palette['--text'], dark ? 0.60 : 0.72),
    accent,
    mix(accent, palette['--panel'], dark ? 0.66 : 0.69),
  ];
  return [1, 3, 5].map((offset) => colors
    .map((color) => (Number.parseInt(color.slice(offset, offset + 2), 16) / 255).toFixed(4))
    .join(' '));
});

const TOOL_GROUPS: readonly HomeToolGroup[] = [
  {
    code: '01',
    label: '发音与重建',
    icon: 'phonetics-group',
    entries: [
      {
        id: 'ipa',
        fallbackLabel: '国际音标表 Plus',
        detail: 'IPA、extIPA 与 VoQS 查表听音，查看舌位与语谱对照。',
      },
      {
        id: 'main',
        fallbackLabel: '语音合成',
        detail: '输入文字或音标，联动物理声道与神经声码器调控音高和时长。',
      },
      {
        id: 'm27',
        fallbackLabel: '声道动态重建',
        detail: '导入录音反演 50 Hz 动态声道构型与三视图解剖动画。',
      },
    ],
  },
  {
    code: '02',
    label: '调控与实验',
    icon: 'experiment-group',
    entries: [
      {
        id: 'mixer',
        fallbackLabel: '发声调音台',
        detail: '时变调制发声类型，或在双人音色特征之间平滑混合。',
      },
      {
        id: 'continuum',
        fallbackLabel: '声道连续统',
        detail: '在两个声道构型间连续插值，生成 20 格实验感知刺激矩阵。',
      },
      {
        id: 'dialect',
        fallbackLabel: '发音字典管理',
        detail: '维护发音词条、手绘五度方言调型与三类连读变调规则。',
      },
    ],
  },
  {
    code: '03',
    label: '编曲与导出',
    icon: 'production-group',
    entries: [
      {
        id: 'arranger',
        fallbackLabel: '编曲',
        detail: '编写逐字简谱与歌词，在钢琴卷帘中微调音高、抢拍与演唱。',
      },
      {
        id: 'stage',
        fallbackLabel: '剪辑',
        detail: '将声道动画、伴奏录音与字幕排入多轨时间线并实时监看。',
      },
      {
        id: 'card',
        fallbackLabel: '发音卡',
        detail: '拼排声道解剖图、语谱图与声学标注，导出高清图片或动画。',
      },
    ],
  },
];

const ENTRY_LOOKUP = new Map<RecentToolId, HomeToolEntry>(
  TOOL_GROUPS.flatMap((group) => group.entries.map((entry) => [entry.id, entry] as const)),
);

const STARTER_IDS: readonly RecentToolId[] = ['ipa', 'main', 'm27'];

function toolLabel(id: RecentToolId): string {
  return navMap.get(id)?.label ?? ENTRY_LOOKUP.get(id)?.fallbackLabel ?? '发音卡';
}

function toolArtwork(id: RecentToolId): string {
  return navMap.get(id)?.artwork ?? id;
}

function launchTool(id: RecentToolId): void {
  if (id === 'card') {
    openCardStudio('home');
    return;
  }
  const tool = navMap.get(id);
  if (tool) selectWorkbenchNav(store, tool);
}

const recentEntries = computed(() =>
  recentToolIds.value.map((id) => ({
    id,
    label: toolLabel(id),
    artwork: toolArtwork(id),
  })),
);

const starterEntries = computed(() =>
  STARTER_IDS.map((id) => ({
    id,
    label: toolLabel(id),
    artwork: toolArtwork(id),
  })),
);

const engineBadge = computed(() => {
  const info = describeEngineStatus(store.engineStatus.value);
  return { tone: info.tone, text: info.label };
});
</script>

<template>
  <main class="home-view" aria-labelledby="home-title">
    <svg class="home-artwork-filter" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <filter id="voxfigura-home-artwork-theme" color-interpolation-filters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="table" :tableValues="homeArtworkRamp[0]" />
            <feFuncG type="table" :tableValues="homeArtworkRamp[1]" />
            <feFuncB type="table" :tableValues="homeArtworkRamp[2]" />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
    <div class="home-stage">
      <!-- Hero Welcome Header -->
      <header class="home-hero">
        <div class="hero-identity">
          <div class="hero-icon-frame" aria-hidden="true">
            <img class="hero-icon" :src="workspaceIconUrl" alt="" />
          </div>
          <div class="hero-copy">
            <p class="hero-eyebrow mono">{{ APP_BRAND_NAME.toUpperCase() }} · 48 KHZ VOCAL TRACT STUDIO</p>
            <h1 id="home-title" class="hero-title">从这里开始</h1>
            <p class="hero-subtitle">选择一个工具，开展物理声道建模、发音实验或声乐编曲。</p>
          </div>
        </div>

        <div class="hero-actions">
          <button
            type="button"
            class="hero-pill engine-pill"
            data-tour="home-engine"
            :data-tone="engineBadge.tone"
            title="查看与配置本地引擎和模型"
            @click="store.openOverlay('settings', 'engine')"
          >
            <span class="engine-dot" aria-hidden="true" />
            <span class="engine-text">{{ engineBadge.text }}</span>
          </button>

          <div class="hero-btn-row">
            <button
              type="button"
              class="hero-pill action-pill"
              @click="store.openOverlay('settings', 'appearance')"
            >
              <NavArtwork item="workspace-background" />
              <span>外观与背景</span>
            </button>
            <button
              type="button"
              class="hero-pill action-pill"
              @click="store.referencesModalOpen.value = true"
            >
              <NavArtwork item="acknowledgments" />
              <span>开源与学术致谢</span>
            </button>
          </div>
        </div>
      </header>

      <section class="home-synthesis" data-tour="home-synthesis" aria-labelledby="home-synthesis-heading">
        <div class="section-bar">
          <h2 id="home-synthesis-heading">合成设置</h2>
          <span class="section-note">全局默认声纹、构型来源与声道渲染 · 实时同步至各工作台</span>
        </div>

        <div class="home-synthesis-grid">
          <article class="synth-card" data-tour="home-synth-speaker">
            <header class="synth-card-head">
              <span class="synth-badge" aria-hidden="true">
                <NavArtwork item="m27" class="tool-art" />
              </span>
              <div class="synth-copy">
                <strong class="synth-title">神经合成参考声纹</strong>
                <small class="synth-sub">Vox2Spk-Lite 提取 512 维音色</small>
              </div>
            </header>
            <div class="synth-card-ctrl">
              <SpeakerReferenceControls />
            </div>
          </article>

          <article class="synth-card" data-tour="home-synth-pose">
            <header class="synth-card-head">
              <span class="synth-badge" aria-hidden="true">
                <NavArtwork item="research" class="tool-art" />
              </span>
              <div class="synth-copy">
                <strong class="synth-title">音标转声道</strong>
                <small class="synth-sub">推荐自动切换：文本用模型，[IPA] 用构型库</small>
              </div>
            </header>
            <div class="synth-card-ctrl">
              <CustomSelect
                v-model="textPoseSource"
                :options="textPoseOptions"
                size="sm"
                class="synth-full-sel"
                aria-label="音标转声道构型来源"
                title="推荐使用自动切换：输入文本时使用模型默认构型，输入 [IPA] 时使用当前 IPA 构型，混排句子自动按段切换"
              />
            </div>
          </article>

          <article class="synth-card" data-tour="home-synth-render">
            <header class="synth-card-head">
              <span class="synth-badge" aria-hidden="true">
                <NavArtwork item="engine" class="tool-art" />
              </span>
              <div class="synth-copy">
                <strong class="synth-title">声道转语音</strong>
                <small class="synth-sub">Tract2Vox-Lite 声码器或 VTL 物理求解</small>
              </div>
            </header>
            <div class="synth-card-ctrl">
              <VoiceRenderSelect class="synth-full-sel" />
            </div>
          </article>
        </div>
      </section>

      <!-- All Tools Section -->
      <section class="home-catalog" data-tour="home-catalog" aria-labelledby="home-tools-heading">
        <div class="section-bar">
          <h2 id="home-tools-heading">全部工具</h2>
          <span class="section-note">9 个工作台入口 · 覆盖语音分析、声道调控与声乐创作</span>
        </div>

        <nav class="tool-groups" aria-label="全部工具">
          <section
            v-for="group in TOOL_GROUPS"
            :key="group.code"
            class="tool-group"
            :aria-label="group.label"
          >
            <header class="group-header">
              <span class="group-icon" aria-hidden="true">
                <NavArtwork :item="group.icon" :class="{ 'phonetics-art': group.icon === 'phonetics-group' }" />
              </span>
              <h3 class="group-title">{{ group.label }}</h3>
              <span class="group-code mono">{{ group.code }}</span>
            </header>

            <div class="group-list">
              <button
                v-for="entry in group.entries"
                :key="entry.id"
                type="button"
                class="tool-row"
                :data-tool-id="entry.id"
                @click="launchTool(entry.id)"
              >
                <span class="tool-badge" aria-hidden="true">
                  <NavArtwork :item="toolArtwork(entry.id)" class="tool-art" />
                </span>
                <span class="tool-copy">
                  <strong class="tool-name">{{ toolLabel(entry.id) }}</strong>
                  <small class="tool-desc">{{ entry.detail }}</small>
                </span>
                <IconSvg name="chevron-right" :size="14" class="tool-chevron" />
              </button>
            </div>
          </section>
        </nav>
      </section>

      <!-- Recently Used Panel -->
      <section class="recent-panel" aria-labelledby="home-recent-heading">
        <div class="section-bar recent-bar">
          <h2 id="home-recent-heading">
            <NavArtwork item="recent-tools" />
            <span>最近使用</span>
          </h2>
          <span class="section-note">
            {{ recentEntries.length ? '本机打开过的工具' : '尚未记录使用历史 · 可从常用入口起步' }}
          </span>
        </div>

        <div v-if="recentEntries.length" class="recent-chips">
          <button
            v-for="item in recentEntries"
            :key="item.id"
            type="button"
            class="recent-chip"
            @click="launchTool(item.id)"
          >
            <NavArtwork :item="item.artwork" class="chip-art" />
            <span>{{ item.label }}</span>
            <IconSvg name="chevron-right" :size="12" class="chip-arrow" />
          </button>
        </div>

        <div v-else class="recent-empty">
          <span class="recent-empty-copy">打开过的工具会作为快捷入口出现在这里</span>
          <div class="recent-chips">
            <button
              v-for="item in starterEntries"
              :key="item.id"
              type="button"
              class="recent-chip starter-chip"
              @click="launchTool(item.id)"
            >
              <NavArtwork :item="item.artwork" class="chip-art" />
              <span>{{ item.label }}</span>
              <IconSvg name="chevron-right" :size="12" class="chip-arrow" />
            </button>
          </div>
        </div>
      </section>

      <!-- Footer Guide & Technical Report Banners -->
      <div class="home-banners">
        <button type="button" class="guide-banner" @click="store.openOverlay('guide')">
          <span class="banner-icon" aria-hidden="true">
            <NavArtwork item="getting-started" />
          </span>
          <span class="banner-copy">
            <strong>第一次使用？</strong>
            <span>了解工作台基本操作、VoQS 标注语法与快捷键速查</span>
          </span>
          <span class="banner-action">
            <span>打开帮助</span>
            <IconSvg name="arrow-right" :size="13" />
          </span>
        </button>

        <button type="button" class="guide-banner" @click="store.openOverlay('model-report')">
          <span class="banner-icon" aria-hidden="true">
            <NavArtwork item="model-matrix" />
          </span>
          <span class="banner-copy">
            <strong>端侧 8 模矩阵</strong>
            <span>查阅 Vox2Tract-Lite、Tract2Vox-Lite 与 VTL 2.4 架构报告</span>
          </span>
          <span class="banner-action">
            <span>模型报告</span>
            <IconSvg name="arrow-right" :size="13" />
          </span>
        </button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.home-view {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  scrollbar-width: thin;
  animation: vcViewFadeIn 220ms var(--ease-out-expo, cubic-bezier(0.22, 1, 0.36, 1));
}

.home-artwork-filter {
  position: absolute;
}

.home-view :deep(.nav-art) {
  filter: url("#voxfigura-home-artwork-theme");
}

.home-stage {
  width: 100%;
  max-width: min(1520px, 100%);
  min-height: min(100%, 960px);
  margin: auto;
  padding: clamp(20px, 3vh, 44px) clamp(20px, 3.2vw, 48px) clamp(22px, 3vh, 42px);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: clamp(18px, 2.8vh, 36px);
}

.home-synthesis {
  display: flex;
  flex-direction: column;
}

.home-synthesis-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(14px, 1.35vw, 22px);
  align-items: stretch;
}

.synth-card {
  --card-accent: var(--accent);
  --card-tint: color-mix(in srgb, var(--accent) 11%, transparent);
  min-width: 0;
  border-radius: var(--r-panel);
  padding: 13px 15px 14px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 11px;
  background: linear-gradient(155deg, var(--card-tint), transparent 55%), var(--panel-bg);
  backdrop-filter: var(--glass-backdrop);
  -webkit-backdrop-filter: var(--glass-backdrop);
  border: var(--border-w) solid var(--panel-border);
  box-shadow: var(--panel-shadow);
  transition: border-color var(--dur-fast) var(--ease-out-expo);
}

.synth-card:hover {
  border-color: color-mix(in srgb, var(--card-accent) 44%, var(--panel-border));
}

.synth-card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.synth-badge {
  width: 30px;
  height: 30px;
  border-radius: var(--r-ctrl, 7px);
  flex: none;
  display: grid;
  place-items: center;
  color: var(--card-accent);
  background: color-mix(in srgb, var(--card-accent) 13%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--card-accent) 30%, transparent);
}

.synth-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.synth-title {
  font-size: 0.96rem;
  font-weight: 650;
  color: var(--text);
  line-height: 1.3;
}

.synth-sub {
  font-size: 0.81rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.synth-card-ctrl {
  display: flex;
  align-items: center;
  min-width: 0;
  width: 100%;
}

.synth-card-ctrl :deep(.synth-full-sel) {
  width: 100% !important;
  flex: 1 1 auto;
}

.synth-card-ctrl :deep(.vc-sel-btn:not(:disabled)) {
  background: var(--themed-button-bg);
  border-color: var(--themed-button-border);
}

.synth-card-ctrl :deep(.vc-sel-btn:not(:disabled):is(:hover, :focus-visible, [aria-expanded="true"])) {
  background: var(--themed-button-hover-bg);
}

/* Shared skin-aware card surface so all 8 skins & custom backdrops stay consistent */
.tool-group,
.recent-panel,
.guide-banner,
.hero-pill {
  background: var(--panel-bg);
  backdrop-filter: var(--glass-backdrop);
  -webkit-backdrop-filter: var(--glass-backdrop);
  border: var(--border-w) solid var(--panel-border);
  box-shadow: var(--panel-shadow);
}

/* Hero Welcome Header */
.home-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 6px 2px 10px;
  flex-wrap: wrap;
}

.hero-identity {
  display: flex;
  align-items: center;
  gap: 18px;
  min-width: 0;
}

.hero-icon-frame {
  width: clamp(60px, 4.8vw, 74px);
  height: clamp(60px, 4.8vw, 74px);
  flex: none;
  border-radius: var(--r-panel);
  padding: 4px;
  background: var(--panel-bg);
  backdrop-filter: var(--glass-backdrop);
  border: var(--border-w) solid var(--panel-border);
  box-shadow: var(--panel-shadow);
  display: grid;
  place-items: center;
}

.hero-icon {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: max(0px, calc(var(--r-panel) - 3px));
  display: block;
}

.hero-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hero-eyebrow {
  margin: 0;
  font-size: 0.84rem;
  font-weight: 600;
  letter-spacing: 0.13em;
  color: color-mix(in srgb, var(--accent) 82%, var(--muted));
}

.hero-title {
  margin: 0;
  font-family: var(--font-ui);
  font-size: clamp(1.95rem, 2.3vw, 2.45rem);
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--text);
  text-shadow: 0 1px 14px color-mix(in srgb, var(--app) 55%, transparent);
}

.hero-subtitle {
  margin: 2px 0 0;
  font-size: 1.04rem;
  color: color-mix(in srgb, var(--text) 72%, var(--muted));
  line-height: 1.5;
}

.hero-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  flex: none;
}

.hero-btn-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.hero-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-ctrl);
  color: var(--text);
  font-size: 0.94rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

.hero-pill:hover,
.hero-pill:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 52%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 68%, var(--panel));
  color: var(--accent);
  transform: translateY(-1px);
}

.action-pill {
  background: var(--themed-button-bg);
  border-color: var(--themed-button-border);
}

.engine-pill {
  height: 27px;
  padding: 0 11px;
  font-size: 0.88rem;
  border-radius: 999px;
}

.engine-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--warning);
}

.engine-pill[data-tone="ok"] .engine-dot {
  background: var(--success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 20%, transparent);
}

.engine-pill[data-tone="checking"] .engine-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}

.engine-text {
  color: color-mix(in srgb, var(--text) 85%, var(--muted));
}

/* Section Headers */
.section-bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  padding: 0 2px;
}

.section-bar h2 {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 1.08rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--text);
}

.section-note {
  font-size: 0.9rem;
  color: var(--muted);
}

/* 3-Column Tool Groups Matrix */
.tool-groups {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(14px, 1.35vw, 22px);
  align-items: stretch;
}

.tool-group {
  --group-accent: var(--accent);
  --group-tint: color-mix(in srgb, var(--accent) 11%, transparent);
  min-width: 0;
  border-radius: var(--r-panel);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 16px;
  background: linear-gradient(95deg, var(--group-tint), transparent 88%);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
}

.group-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--group-accent);
  background: color-mix(in srgb, var(--group-accent) 14%, transparent);
  flex: none;
}

.phonetics-art {
  transform: rotate(90deg);
}

.group-title {
  margin: 0;
  flex: 1;
  font-size: 1.06rem;
  font-weight: 650;
  color: var(--group-accent);
  letter-spacing: 0.01em;
}

.group-code {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--group-accent);
  opacity: 0.78;
}

.group-list {
  display: flex;
  flex-direction: column;
  padding: 4px 10px 8px;
  flex: 1;
}

.tool-row {
  position: relative;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 70px;
  padding: 12px 8px;
  border: 0;
  border-radius: calc(var(--r-ctrl, 6px) + 2px);
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--dur-fast, 165ms) var(--ease-out-expo),
    transform var(--dur-fast, 165ms) var(--ease-out-expo);
}

.tool-row + .tool-row::before {
  content: "";
  position: absolute;
  top: 0;
  left: 8px;
  right: 8px;
  height: 1px;
  background: color-mix(in srgb, var(--border) 56%, transparent);
  transition: opacity var(--dur-fast, 165ms) ease;
}

.tool-row:hover,
.tool-row:focus-visible {
  background: var(--themed-button-hover-bg);
}

.tool-row:hover::before,
.tool-row:focus-visible::before,
.tool-row:hover + .tool-row::before,
.tool-row:focus-visible + .tool-row::before {
  opacity: 0;
}

.tool-badge {
  width: 38px;
  height: 38px;
  border-radius: var(--r-ctrl);
  display: grid;
  place-items: center;
  background: var(--themed-button-bg);
  border: var(--border-w) solid var(--themed-button-border);
  box-shadow: var(--ctrl-shadow);
  transition:
    transform var(--dur-fast) var(--ease-out-expo),
    border-color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo);
}

.tool-art {
  width: 22px;
  height: 22px;
}

.tool-row:hover .tool-badge,
.tool-row:focus-visible .tool-badge {
  transform: scale(1.05);
  border-color: color-mix(in srgb, var(--group-accent) 46%, var(--border));
  background: color-mix(in srgb, var(--group-accent) 15%, var(--panel));
}

.tool-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.tool-name {
  font-size: 1.08rem;
  font-weight: 630;
  line-height: 1.3;
  color: var(--text);
  transition: color var(--dur-fast, 165ms) ease;
}

.tool-row:hover .tool-name,
.tool-row:focus-visible .tool-name {
  color: var(--group-accent);
}

.tool-desc {
  font-size: 0.92rem;
  line-height: 1.48;
  color: var(--muted);
  white-space: normal;
}

.tool-chevron {
  color: var(--muted);
  opacity: 0.72;
  transition:
    transform var(--dur-fast, 165ms) var(--ease-out-expo),
    color var(--dur-fast, 165ms) ease,
    opacity var(--dur-fast, 165ms) ease;
}

.tool-row:hover .tool-chevron,
.tool-row:focus-visible .tool-chevron {
  color: var(--group-accent);
  opacity: 1;
  transform: translateX(3px);
}

/* Recently Used Panel */
.recent-panel {
  border-radius: var(--r-panel);
  padding: 14px 18px 16px;
}

.recent-bar {
  margin-bottom: 11px;
  padding: 0;
}

.recent-empty {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.recent-empty-copy {
  font-size: 0.94rem;
  color: var(--muted);
}

.recent-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.recent-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 11px;
  border-radius: var(--r-ctrl);
  border: var(--border-w) solid var(--themed-button-border);
  background: var(--themed-button-bg);
  color: var(--text);
  font-size: 0.95rem;
  font-weight: 520;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo),
    color var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

.recent-chip:hover,
.recent-chip:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 54%, var(--border));
  background: color-mix(in srgb, var(--selected) 74%, var(--panel));
  color: var(--accent);
  transform: translateY(-1px);
}

.chip-art {
  width: 17px;
  height: 17px;
}

.chip-arrow {
  color: var(--muted);
  opacity: 0.72;
  transition: transform var(--dur-fast, 165ms) var(--ease-out-expo), color var(--dur-fast, 165ms) ease;
}

.recent-chip:hover .chip-arrow,
.recent-chip:focus-visible .chip-arrow {
  color: var(--accent);
  transform: translateX(2px);
}

/* Bottom Guide & Report Strip */
.home-banners {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.guide-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  border-radius: var(--r-panel);
  background: color-mix(in srgb, var(--accent) 10%, var(--panel-bg));
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out-expo),
    background-color var(--dur-fast) var(--ease-out-expo),
    transform var(--dur-fast) var(--ease-out-expo);
}

.guide-banner:hover,
.guide-banner:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--panel-border));
  background: color-mix(in srgb, var(--selected) 46%, color-mix(in srgb, var(--panel) 78%, transparent));
  transform: translateY(-1px);
}

.banner-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}


.banner-copy {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 10px;
}

.banner-copy strong {
  font-size: 0.98rem;
  font-weight: 630;
  color: var(--text);
  white-space: nowrap;
}

.banner-copy span {
  font-size: 0.92rem;
  color: var(--muted);
  line-height: 1.45;
}

.banner-action {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
  transition: transform var(--dur-fast, 165ms) var(--ease-out-expo);
}

.guide-banner:hover .banner-action,
.guide-banner:focus-visible .banner-action {
  transform: translateX(2px);
}

/* Responsive container queries */
@container desktop (max-width: 1120px) {
  .tool-groups {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home-banners {
    grid-template-columns: 1fr;
  }
}

@container desktop (max-width: 960px) {
  .home-synthesis-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .synth-card[data-tour="home-synth-speaker"] {
    grid-column: 1 / -1;
  }
}

@container desktop (max-width: 760px) {
  .home-synthesis-grid {
    grid-template-columns: 1fr;
  }
  .tool-groups {
    grid-template-columns: 1fr;
  }
  .hero-actions {
    align-items: flex-start;
  }
}
</style>
