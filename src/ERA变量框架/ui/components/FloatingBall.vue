<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
  日期：2026-11-26
  目的：重新设计悬浮球：可拖动（鼠标与触摸）、松手吸附屏幕边缘、位置按设备保存、可隐藏；显示进行中、分步更新与错误状态
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <div
    ref="ballEl"
    class="era-ball"
    :class="{
      'era-ball--dragging': dragging,
      'era-ball--active': store.open,
      'era-ball--left': store.layout.ball.side === 'left',
    }"
    :style="{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }"
    role="button"
    tabindex="0"
    :aria-label="title"
    :title="title"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu.prevent="openMenu"
    @keydown.enter.prevent="store.togglePanel()"
    @keydown.space.prevent="store.togglePanel()"
  >
    <span v-if="working" class="era-ball__ring" aria-hidden="true"></span>
    <span class="era-ball__face">
      <span class="era-ball__mark">ERA</span>
    </span>
    <span v-if="extraCount > 0" class="era-ball__badge era-ball__badge--extra" aria-hidden="true">{{
      extraCount
    }}</span>
    <span v-if="store.unseenProblems > 0" class="era-ball__badge era-ball__badge--error" aria-hidden="true">{{
      store.unseenProblems > 9 ? '9+' : store.unseenProblems
    }}</span>
  </div>

  <div v-if="menuOpen" ref="menuEl" class="era-ball-menu" :style="menuStyle" role="menu" @pointerdown.stop>
    <button class="era-ball-menu__item" role="menuitem" @click="act(() => store.togglePanel())">
      <EraIcon :name="store.open ? 'close' : 'float'" :size="16" />{{ store.open ? '关闭面板' : '打开面板' }}
    </button>
    <button
      v-if="store.unseenProblems > 0"
      class="era-ball-menu__item"
      role="menuitem"
      @click="act(() => store.openPanel('logs'))"
    >
      <EraIcon name="alert" :size="16" />查看问题（{{ store.unseenProblems }}）
    </button>
    <button class="era-ball-menu__item" role="menuitem" @click="act(hide)">
      <EraIcon name="eyeOff" :size="16" />隐藏悬浮球
    </button>
    <button class="era-ball-menu__item" role="menuitem" @click="act(resetPosition)">
      <EraIcon name="refresh" :size="16" />重置位置
    </button>
  </div>
</template>

<script setup lang="ts">
import toastr from 'toastr';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { hostWindow, MOBILE_BREAKPOINT, viewport } from '../host';
import { useUiStore } from '../store';
import EraIcon from '../template/EraIcon.vue';

const store = useUiStore();
const ballEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

const MARGIN = 10;
const size = computed(() => (viewport.width <= MOBILE_BREAKPOINT ? 44 : 46));

// ===== 位置 =====
const dragging = ref(false);
const dragPos = reactive({ x: 0, y: 0 });

/** 吸附后的位置：贴左/右边，纵向按保存的比例，始终在可视范围内。 */
const restingPos = computed(() => {
  const s = size.value;
  const x = store.layout.ball.side === 'left' ? MARGIN : viewport.width - s - MARGIN;
  const y = _.clamp(
    store.layout.ball.top * viewport.height - s / 2,
    MARGIN,
    Math.max(MARGIN, viewport.height - s - MARGIN),
  );
  return { x, y };
});
const pos = computed(() => (dragging.value ? dragPos : restingPos.value));

// ===== 状态 =====
const extraCount = computed(() => store.extraRunning.size);
const working = computed(() => store.busy > 0 || extraCount.value > 0);
const title = computed(() => {
  const lines = ['ERA-Heron：点击打开面板，拖动可移动，右键或长按查看更多'];
  if (store.busy > 0) lines.push('· 面板操作进行中');
  if (extraCount.value > 0) lines.push(`· 分步更新进行中（${extraCount.value}）`);
  if (store.unseenProblems > 0) lines.push(`· 有 ${store.unseenProblems} 个新问题`);
  return lines.join('\n');
});

// ===== 拖动、点击、长按 =====
let start: { x: number; y: number; bx: number; by: number; id: number } | null = null;
let moved = false;
let longPressed = false;
let pressTimer: ReturnType<typeof setTimeout> | undefined;

function onPointerDown(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  closeMenu();
  start = { x: event.clientX, y: event.clientY, bx: pos.value.x, by: pos.value.y, id: event.pointerId };
  moved = false;
  longPressed = false;
  try {
    ballEl.value?.setPointerCapture(event.pointerId);
  } catch {
    // 忽略
  }
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (start && !moved) {
      longPressed = true;
      openMenu();
    }
  }, 550);
}

function onPointerMove(event: PointerEvent) {
  if (!start || event.pointerId !== start.id) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (!moved && Math.hypot(dx, dy) < 6) return;
  if (!moved) {
    moved = true;
    clearTimeout(pressTimer);
    dragging.value = true;
  }
  const s = size.value;
  dragPos.x = _.clamp(start.bx + dx, 0, viewport.width - s);
  dragPos.y = _.clamp(start.by + dy, 0, viewport.height - s);
}

function onPointerUp(event: PointerEvent) {
  if (!start || event.pointerId !== start.id) return;
  clearTimeout(pressTimer);
  if (moved) {
    const s = size.value;
    store.layout.ball.side = dragPos.x + s / 2 < viewport.width / 2 ? 'left' : 'right';
    store.layout.ball.top = _.clamp((dragPos.y + s / 2) / Math.max(1, viewport.height), 0, 1);
    dragging.value = false;
  } else if (!longPressed) {
    store.togglePanel();
  }
  start = null;
}

function onPointerCancel() {
  clearTimeout(pressTimer);
  if (dragging.value) {
    dragging.value = false;
  }
  start = null;
}

// ===== 菜单 =====
const menuOpen = ref(false);
const menuStyle = computed(() => {
  const s = size.value;
  const width = 172;
  const left =
    store.layout.ball.side === 'left'
      ? Math.min(pos.value.x + s + 8, viewport.width - width - 8)
      : Math.max(8, pos.value.x - width - 8);
  const top = _.clamp(pos.value.y, 8, Math.max(8, viewport.height - 180));
  return { left: `${left}px`, top: `${top}px`, width: `${width}px` };
});

function onOutside(event: Event) {
  const target = event.target as Node | null;
  if (target && (menuEl.value?.contains(target) || ballEl.value?.contains(target))) return;
  closeMenu();
}
function openMenu() {
  if (menuOpen.value) return;
  longPressed = true;
  menuOpen.value = true;
  nextTick(() => hostWindow().document.addEventListener('pointerdown', onOutside, true));
}
function closeMenu() {
  if (!menuOpen.value) return;
  menuOpen.value = false;
  hostWindow().document.removeEventListener('pointerdown', onOutside, true);
}
function act(fn: () => void) {
  closeMenu();
  fn();
}

function hide() {
  store.hideBall();
  toastr.info('在酒馆的扩展菜单（魔棒图标）中点“ERA 面板”，或在输入框发送 /era ball 可以重新显示。', '悬浮球已隐藏');
}
function resetPosition() {
  store.layout.ball.side = 'right';
  store.layout.ball.top = 0.72;
}

watch(
  () => store.open,
  () => closeMenu(),
);

onBeforeUnmount(() => {
  clearTimeout(pressTimer);
  closeMenu();
});
</script>

<style>
.era-root .era-ball {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 2;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  cursor: pointer;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  opacity: 0.72;
  transition:
    transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 0.2s ease;
  will-change: transform;
}
.era-root--mobile .era-ball {
  width: 44px;
  height: 44px;
}
.era-root .era-ball:hover,
.era-root .era-ball:focus-visible,
.era-root .era-ball--active,
.era-root .era-ball--dragging {
  opacity: 1;
}
@media (hover: none) {
  .era-root .era-ball {
    opacity: 0.9;
  }
}
.era-root .era-ball--dragging {
  transition: none;
  cursor: grabbing;
}
.era-root .era-ball__face {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--era-line-strong);
  border-radius: 50%;
  background: var(--era-panel);
  backdrop-filter: blur(var(--era-blur));
  -webkit-backdrop-filter: blur(var(--era-blur));
  box-shadow:
    0 6px 18px var(--era-shadow-color),
    inset 0 1px 0 color-mix(in srgb, #fff 12%, transparent);
  transition:
    box-shadow 0.2s ease,
    border-color 0.2s ease,
    transform 0.2s ease;
}
.era-root .era-ball:hover .era-ball__face,
.era-root .era-ball--active .era-ball__face {
  border-color: var(--era-accent-line);
  box-shadow:
    0 8px 24px var(--era-shadow-color),
    0 0 0 4px var(--era-accent-soft);
}
.era-root .era-ball--dragging .era-ball__face {
  transform: scale(1.08);
}
.era-root .era-ball__mark {
  color: var(--era-accent);
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.04em;
  line-height: 1;
  pointer-events: none;
}
.era-root .era-ball__ring {
  position: absolute;
  inset: -3px;
  border: 2px solid transparent;
  border-top-color: var(--era-accent);
  border-right-color: var(--era-accent);
  border-radius: 50%;
  animation: era-spin 1s linear infinite;
  pointer-events: none;
}
.era-root .era-ball__badge {
  position: absolute;
  top: -3px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border: 2px solid var(--era-panel);
  border-radius: 999px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 13px;
  text-align: center;
  pointer-events: none;
}
.era-root .era-ball__badge--error {
  right: -3px;
  background: var(--era-danger);
}
.era-root .era-ball__badge--extra {
  left: -3px;
  background: var(--era-info);
}
.era-root .era-ball--left .era-ball__badge--error {
  right: auto;
  left: -3px;
}
.era-root .era-ball--left .era-ball__badge--extra {
  left: auto;
  right: -3px;
}

.era-root .era-ball-menu {
  position: fixed;
  z-index: 4;
  display: flex;
  flex-direction: column;
  padding: 5px;
  border: 1px solid var(--era-line-strong);
  border-radius: 12px;
  background: linear-gradient(var(--era-panel), var(--era-panel)), var(--era-panel);
  backdrop-filter: blur(var(--era-blur));
  -webkit-backdrop-filter: blur(var(--era-blur));
  box-shadow: var(--era-shadow);
}
.era-root .era-ball-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--era-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.era-root .era-ball-menu__item:hover {
  background: var(--era-hover);
}
</style>
