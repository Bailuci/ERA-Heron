<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
  日期：2026-11-26
  目的：重新设计面板：悬浮球与面板分离，面板关闭时不渲染；主题跟随酒馆；Esc 关闭面板
          2026-11-28 面板用掉的 Esc 不再传给页面上其他监听器
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="era-root" :data-theme="store.theme" :class="{ 'era-root--mobile': isMobile }">
    <ThemeManager />
    <FloatingBall v-if="store.ballVisible" />
    <EraPanel v-if="store.open" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import EraPanel from './components/EraPanel.vue';
import FloatingBall from './components/FloatingBall.vue';
import ThemeManager from './components/ThemeManager.vue';
import { hostWindow, MOBILE_BREAKPOINT, viewport, watchViewport } from './host';
import { useUiStore } from './store';

const store = useUiStore();
const isMobile = computed(() => viewport.width <= MOBILE_BREAKPOINT);

let stopViewport: (() => void) | null = null;

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !store.open) return;
  const target = event.target as HTMLElement | null;
  // 正在输入时 Esc 只让输入框失焦，不关闭面板
  if (target?.closest?.('.era-root') && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
    target.blur();
    consume(event);
    return;
  }
  // 酒馆自己的弹窗打开时不抢 Esc
  if (hostWindow().document.querySelector('dialog[open]')) return;
  store.closePanel();
  consume(event);
}

/**
 * 这次 Esc 已经被面板用掉：不再让页面上别的监听器收到。
 * 否则带全屏界面的角色卡会在同一次按键里既关掉面板又退出全屏。
 */
function consume(event: KeyboardEvent) {
  event.stopImmediatePropagation();
  event.preventDefault();
}

onMounted(() => {
  stopViewport = watchViewport();
  // 在捕获阶段监听，先于页面上其他脚本的 Esc 处理
  hostWindow().document.addEventListener('keydown', onKeydown, true);
});

onBeforeUnmount(() => {
  stopViewport?.();
  hostWindow().document.removeEventListener('keydown', onKeydown, true);
});
</script>

<style>
.era-root {
  position: fixed;
  inset: 0;
  z-index: 30000; /* 高于酒馆的抽屉与菜单，低于 toastr 提示，操作反馈不会被面板挡住 */
  pointer-events: none;
  isolation: isolate;
}
.era-root > * {
  pointer-events: auto;
}
.era-root > .era-theme-anchor {
  display: none;
}
</style>
