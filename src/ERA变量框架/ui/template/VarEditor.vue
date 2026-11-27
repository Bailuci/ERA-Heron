<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：变量节点的内联编辑器（修改、新增）
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <form v-if="editor" class="ve" :style="{ marginLeft: `${level * 16 + 4}px` }" @submit.prevent="ctx.submit()">
    <div class="ve-head">
      <span class="era-chip era-chip--accent">{{ editor.mode === 'edit' ? '修改' : '新增' }}</span>
      <span class="ve-path era-mono">{{ pathLabel }}</span>
    </div>
    <div class="ve-fields">
      <input
        v-if="editor.mode === 'add' && !editor.parentIsArray"
        ref="keyInput"
        v-model.trim="editor.key"
        class="era-input ve-key"
        placeholder="键名"
        aria-label="键名"
      />
      <select v-model="editor.kind" class="era-select ve-kind" aria-label="类型">
        <option value="string">文本</option>
        <option value="number">数字</option>
        <option value="boolean">布尔</option>
        <option value="null">null</option>
        <option value="json">JSON（对象/数组）</option>
      </select>
      <select v-if="editor.kind === 'boolean'" v-model="editor.text" class="era-select ve-value" aria-label="值">
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
      <textarea
        v-else-if="editor.kind === 'json' || (editor.kind === 'string' && multiline)"
        ref="valueInput"
        v-model="editor.text"
        class="era-textarea ve-value"
        rows="4"
        aria-label="值"
      ></textarea>
      <input
        v-else-if="editor.kind !== 'null'"
        ref="valueInput"
        v-model="editor.text"
        class="era-input ve-value"
        :inputmode="editor.kind === 'number' ? 'decimal' : 'text'"
        aria-label="值"
      />
    </div>
    <p v-for="hint in editor.hints" :key="hint" class="era-hint ve-hint">{{ hint }}</p>
    <p v-if="editor.error" class="ve-error">{{ editor.error }}</p>
    <div class="ve-buttons">
      <span class="era-hint">修改会先暂存，确认后统一提交</span>
      <span class="era-spacer"></span>
      <button type="button" class="era-btn era-btn--sm" @click="ctx.cancel()">取消</button>
      <button type="submit" class="era-btn era-btn--sm era-btn--primary">暂存</button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref } from 'vue';
import { displayPath } from '../workbench';
import { VAR_TREE_KEY } from './var_tree';

defineProps<{ level: number }>();

const ctx = inject(VAR_TREE_KEY)!;
const editor = ctx.editor;
const keyInput = ref<HTMLInputElement | null>(null);
const valueInput = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
/** 长文本用多行框；只在打开时判断一次，输入过程中不切换控件（否则会丢失焦点）。 */
const initialText = editor.value?.text ?? '';
const multiline = ref(initialText.length > 40 || /\n/.test(initialText));

const pathLabel = computed(() => {
  const state = editor.value;
  if (!state) return '';
  if (state.mode === 'edit') return displayPath(state.path);
  const base = state.path === '' ? '（根）' : displayPath(state.path);
  return state.parentIsArray ? `${base} 末尾` : `${base} 下`;
});

onMounted(() =>
  nextTick(() => {
    (keyInput.value ?? valueInput.value)?.focus();
  }),
);
</script>

<style>
.era-root .ve {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 2px 4px 8px;
  padding: 10px;
  border: 1px solid var(--era-accent-line);
  border-radius: 10px;
  background: var(--era-surface);
}
.era-root .ve-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.era-root .ve-path {
  overflow: hidden;
  color: var(--era-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.era-root .ve-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.era-root .ve-key {
  flex: 1 1 140px;
}
.era-root .ve-kind {
  flex: 0 0 140px;
}
.era-root .ve-value {
  flex: 1 1 100%;
}
.era-root .ve-hint {
  color: var(--era-warn);
}
.era-root .ve-error {
  color: var(--era-danger);
  font-size: 12px;
}
.era-root .ve-buttons {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
