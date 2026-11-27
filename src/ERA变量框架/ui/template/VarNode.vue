<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：变量树节点（只在展开时渲染子节点，支持搜索高亮与节点编辑）
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="vn">
    <div
      class="vn-row"
      :class="{ 'vn-row--match': isMatch, 'vn-row--changed': isChanged, 'vn-row--editing': isEditing }"
      :style="{ paddingLeft: `${level * 16 + 4}px` }"
    >
      <button
        v-if="isContainer"
        class="vn-caret"
        :class="{ open: isOpen }"
        :aria-label="isOpen ? '收起' : '展开'"
        :aria-expanded="isOpen"
        @click="toggle"
      >
        <EraIcon name="chevron" :size="14" />
      </button>
      <span v-else class="vn-caret vn-caret--leaf"></span>
      <span class="vn-key" :class="{ 'vn-key--index': parentIsArray, 'vn-key--reserved': isReserved }" :title="title">{{
        parentIsArray ? `[${k}]` : k
      }}</span>
      <span v-if="isContainer" class="vn-summary" @click="toggle">{{ summary }}</span>
      <span v-else class="vn-val" :class="`vn-val--${valueType}`" :title="fullText">{{ shortText }}</span>
      <span v-if="!ctx.readonly && !isReserved" class="vn-actions">
        <button v-if="isContainer" class="era-icon-btn era-icon-btn--sm" title="在这里新增" @click="add">
          <EraIcon name="plus" :size="14" />
        </button>
        <button class="era-icon-btn era-icon-btn--sm" title="修改" @click="ctx.startEdit(path, v)">
          <EraIcon name="edit" :size="14" />
        </button>
        <button class="era-icon-btn era-icon-btn--sm vn-del" title="删除" @click="ctx.remove(path)">
          <EraIcon name="trash" :size="14" />
        </button>
      </span>
    </div>
    <VarEditor v-if="isEditing" :level="level" />
    <div v-if="isContainer && isOpen" class="vn-children">
      <VarNode
        v-for="[childKey, childValue] in visibleEntries"
        :key="childKey"
        :k="childKey"
        :v="childValue"
        :path="`${path}${pointerSegment(childKey)}`"
        :level="level + 1"
        :parent-is-array="isArray"
        :under-match="underMatch || isMatch"
      />
      <button
        v-if="hiddenCount > 0"
        class="vn-more"
        :style="{ marginLeft: `${(level + 1) * 16 + 26}px` }"
        @click="limit += CHUNK"
      >
        显示更多（还有 {{ hiddenCount }} 项）
      </button>
      <div v-if="entries.length === 0" class="vn-empty" :style="{ paddingLeft: `${(level + 1) * 16 + 26}px` }">
        {{ isArray ? '空数组' : '空对象' }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { displayPath, RESERVED_KEYS, toPointer } from '../workbench';
import EraIcon from './EraIcon.vue';
import VarEditor from './VarEditor.vue';
import { CHUNK, VAR_TREE_KEY } from './var_tree';

defineOptions({ name: 'VarNode' });

const props = withDefaults(
  defineProps<{
    k: string;
    v: unknown;
    path: string;
    level: number;
    parentIsArray?: boolean;
    underMatch?: boolean;
  }>(),
  { parentIsArray: false, underMatch: false },
);

const ctx = inject(VAR_TREE_KEY)!;

const pointerSegment = (key: string) => toPointer([key]);

const isContainer = computed(() => props.v !== null && typeof props.v === 'object');
const isArray = computed(() => Array.isArray(props.v));
const isReserved = computed(() => !props.parentIsArray && RESERVED_KEYS.includes(props.k));
const isMatch = computed(() => ctx.search.value.matches.has(props.path));
const isChanged = computed(() => ctx.changed.value.has(props.path));
const isEditing = computed(() => ctx.editor.value?.path === props.path);
const title = computed(() => displayPath(props.path));

// 展开状态：默认只展开第一层；搜索时自动展开匹配项的祖先
const manualOpen = ref(props.level < 1);
const override = ref<boolean | null>(null);
watch(
  () => ctx.search.value.version,
  () => (override.value = null),
);
const isOpen = computed(() => {
  if (!isContainer.value) return false;
  if (ctx.search.value.active) return override.value ?? ctx.search.value.ancestors.has(props.path);
  return manualOpen.value;
});
function toggle() {
  if (ctx.search.value.active) override.value = !isOpen.value;
  else manualOpen.value = !manualOpen.value;
}
function add() {
  if (!isOpen.value) toggle();
  ctx.startAdd(props.path, isArray.value);
}

const entries = computed<[string, unknown][]>(() => {
  if (!isOpen.value) return [];
  const value = props.v as any;
  const all: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  const search = ctx.search.value;
  if (!search.active || props.underMatch || isMatch.value) return all;
  return all.filter(([key]) => {
    const childPath = `${props.path}${toPointer([key])}`;
    return search.matches.has(childPath) || search.ancestors.has(childPath);
  });
});
const limit = ref(CHUNK);
const visibleEntries = computed(() => entries.value.slice(0, limit.value));
const hiddenCount = computed(() => Math.max(0, entries.value.length - limit.value));

const summary = computed(() => {
  const value = props.v as any;
  if (Array.isArray(value)) return `[ ${value.length} 项 ]`;
  const count = Object.keys(value).filter(key => !RESERVED_KEYS.includes(key)).length;
  return `{ ${count} 个键 }`;
});

const valueType = computed(() => {
  const value = props.v;
  if (value === null) return 'null';
  return typeof value;
});
const fullText = computed(() => {
  const value = props.v;
  if (typeof value === 'string') return value;
  return String(value);
});
const shortText = computed(() => {
  const value = props.v;
  const text = typeof value === 'string' ? `"${value}"` : String(value);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
});
</script>

<style>
.era-root .vn-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding-right: 4px;
  border-radius: 7px;
  font-size: 13px;
}
.era-root .vn-row:hover {
  background: var(--era-hover);
}
.era-root .vn-row--match {
  background: var(--era-accent-soft);
}
.era-root .vn-row--changed::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 3px;
  background: var(--era-warn);
}
.era-root .vn-row--editing {
  background: var(--era-surface-2);
}
.era-root .vn-caret {
  display: grid;
  flex: none;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--era-muted);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.era-root .vn-caret.open {
  transform: rotate(90deg);
}
.era-root .vn-caret--leaf {
  cursor: default;
}
.era-root .vn-key {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.era-root .vn-key::after {
  content: ':';
  color: var(--era-faint);
  font-weight: 400;
}
.era-root .vn-key--index {
  color: var(--era-muted);
  font-family: var(--era-mono);
  font-size: 12px;
  font-weight: 500;
}
.era-root .vn-key--reserved {
  color: var(--era-faint);
}
.era-root .vn-summary {
  color: var(--era-faint);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.era-root .vn-val {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-family: var(--era-mono);
  font-size: 12.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.era-root .vn-val--string {
  color: color-mix(in srgb, var(--era-ok) 75%, var(--era-text));
}
.era-root .vn-val--number {
  color: color-mix(in srgb, var(--era-info) 70%, var(--era-text));
}
.era-root .vn-val--boolean {
  color: color-mix(in srgb, var(--era-warn) 80%, var(--era-text));
}
.era-root .vn-val--null,
.era-root .vn-val--undefined {
  color: var(--era-faint);
  font-style: italic;
}
.era-root .vn-actions {
  display: flex;
  flex: none;
  gap: 1px;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.era-root .vn-row:hover .vn-actions,
.era-root .vn-row:focus-within .vn-actions,
.era-root .vn-row--editing .vn-actions {
  opacity: 1;
}
@media (hover: none) {
  .era-root .vn-actions {
    opacity: 0.75;
  }
}
.era-root .vn-del:hover:not(:disabled) {
  color: var(--era-danger);
}
.era-root .vn-more {
  height: 26px;
  margin: 2px 0 4px;
  padding: 0 10px;
  border: 1px dashed var(--era-line-strong);
  border-radius: 7px;
  background: transparent;
  color: var(--era-muted);
  font-size: 12px;
  cursor: pointer;
}
.era-root .vn-empty {
  min-height: 24px;
  color: var(--era-faint);
  font-size: 12px;
  font-style: italic;
}
</style>
