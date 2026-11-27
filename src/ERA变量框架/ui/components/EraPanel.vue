<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
  日期：2026-11-26
  目的：重新设计面板：卡片式布局与图标导航（标签页注册表）；可拖动、调整大小、在浮动与侧边停靠之间切换、最小化，状态按设备保存；手机上全屏显示
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <section
    ref="panelEl"
    class="era-panel"
    :class="{
      'era-panel--float': mode === 'float',
      'era-panel--dock': mode === 'dock',
      'era-panel--dock-left': mode === 'dock' && panel.dockSide === 'left',
      'era-panel--mobile': mode === 'mobile',
      'era-panel--min': minimized,
      'era-panel--compact-nav': compactNav,
      'era-panel--moving': moving,
    }"
    :style="panelStyle"
    role="dialog"
    aria-label="ERA 面板"
  >
    <header class="era-panel__header" :class="{ 'era-draggable': mode === 'float' }" @pointerdown="onHeaderDown">
      <div class="era-brand">
        <span class="era-brand__mark">ERA</span>
        <span class="era-brand__name">Heron</span>
        <span class="era-brand__ver">v{{ ERA_VERSION }}</span>
      </div>
      <button v-if="statusChip" class="era-panel__status" :class="statusChip.cls" @click="statusChip.onClick?.()">
        <span v-if="statusChip.spin" class="era-spinner"></span>
        <EraIcon v-else :name="statusChip.icon" :size="14" />
        <span>{{ statusChip.text }}</span>
      </button>
      <span class="era-spacer"></span>
      <div class="era-panel__actions">
        <button
          v-if="mode !== 'mobile'"
          class="era-icon-btn"
          :title="mode === 'dock' ? '改为浮动窗口' : '停靠到屏幕侧边'"
          @click="toggleDock"
        >
          <EraIcon :name="mode === 'dock' ? 'float' : 'dock'" />
        </button>
        <button class="era-icon-btn" :title="minimized ? '展开' : '最小化'" @click="toggleMinimize">
          <EraIcon :name="minimized ? 'restore' : 'minimize'" />
        </button>
        <button class="era-icon-btn" title="关闭（Esc）" @click="store.closePanel()">
          <EraIcon name="close" />
        </button>
      </div>
    </header>

    <div v-if="!minimized" class="era-panel__main">
      <nav class="era-nav era-scroll" role="tablist" aria-label="ERA 面板导航">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="era-nav__item"
          :class="{ active: tab.id === activeTab?.id }"
          role="tab"
          :aria-selected="tab.id === activeTab?.id"
          :title="tab.label"
          @click="store.layout.tab = tab.id"
        >
          <span class="era-nav__icon">
            <EraIcon :name="tab.icon" :size="19" />
            <span v-if="tab.id === 'logs' && store.unseenProblems > 0" class="era-nav__dot"></span>
          </span>
          <span class="era-nav__label">{{ tab.label }}</span>
        </button>
      </nav>
      <div class="era-panel__body era-scroll" role="tabpanel">
        <component :is="activeTab.component" v-if="activeTab" :key="activeTab.id" />
      </div>
    </div>

    <div
      v-if="!minimized && mode === 'float'"
      class="era-panel__resize era-panel__resize--corner"
      title="拖动调整大小"
      @pointerdown="onResizeDown"
    ></div>
    <div
      v-if="!minimized && mode === 'dock'"
      class="era-panel__resize era-panel__resize--edge"
      title="拖动调整宽度"
      @pointerdown="onResizeDown"
    ></div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { ERA_VERSION } from '../../utils/constants';
import { hostWindow, MOBILE_BREAKPOINT, viewport } from '../host';
import type { IconName } from '../icons';
import { useUiStore } from '../store';
import { availableTabs } from '../tabs';
import EraIcon from '../template/EraIcon.vue';
import './tabs';

const store = useUiStore();
const panel = store.layout.panel;
const panelEl = ref<HTMLElement | null>(null);

const GAP = 8;
const MIN_W = 360;
const MIN_H = 320;

const mode = computed<'float' | 'dock' | 'mobile'>(() =>
  viewport.width <= MOBILE_BREAKPOINT ? 'mobile' : panel.mode === 'dock' ? 'dock' : 'float',
);
const minimized = computed(() => panel.minimized);

const tabs = availableTabs;
const activeTab = computed(() => tabs.value.find(tab => tab.id === store.layout.tab) ?? tabs.value[0]);

// ===== 几何 =====
const floatRect = computed(() => {
  const vw = viewport.width;
  const vh = viewport.height;
  const width = _.clamp(panel.width, Math.min(MIN_W, vw - GAP * 2), vw - GAP * 2);
  const height = _.clamp(panel.height, Math.min(MIN_H, vh - GAP * 2), vh - GAP * 2);
  const x = panel.x < 0 ? (vw - width) / 2 : _.clamp(panel.x, GAP, Math.max(GAP, vw - width - GAP));
  const y = panel.y < 0 ? Math.max(GAP, (vh - height) / 2) : _.clamp(panel.y, GAP, Math.max(GAP, vh - height - GAP));
  return { x, y, width, height };
});
const dockWidth = computed(() => _.clamp(panel.dockWidth, MIN_W, Math.max(MIN_W, viewport.width * 0.75)));

const panelStyle = computed(() => {
  if (mode.value === 'mobile') return {};
  if (mode.value === 'dock') {
    return {
      width: `${dockWidth.value}px`,
      [panel.dockSide]: '0px',
    };
  }
  const rect = floatRect.value;
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: minimized.value ? 'auto' : `${rect.height}px`,
  };
});

/** 面板较窄时导航放到顶部横排。 */
const compactNav = computed(() => {
  if (mode.value === 'mobile') return true;
  const width = mode.value === 'dock' ? dockWidth.value : floatRect.value.width;
  return width < 600;
});

// ===== 状态提示 =====
const statusChip = computed<{
  text: string;
  icon: IconName;
  cls: string;
  spin?: boolean;
  onClick?: () => void;
} | null>(() => {
  if (store.busy > 0) return { text: '处理中', icon: 'refresh', cls: 'is-busy', spin: true };
  if (store.extraRunning.size > 0) {
    return {
      text: `分步更新中 ${store.extraRunning.size}`,
      icon: 'layers',
      cls: 'is-busy',
      spin: true,
      onClick: () => (store.layout.tab = 'extra'),
    };
  }
  if (store.unseenProblems > 0) {
    return {
      text: `${store.unseenProblems} 个问题`,
      icon: 'alert',
      cls: 'is-error',
      onClick: () => (store.layout.tab = 'logs'),
    };
  }
  return null;
});

// ===== 操作 =====
function toggleDock() {
  panel.mode = panel.mode === 'dock' ? 'float' : 'dock';
  panel.minimized = false;
}
function toggleMinimize() {
  panel.minimized = !panel.minimized;
}

// ===== 拖动与调整大小 =====
const moving = ref(false);
let drag: { kind: 'move' | 'resize'; sx: number; sy: number; x: number; y: number; w: number; h: number } | null = null;

function beginDrag(event: PointerEvent, kind: 'move' | 'resize') {
  const rect = floatRect.value;
  drag = {
    kind,
    sx: event.clientX,
    sy: event.clientY,
    x: rect.x,
    y: rect.y,
    w: mode.value === 'dock' ? dockWidth.value : rect.width,
    h: rect.height,
  };
  moving.value = true;
  const doc = hostWindow().document;
  doc.addEventListener('pointermove', onDragMove);
  doc.addEventListener('pointerup', endDrag);
  doc.addEventListener('pointercancel', endDrag);
  event.preventDefault();
}

function onHeaderDown(event: PointerEvent) {
  if (mode.value !== 'float' || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if ((event.target as HTMLElement).closest('button')) return;
  beginDrag(event, 'move');
}

function onResizeDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  beginDrag(event, 'resize');
}

function onDragMove(event: PointerEvent) {
  if (!drag) return;
  const dx = event.clientX - drag.sx;
  const dy = event.clientY - drag.sy;
  if (drag.kind === 'move') {
    panel.x = Math.round(drag.x + dx);
    panel.y = Math.round(drag.y + dy);
  } else if (mode.value === 'dock') {
    const delta = panel.dockSide === 'right' ? -dx : dx;
    panel.dockWidth = Math.round(_.clamp(drag.w + delta, MIN_W, viewport.width * 0.75));
  } else {
    // 记住当前位置，避免居中的面板在调整大小时跟着移动
    panel.x = Math.round(drag.x);
    panel.y = Math.round(drag.y);
    panel.width = Math.round(_.clamp(drag.w + dx, MIN_W, viewport.width - drag.x - GAP));
    panel.height = Math.round(_.clamp(drag.h + dy, MIN_H, viewport.height - drag.y - GAP));
  }
}

function endDrag() {
  drag = null;
  moving.value = false;
  const doc = hostWindow().document;
  doc.removeEventListener('pointermove', onDragMove);
  doc.removeEventListener('pointerup', endDrag);
  doc.removeEventListener('pointercancel', endDrag);
}

onBeforeUnmount(endDrag);
</script>

<style>
.era-root .era-panel {
  position: fixed;
  z-index: 3;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--era-line-strong);
  background: var(--era-panel);
  backdrop-filter: blur(var(--era-blur));
  -webkit-backdrop-filter: blur(var(--era-blur));
  box-shadow: var(--era-shadow);
  color: var(--era-text);
  animation: era-panel-in 0.18s ease-out;
}
@keyframes era-panel-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.99);
  }
}
@media (prefers-reduced-motion: reduce) {
  .era-root .era-panel {
    animation: none;
  }
}
.era-root .era-panel--float {
  border-radius: 16px;
}
.era-root .era-panel--dock {
  top: 0;
  bottom: 0;
  border-top: 0;
  border-bottom: 0;
}
.era-root .era-panel--dock.era-panel--min {
  bottom: auto;
  border-bottom: 1px solid var(--era-line-strong);
}
.era-root .era-panel--mobile {
  inset: 0;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  border: 0;
  border-radius: 0;
}
.era-root .era-panel--mobile.era-panel--min {
  top: auto;
  border-top: 1px solid var(--era-line-strong);
}
.era-root .era-panel--moving {
  user-select: none;
  -webkit-user-select: none;
}

/* ===== 顶栏 ===== */
.era-root .era-panel__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  height: 50px;
  padding: 0 8px 0 16px;
  border-bottom: 1px solid var(--era-line);
}
.era-root .era-panel--min .era-panel__header {
  border-bottom: 0;
}
.era-root .era-panel__header.era-draggable {
  cursor: grab;
  touch-action: none;
}
.era-root .era-panel--moving .era-panel__header.era-draggable {
  cursor: grabbing;
}
.era-root .era-brand {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
}
.era-root .era-brand__mark {
  color: var(--era-accent);
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.era-root .era-brand__name {
  font-size: 15px;
  font-weight: 700;
}
.era-root .era-brand__ver {
  color: var(--era-faint);
  font-size: 12px;
}
.era-root .era-panel__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.era-root .era-panel__status.is-busy {
  background: var(--era-accent-soft);
  color: var(--era-text);
}
.era-root .era-panel__status.is-error {
  background: var(--era-danger-soft);
  color: var(--era-danger);
}
.era-root .era-panel__actions {
  display: flex;
  gap: 2px;
}

/* ===== 主体：左侧导航 + 内容 ===== */
.era-root .era-panel__main {
  display: flex;
  flex: 1;
  min-height: 0;
}
.era-root .era-nav {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 2px;
  width: 76px;
  padding: 10px 6px;
  border-right: 1px solid var(--era-line);
}
.era-root .era-nav__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 100%;
  padding: 8px 2px 6px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--era-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.era-root .era-nav__item:hover {
  background: var(--era-hover);
  color: var(--era-text);
}
.era-root .era-nav__item.active {
  background: var(--era-accent-soft);
  color: var(--era-accent);
}
.era-root .era-nav__icon {
  position: relative;
  display: grid;
  place-items: center;
}
.era-root .era-nav__dot {
  position: absolute;
  top: -2px;
  right: -4px;
  width: 8px;
  height: 8px;
  border: 2px solid var(--era-panel);
  border-radius: 50%;
  background: var(--era-danger);
  box-sizing: content-box;
}
.era-root .era-nav__label {
  white-space: nowrap;
}
.era-root .era-panel__body {
  flex: 1;
  min-width: 0;
  padding: 16px;
}

/* 窄面板：导航横排到顶部 */
.era-root .era-panel--compact-nav .era-panel__main {
  flex-direction: column;
}
.era-root .era-panel--compact-nav .era-nav {
  flex-direction: row;
  width: auto;
  padding: 6px 8px;
  border-right: 0;
  border-bottom: 1px solid var(--era-line);
  overflow-x: auto;
  overflow-y: hidden;
}
.era-root .era-panel--compact-nav .era-nav__item {
  flex: 1 0 auto;
  width: auto;
  min-width: 46px;
  padding: 6px 4px 4px;
}
.era-root .era-panel--compact-nav .era-panel__body {
  padding: 12px;
}

/* ===== 调整大小 ===== */
.era-root .era-panel__resize {
  position: absolute;
  z-index: 2;
  touch-action: none;
}
.era-root .era-panel__resize--corner {
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  background: linear-gradient(
    135deg,
    transparent 50%,
    var(--era-line-strong) 50%,
    var(--era-line-strong) 58%,
    transparent 58%,
    transparent 70%,
    var(--era-line-strong) 70%,
    var(--era-line-strong) 78%,
    transparent 78%
  );
  border-bottom-right-radius: 16px;
}
.era-root .era-panel__resize--edge {
  top: 0;
  bottom: 0;
  width: 8px;
  cursor: ew-resize;
}
.era-root .era-panel--dock .era-panel__resize--edge {
  left: -2px;
}
.era-root .era-panel--dock-left .era-panel__resize--edge {
  left: auto;
  right: -2px;
}
.era-root .era-panel__resize--edge:hover {
  background: var(--era-accent-soft);
}
</style>
