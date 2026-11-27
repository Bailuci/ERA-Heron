/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：悬浮球与面板可拖动、隐藏、停靠，状态按设备保存
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 面板 - 宿主页面与布局状态
 * @description
 * 酒馆助手的脚本运行在隐藏的 iframe 中，`$` 操作的是酒馆页面，但 `window` / `document` 是 iframe 自己的。
 * 面板挂在酒馆页面上，所以尺寸、键盘、拖动都要以酒馆页面的窗口为准。
 */
'use strict';

import { reactive, readonly } from 'vue';

/** 酒馆页面的窗口；拿不到时退回当前窗口。 */
export function hostWindow(): Window {
  try {
    const parent = window.parent;
    if (parent && parent !== window && parent.document) return parent;
  } catch {
    // 跨域时无法访问
  }
  return window;
}

const viewportState = reactive({ width: 1280, height: 800 });
/** 酒馆页面的可视区域尺寸（响应式）。 */
export const viewport = readonly(viewportState);
/** 与 CSS 断点一致：宽度不超过 640px 视为手机布局。 */
export const MOBILE_BREAKPOINT = 640;

function measure() {
  const win = hostWindow();
  viewportState.width = win.innerWidth || win.document.documentElement.clientWidth || 1280;
  viewportState.height = win.innerHeight || win.document.documentElement.clientHeight || 800;
}

let resizeHandler: (() => void) | null = null;
export function watchViewport(): () => void {
  measure();
  const win = hostWindow();
  resizeHandler = _.throttle(measure, 100);
  win.addEventListener('resize', resizeHandler);
  win.addEventListener('orientationchange', resizeHandler);
  return () => {
    if (!resizeHandler) return;
    win.removeEventListener('resize', resizeHandler);
    win.removeEventListener('orientationchange', resizeHandler);
    resizeHandler = null;
  };
}

// ===== 布局状态（localStorage，按设备保存） =====

export type ThemeChoice = 'tavern' | 'light' | 'dark';
export type PanelMode = 'float' | 'dock';

export interface UiLayout {
  ball: {
    side: 'left' | 'right';
    /** 球心的纵向位置，占可视高度的比例，窗口尺寸变化时保持相对位置。 */
    top: number;
    hidden: boolean;
  };
  panel: {
    mode: PanelMode;
    x: number;
    y: number;
    width: number;
    height: number;
    dockSide: 'left' | 'right';
    dockWidth: number;
    minimized: boolean;
  };
  tab: string;
  /** `null` 表示未选择：按脚本设置 `开启黑夜模式` 决定（开启为暗色，否则跟随酒馆）。 */
  theme: ThemeChoice | null;
}

const STORAGE_KEY = 'era-heron:ui-layout';

export function defaultLayout(): UiLayout {
  return {
    ball: { side: 'right', top: 0.72, hidden: false },
    panel: {
      mode: 'float',
      x: -1,
      y: -1,
      width: 760,
      height: 620,
      dockSide: 'right',
      dockWidth: 440,
      minimized: false,
    },
    tab: 'variables',
    theme: null,
  };
}

function storage(): Storage | null {
  try {
    return hostWindow().localStorage ?? window.localStorage;
  } catch {
    return null;
  }
}

export function loadLayout(): UiLayout {
  const fallback = defaultLayout();
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    const num = (value: any, def: number) => (typeof value === 'number' && Number.isFinite(value) ? value : def);
    return {
      ball: {
        side: saved?.ball?.side === 'left' ? 'left' : 'right',
        top: _.clamp(num(saved?.ball?.top, fallback.ball.top), 0, 1),
        hidden: saved?.ball?.hidden === true,
      },
      panel: {
        mode: saved?.panel?.mode === 'dock' ? 'dock' : 'float',
        x: num(saved?.panel?.x, -1),
        y: num(saved?.panel?.y, -1),
        width: num(saved?.panel?.width, fallback.panel.width),
        height: num(saved?.panel?.height, fallback.panel.height),
        dockSide: saved?.panel?.dockSide === 'left' ? 'left' : 'right',
        dockWidth: num(saved?.panel?.dockWidth, fallback.panel.dockWidth),
        minimized: saved?.panel?.minimized === true,
      },
      tab: typeof saved?.tab === 'string' ? saved.tab : fallback.tab,
      theme: ['tavern', 'light', 'dark'].includes(saved?.theme) ? saved.theme : null,
    };
  } catch {
    return fallback;
  }
}

export function saveLayout(layout: UiLayout): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // 存储不可用（隐私模式等）时只在本次会话中生效
  }
}

export function clearLayout(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // 忽略
  }
}
