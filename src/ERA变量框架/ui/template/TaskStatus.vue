<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：操作的进行中、完成、失败提示
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <div
    v-if="task.busy || task.kind"
    class="era-status"
    :class="`era-status--${task.busy ? 'busy' : task.kind}`"
    role="status"
    aria-live="polite"
  >
    <span v-if="task.busy" class="era-spinner"></span>
    <EraIcon v-else :name="task.kind === 'ok' ? 'check' : 'alert'" :size="14" />
    <span>{{ task.text }}</span>
  </div>
</template>

<script setup lang="ts">
import EraIcon from './EraIcon.vue';

defineProps<{ task: { busy: boolean; kind: null | 'ok' | 'error' | 'warn'; text: string } }>();
</script>
