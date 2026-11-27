<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
  日期：2026-11-26
  目的：重新设计面板：主题改为跟随酒馆配色（也可选亮色、暗色），变量只作用于面板内部，不再写到页面的 :root
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <span class="era-theme-anchor" hidden></span>
</template>

<script setup lang="ts">
// 只承载全局样式：主题变量与通用控件。主题由根元素的 data-theme 决定（见 App.vue）。
</script>

<style>
/* ===== 主题变量：只作用于 .era-root，不影响酒馆页面 ===== */
.era-root {
  --era-ok: #2fa66a;
  --era-warn: #d6931c;
  --era-danger: #e5484d;
  --era-info: #3b82f6;
  --era-radius: 14px;
  --era-radius-sm: 9px;
  --era-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}
/* 跟随酒馆：使用酒馆“用户设置 → 界面主题”的颜色 */
.era-root[data-theme='tavern'] {
  --era-text: var(--SmartThemeBodyColor, #dcdcd2);
  --era-panel: var(--SmartThemeBlurTintColor, rgba(26, 26, 30, 0.9));
  --era-accent: var(--SmartThemeQuoteColor, #e18a24);
  --era-shadow-color: var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.45));
  --era-blur: calc(var(--blurStrength, 10) * 1px);
}
.era-root[data-theme='light'] {
  --era-text: #1e2430;
  --era-panel: rgba(250, 251, 253, 0.96);
  --era-accent: #2f7fd1;
  --era-shadow-color: rgba(15, 23, 42, 0.18);
  --era-blur: 14px;
}
.era-root[data-theme='dark'] {
  --era-text: #e4e7ee;
  --era-panel: rgba(23, 25, 31, 0.95);
  --era-accent: #5ea6f0;
  --era-shadow-color: rgba(0, 0, 0, 0.55);
  --era-blur: 14px;
}
/* 派生颜色：都由正文色、强调色混合得到，因此任何酒馆主题下都协调 */
.era-root {
  --era-muted: color-mix(in srgb, var(--era-text) 64%, transparent);
  --era-faint: color-mix(in srgb, var(--era-text) 42%, transparent);
  --era-line: color-mix(in srgb, var(--era-text) 14%, transparent);
  --era-line-strong: color-mix(in srgb, var(--era-text) 24%, transparent);
  --era-surface: color-mix(in srgb, var(--era-text) 5%, transparent);
  --era-surface-2: color-mix(in srgb, var(--era-text) 9%, transparent);
  --era-hover: color-mix(in srgb, var(--era-text) 12%, transparent);
  --era-accent-soft: color-mix(in srgb, var(--era-accent) 18%, transparent);
  --era-accent-line: color-mix(in srgb, var(--era-accent) 45%, transparent);
  --era-danger-soft: color-mix(in srgb, var(--era-danger) 15%, transparent);
  --era-ok-soft: color-mix(in srgb, var(--era-ok) 15%, transparent);
  --era-warn-soft: color-mix(in srgb, var(--era-warn) 16%, transparent);
  --era-shadow: 0 18px 48px var(--era-shadow-color), 0 2px 8px var(--era-shadow-color);
  color: var(--era-text);
  font-size: 14px;
  line-height: 1.5;
  text-align: left;
}

/* ===== 基础重置：抵消酒馆对表单元素的全局样式 ===== */
.era-root *,
.era-root *::before,
.era-root *::after {
  box-sizing: border-box;
}
.era-root :where(h1, h2, h3, h4, h5, p, ul, ol, pre, fieldset) {
  margin: 0;
  padding: 0;
}
.era-root :where(button, input, select, textarea) {
  font: inherit;
  color: inherit;
  letter-spacing: normal;
  margin: 0;
  min-height: 0;
  max-width: 100%;
}
.era-root a {
  color: var(--era-accent);
  text-decoration: none;
}
.era-root a:hover {
  text-decoration: underline;
}
.era-root :focus-visible {
  outline: 2px solid var(--era-accent);
  outline-offset: 1px;
}

/* ===== 通用控件 ===== */
.era-root .era-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--era-line-strong);
  border-radius: var(--era-radius-sm);
  background: var(--era-surface);
  color: var(--era-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: none;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    opacity 0.15s ease;
}
.era-root .era-btn:hover:not(:disabled) {
  background: var(--era-hover);
}
.era-root .era-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.era-root .era-btn--primary {
  background: var(--era-accent);
  border-color: var(--era-accent);
  color: #fff;
}
.era-root .era-btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--era-accent) 85%, #000);
}
.era-root .era-btn--danger {
  border-color: color-mix(in srgb, var(--era-danger) 55%, transparent);
  color: var(--era-danger);
  background: var(--era-danger-soft);
}
.era-root .era-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--era-danger) 24%, transparent);
}
.era-root .era-btn--armed {
  background: var(--era-danger);
  border-color: var(--era-danger);
  color: #fff;
}
.era-root .era-btn--armed:hover:not(:disabled) {
  background: color-mix(in srgb, var(--era-danger) 85%, #000);
}
.era-root .era-btn--ghost {
  background: transparent;
  border-color: transparent;
}
.era-root .era-btn--sm {
  height: 26px;
  padding: 0 9px;
  font-size: 12px;
}
.era-root .era-icon-btn {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--era-muted);
  cursor: pointer;
}
.era-root .era-icon-btn:hover:not(:disabled) {
  background: var(--era-hover);
  color: var(--era-text);
}
.era-root .era-icon-btn--sm {
  width: 24px;
  height: 24px;
  border-radius: 6px;
}

.era-root .era-input,
.era-root .era-select,
.era-root .era-textarea {
  display: block;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--era-line-strong);
  border-radius: var(--era-radius-sm);
  background: var(--era-surface);
  color: var(--era-text);
  font-size: 13px;
  box-shadow: none;
  outline: none;
}
.era-root .era-select {
  padding-right: 4px;
}
.era-root .era-select option {
  background: var(--era-panel);
  color: var(--era-text);
}
.era-root .era-textarea {
  height: auto;
  min-height: 72px;
  padding: 8px 10px;
  font-family: var(--era-mono);
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}
.era-root .era-input:focus,
.era-root .era-select:focus,
.era-root .era-textarea:focus {
  border-color: var(--era-accent);
  box-shadow: 0 0 0 3px var(--era-accent-soft);
}
.era-root .era-input--invalid,
.era-root .era-input--invalid:focus {
  border-color: var(--era-danger);
  box-shadow: 0 0 0 3px var(--era-danger-soft);
}
.era-root .era-input::placeholder,
.era-root .era-textarea::placeholder {
  color: var(--era-faint);
}

.era-root .era-card {
  border: 1px solid var(--era-line);
  border-radius: var(--era-radius);
  background: var(--era-surface);
  padding: 14px;
}
.era-root .era-card + .era-card {
  margin-top: 12px;
}
.era-root .era-card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.era-root .era-card__title {
  font-size: 14px;
  font-weight: 700;
  color: var(--era-text);
}
.era-root .era-card__sub {
  font-size: 12px;
  color: var(--era-muted);
}
.era-root .era-spacer {
  flex: 1;
}
.era-root .era-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.era-root .era-hint {
  font-size: 12px;
  color: var(--era-muted);
  line-height: 1.55;
}
.era-root .era-hint + .era-hint {
  margin-top: 4px;
}
.era-root .era-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--era-surface-2);
  color: var(--era-muted);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.era-root .era-chip--accent {
  background: var(--era-accent-soft);
  color: var(--era-accent);
}
.era-root .era-chip--ok {
  background: var(--era-ok-soft);
  color: var(--era-ok);
}
.era-root .era-chip--danger {
  background: var(--era-danger-soft);
  color: var(--era-danger);
}
.era-root .era-chip--warn {
  background: var(--era-warn-soft);
  color: var(--era-warn);
}
.era-root .era-code {
  display: block;
  max-height: 260px;
  overflow: auto;
  padding: 10px;
  border: 1px solid var(--era-line);
  border-radius: var(--era-radius-sm);
  background: color-mix(in srgb, var(--era-text) 4%, transparent);
  font-family: var(--era-mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.era-root .era-mono {
  font-family: var(--era-mono);
}
.era-root .era-empty {
  display: grid;
  place-items: center;
  gap: 6px;
  padding: 28px 12px;
  border: 1px dashed var(--era-line-strong);
  border-radius: var(--era-radius);
  color: var(--era-muted);
  font-size: 13px;
  text-align: center;
}

/* 操作结果提示行 */
.era-root .era-status {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 8px;
  padding: 7px 10px;
  border-radius: var(--era-radius-sm);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.era-root .era-status--busy {
  background: var(--era-accent-soft);
  color: var(--era-text);
}
.era-root .era-status--ok {
  background: var(--era-ok-soft);
  color: var(--era-text);
}
.era-root .era-status--error {
  background: var(--era-danger-soft);
  color: var(--era-text);
}
.era-root .era-status--warn {
  background: var(--era-warn-soft);
  color: var(--era-text);
}

/* 开关 */
.era-root .era-switch {
  position: relative;
  display: inline-block;
  flex: none;
  width: 38px;
  height: 22px;
  cursor: pointer;
}
.era-root .era-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.era-root .era-switch span {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--era-line-strong);
  transition: background 0.15s ease;
  pointer-events: none;
}
.era-root .era-switch span::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.15s ease;
}
.era-root .era-switch input:checked + span {
  background: var(--era-accent);
}
.era-root .era-switch input:checked + span::after {
  transform: translateX(16px);
}
.era-root .era-switch input:focus-visible + span {
  outline: 2px solid var(--era-accent);
  outline-offset: 2px;
}

/* 分段选择 */
.era-root .era-segmented {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--era-line);
  border-radius: 10px;
  background: var(--era-surface);
}
.era-root .era-segmented button {
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--era-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.era-root .era-segmented button.active {
  background: var(--era-accent-soft);
  color: var(--era-accent);
}

/* 加载动画 */
.era-root .era-spinner {
  display: inline-block;
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid var(--era-accent-soft);
  border-top-color: var(--era-accent);
  border-radius: 50%;
  animation: era-spin 0.8s linear infinite;
}
@keyframes era-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .era-root .era-spinner {
    animation-duration: 2.4s;
  }
}

/* 滚动条 */
.era-root .era-scroll {
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--era-line-strong) transparent;
}
.era-root .era-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.era-root .era-scroll::-webkit-scrollbar-thumb {
  border-radius: 8px;
  background: var(--era-line-strong);
}
</style>
