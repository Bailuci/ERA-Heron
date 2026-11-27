<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：一楼的日志条目列表（操作、路径、旧值与新值，可展开查看完整内容）
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="le">
    <div v-if="entries.length === 0" class="era-hint">这一楼没有修改变量。</div>
    <ol v-else class="le-list">
      <li v-for="(entry, index) in shown" :key="index" class="le-item">
        <button class="le-head" :aria-expanded="open.has(index)" @click="toggle(index)">
          <span class="era-chip" :class="chipClass(entry?.op)">{{ opLabel(entry?.op) }}</span>
          <span class="le-path era-mono">{{ entry?.path ?? '（未知路径）' }}</span>
          <span class="le-change era-mono">{{ changeText(entry) }}</span>
        </button>
        <pre v-if="open.has(index)" class="era-code le-detail">{{ pretty(entry) }}</pre>
      </li>
    </ol>
    <button v-if="entries.length > limit" class="vn-more" @click="limit += 50">
      显示更多（还有 {{ entries.length - limit }} 条）
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { preview } from '../workbench';

const props = defineProps<{ entries: any[] }>();

const limit = ref(50);
const shown = computed(() => props.entries.slice(0, limit.value));
const open = reactive(new Set<number>());
function toggle(index: number) {
  if (open.has(index)) open.delete(index);
  else open.add(index);
}

const LABELS: Record<string, string> = { insert: '新增', update: '修改', delete: '删除' };
const opLabel = (op: unknown) => LABELS[String(op)] ?? String(op ?? '?');
const chipClass = (op: unknown) =>
  ({ insert: 'era-chip--ok', update: 'era-chip--accent', delete: 'era-chip--danger' })[String(op)] ?? '';
/** 旧值 → 新值；删除只显示旧值，新增只显示新值。 */
function changeText(entry: any): string {
  const hasOld = entry && 'value_old' in entry;
  const hasNew = entry && 'value_new' in entry;
  if (hasOld && hasNew) return `${preview(entry.value_old, 40)} → ${preview(entry.value_new, 60)}`;
  if (hasOld) return `原为 ${preview(entry.value_old, 80)}`;
  if (hasNew) return preview(entry.value_new, 80);
  return '';
}
const pretty = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
</script>

<style>
.era-root .le-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.era-root .le-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 3px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--era-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.era-root .le-head:hover {
  background: var(--era-hover);
}
.era-root .le-path {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.era-root .le-change {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--era-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.era-root .le-detail {
  margin: 2px 0 6px 8px;
}
</style>
