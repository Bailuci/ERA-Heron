<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：内置线条图标
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <svg
    class="era-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="ICONS[name]" />
  </svg>
</template>

<script setup lang="ts">
import { ICONS, IconName } from '../icons';

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 18 });
</script>

<style>
.era-root .era-icon {
  flex: none;
  display: block;
}
</style>
