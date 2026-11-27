<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：变量树（取代旧的 PrettyJsonViewer / JsonNode，默认只展开第一层，大容器分批渲染）
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="vt" :class="{ 'vt--readonly': readonly }">
    <VarEditor v-if="editor && editor.path === ''" :level="0" />
    <template v-if="isContainer">
      <VarNode
        v-for="[key, child] in visibleEntries"
        :key="key"
        :k="key"
        :v="child"
        :path="toPointer([key])"
        :level="0"
        :parent-is-array="isArray"
      />
      <button v-if="hiddenCount > 0" class="vn-more" @click="limit += CHUNK">
        显示更多（还有 {{ hiddenCount }} 项）
      </button>
      <div v-if="entries.length === 0" class="era-empty">
        {{ search.active ? '没有匹配的变量' : '还没有任何变量' }}
      </div>
    </template>
    <div v-else class="era-empty">{{ value === undefined ? '没有数据' : String(value) }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, provide, ref, toRef, watch } from 'vue';
import { searchTree, toPointer } from '../workbench';
import { CHUNK, EditorState, VAR_TREE_KEY } from './var_tree';
import VarEditor from './VarEditor.vue';
import VarNode from './VarNode.vue';

const props = withDefaults(
  defineProps<{
    value: unknown;
    readonly?: boolean;
    query?: string;
    changed?: Set<string>;
    editor?: EditorState | null;
  }>(),
  { readonly: false, query: '', changed: () => new Set<string>(), editor: null },
);

const emit = defineEmits<{
  (e: 'edit', path: string, value: unknown): void;
  (e: 'add', path: string, isArray: boolean): void;
  (e: 'remove', path: string): void;
  (e: 'submit'): void;
  (e: 'cancel'): void;
  (e: 'searched', result: { matches: number; truncated: boolean }): void;
}>();

const isContainer = computed(() => props.value !== null && typeof props.value === 'object');
const isArray = computed(() => Array.isArray(props.value));

let version = 0;
const search = computed(() => {
  const result = searchTree(props.value, props.query);
  return { active: props.query.trim() !== '', ...result, version: ++version };
});
watch(search, result => emit('searched', { matches: result.matches.size, truncated: result.truncated }), {
  immediate: true,
});

const entries = computed<[string, unknown][]>(() => {
  if (!isContainer.value) return [];
  const value = props.value as any;
  const all: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  if (!search.value.active) return all;
  return all.filter(([key]) => {
    const path = toPointer([key]);
    return search.value.matches.has(path) || search.value.ancestors.has(path);
  });
});
const limit = ref(CHUNK);
const visibleEntries = computed(() => entries.value.slice(0, limit.value));
const hiddenCount = computed(() => Math.max(0, entries.value.length - limit.value));

// readonly 在挂载时确定；需要切换时由父组件用 key 重新创建
provide(VAR_TREE_KEY, {
  readonly: props.readonly,
  search,
  changed: toRef(props, 'changed'),
  editor: toRef(props, 'editor'),
  startEdit: (path, value) => emit('edit', path, value),
  startAdd: (path, isArrayParent) => emit('add', path, isArrayParent),
  remove: path => emit('remove', path),
  submit: () => emit('submit'),
  cancel: () => emit('cancel'),
});
</script>

<style>
.era-root .vt {
  display: flex;
  flex-direction: column;
}
</style>
