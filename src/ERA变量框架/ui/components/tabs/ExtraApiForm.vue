<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-25 至 2026-11-26
  目的：面板：分步更新设置、重新解析、更新旧卡规则；重新设计面板（统一样式，移到分步更新页）；默认推荐跟随酒馆或代理预设，自定义接口时提示密钥风险
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <fieldset class="xapi">
    <legend class="xapi__legend">
      <span>{{ title }}</span>
      <slot name="actions"></slot>
    </legend>
    <label class="xform-row">
      <span>来源</span>
      <select v-model="api.来源" class="era-select">
        <option value="跟随酒馆">跟随酒馆当前连接（推荐，ERA 不保存密钥）</option>
        <option value="代理预设">酒馆的代理预设（推荐，ERA 不保存密钥）</option>
        <option value="自定义">自定义接口（密钥保存在全局变量里）</option>
      </select>
    </label>
    <p v-if="api.来源 === '代理预设' && presets.length === 0" class="era-hint">
      还没有代理预设：在酒馆的“API 连接”面板里填好反向代理地址和密码后保存为代理预设，这里就能选择。
    </p>
    <label v-if="api.来源 === '代理预设'" class="xform-row">
      <span>代理预设</span>
      <select v-model="api.代理预设" class="era-select">
        <option v-for="name in presets" :key="name" :value="name">{{ name }}</option>
      </select>
    </label>
    <template v-if="api.来源 === '自定义'">
      <label class="xform-row">
        <span>接口地址</span>
        <input v-model.trim="api.接口地址" class="era-input" placeholder="https://…/v1" />
      </label>
      <label class="xform-row">
        <span>密钥</span>
        <input v-model.trim="api.密钥" type="password" autocomplete="off" class="era-input" />
      </label>
      <p class="era-hint xapi__warn">
        密钥会保存在酒馆的全局变量里，其他角色卡的脚本和前端界面都能读到（存到浏览器本地也一样）。更推荐用“酒馆的代理预设”：密钥只保存在酒馆自己的设置里。
      </p>
    </template>
    <label v-if="api.来源 !== '跟随酒馆'" class="xform-row">
      <span>接口类型</span>
      <input v-model.trim="api.接口类型" class="era-input" placeholder="openai" />
    </label>
    <label class="xform-row">
      <span>模型</span>
      <span class="xapi__model">
        <input
          v-model.trim="api.模型"
          class="era-input"
          :list="listId"
          :placeholder="api.来源 === '跟随酒馆' ? '留空则与剧情相同' : '模型名'"
        />
        <button
          v-if="api.来源 === '自定义'"
          class="era-btn era-btn--sm"
          :disabled="fetching"
          @click.prevent.stop="fetchModels"
        >
          <span v-if="fetching" class="era-spinner"></span>获取列表
        </button>
      </span>
      <datalist :id="listId">
        <option v-for="model in models" :key="model" :value="model" />
      </datalist>
    </label>
  </fieldset>
</template>

<script setup lang="ts">
import toastr from 'toastr';
import { ref } from 'vue';
import type { ExtraApi } from '../../../extra/config';

defineProps<{ title: string }>();
const api = defineModel<ExtraApi>({ required: true });

const listId = `era-models-${Math.random().toString(36).slice(2)}`;
const models = ref<string[]>([]);
const presets = ref<string[]>([]);
const fetching = ref(false);
try {
  presets.value = getProxyPresetNames();
} catch {
  // 旧版酒馆助手没有该接口
}

async function fetchModels() {
  fetching.value = true;
  try {
    models.value = await getModelList({ apiurl: api.value.接口地址, key: api.value.密钥 });
    toastr.success(`共 ${models.value.length} 个模型，可在模型框中选择。`, '获取成功');
  } catch (error: any) {
    toastr.error(String(error?.message ?? error), '获取模型列表失败');
  } finally {
    fetching.value = false;
  }
}
</script>

<style>
.era-root .xapi {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 10px 12px 12px;
  border: 1px solid var(--era-line);
  border-radius: var(--era-radius-sm);
}
.era-root .xapi__legend {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
  font-size: 12px;
  font-weight: 700;
}
.era-root .xapi__model {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.era-root .xapi__model .era-input {
  flex: 1;
  min-width: 0;
}
.era-root .xapi__model .era-btn {
  height: 32px;
}
.era-root .xapi__warn {
  color: var(--era-warn, #b7791f);
}
</style>
