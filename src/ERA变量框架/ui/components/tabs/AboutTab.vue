<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增（取代 RightRailContent/AboutEra.vue）。
  日期：2026-11-26 至 2026-11-27
  目的：重新设计面板：关于页（名称与版本、作者与原作者、许可说明、文档入口、面板入口说明）；调整项目介绍与作者说法；2026-11-27 去掉交流群信息；文档入口补上 08 动态提示词
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="atab">
    <section class="era-card atab-hero">
      <div class="atab-logo" aria-hidden="true">ERA</div>
      <div class="atab-hero__text">
        <h3 class="atab-title">
          ERA-Heron <span class="atab-ver">v{{ ERA_VERSION }}</span>
        </h3>
        <p class="era-hint">
          基于 ERA 变量框架（Efficient Rollback
          Architecture）二次开发、持续迭代的酒馆助手变量框架。按消息记录变量的每一次修改，删除、滑动、编辑消息时自动回滚和重算。
        </p>
      </div>
    </section>

    <section class="era-card">
      <div class="era-card__title atab-section">作者</div>
      <dl class="atab-kv">
        <div>
          <dt>作者</dt>
          <dd>
            白鹭辞（Bailuci）·
            <a :href="ERA_REPOSITORY" target="_blank" rel="noopener noreferrer">GitHub · ERA-Heron</a>
          </dd>
        </div>
        <div>
          <dt>原作者</dt>
          <dd>
            世界的山田（RockingSisyphus）·
            <a :href="ORIGINAL_REPOSITORY" target="_blank" rel="noopener noreferrer">GitHub · 原版 ERA</a>
            ·
            <a :href="ORIGINAL_POST" target="_blank" rel="noopener noreferrer">原版介绍帖（Discord）</a>
          </dd>
        </div>
      </dl>
    </section>

    <section class="era-card">
      <div class="era-card__title atab-section">文档</div>
      <div class="atab-docs">
        <a
          v-for="item in DOCS"
          :key="item.file"
          class="atab-doc"
          :href="docUrl(item.file)"
          target="_blank"
          rel="noopener noreferrer"
        >
          <EraIcon name="book" :size="16" />
          <span class="atab-doc__name">{{ item.title }}</span>
          <span class="atab-doc__desc">{{ item.desc }}</span>
        </a>
      </div>
    </section>

    <section class="era-card">
      <div class="era-card__title atab-section">打开面板的方式</div>
      <ul class="atab-list">
        <li>点击悬浮球；拖动可以移动，松手贴到屏幕边缘；右键或长按有更多选项。</li>
        <li>酒馆扩展菜单（输入框左侧的魔棒图标）→ “ERA 面板”。</li>
        <li>
          在输入框发送 <code>/era</code> 打开面板，<code>/era ball</code> 显示悬浮球，<code>/era hide</code>
          隐藏悬浮球。
        </li>
        <li>酒馆助手脚本按钮：在 ERA 脚本的按钮设置里打开“ERA 面板”按钮即可显示。</li>
      </ul>
    </section>

    <section class="era-card">
      <div class="era-card__title atab-section">运行信息</div>
      <dl class="atab-kv">
        <div>
          <dt>变量结构</dt>
          <dd>{{ hasSchema ? '角色卡注册了变量结构（schema）' : '没有注册变量结构' }}</dd>
        </div>
        <div>
          <dt>面板功能</dt>
          <dd>{{ tabNames }}</dd>
        </div>
      </dl>
    </section>

    <section class="era-card atab-license">
      <div class="era-card__title atab-section">许可</div>
      <p class="era-hint">
        按 Aladdin Free Public
        License（AFPL）免费提供，不提供任何担保。<strong>免费使用，不得收费分发</strong>，只能按该许可免费再分发；修改版需注明修改人、日期与目的。许可证全文见仓库中的
        LICENSE。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Era } from '../../../api/global';
import { ERA_REPOSITORY, ERA_VERSION } from '../../../utils/constants';
import { availableTabs } from '../../tabs';
import EraIcon from '../../template/EraIcon.vue';

const ORIGINAL_REPOSITORY = 'https://github.com/RockingSisyphus/ERA-EfficientRollbackArchitecture/tree/master';
const ORIGINAL_POST = 'https://discord.com/channels/1134557553011998840/1423319849400270928';

const DOCS = [
  { file: '01-快速上手.md', title: '01 快速上手', desc: '安装、初始化与第一张卡' },
  { file: '02-指令手册.md', title: '02 指令手册', desc: 'Insert / Edit / Delete / Patch 与 $meta' },
  { file: '03-状态栏.md', title: '03 状态栏', desc: '在楼层里显示变量' },
  { file: '04-宏.md', title: '04 宏', desc: '{{ERA:…}} 等宏' },
  { file: '05-接口与设置.md', title: '05 接口与设置', desc: 'Era 全局接口、事件与脚本设置' },
  { file: '06-分步更新.md', title: '06 分步更新', desc: '用额外模型更新变量' },
  { file: '07-常见问题与排错.md', title: '07 常见问题与排错', desc: '变量不更新、宏没替换、找不到面板' },
  { file: '08-动态提示词.md', title: '08 动态提示词', desc: 'EJS、条目过滤器与按变量切换提示词' },
];
const docUrl = (file: string) => `${ERA_REPOSITORY}/blob/main/doc/${encodeURIComponent(file)}`;

const hasSchema = computed(() => {
  try {
    return Era.hasSchema();
  } catch {
    return false;
  }
});
const tabNames = computed(() => availableTabs.value.map(tab => tab.label).join('、'));
</script>

<style>
.era-root .atab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.era-root .atab .era-card + .era-card {
  margin-top: 0;
}
.era-root .atab-hero {
  display: flex;
  align-items: center;
  gap: 16px;
  background: linear-gradient(135deg, var(--era-accent-soft), transparent 70%), var(--era-surface);
}
.era-root .atab-logo {
  display: grid;
  flex: none;
  place-items: center;
  width: 56px;
  height: 56px;
  border: 1px solid var(--era-accent-line);
  border-radius: 16px;
  background: var(--era-panel);
  color: var(--era-accent);
  font-size: 17px;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.era-root .atab-title {
  font-size: 18px;
  font-weight: 800;
}
.era-root .atab-ver {
  color: var(--era-muted);
  font-size: 13px;
  font-weight: 600;
}
.era-root .atab-section {
  margin-bottom: 8px;
}
.era-root .atab-kv {
  display: grid;
  gap: 8px;
  margin: 0;
}
.era-root .atab-kv > div {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 10px;
}
.era-root .atab-kv dt {
  color: var(--era-muted);
  font-size: 12px;
  line-height: 1.7;
}
.era-root .atab-kv dd {
  margin: 0;
  font-size: 13px;
}
.era-root .atab-docs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
}
.era-root .atab-doc {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 8px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--era-line);
  border-radius: var(--era-radius-sm);
  color: var(--era-text);
}
.era-root .atab-doc:hover {
  border-color: var(--era-accent-line);
  background: var(--era-accent-soft);
  text-decoration: none;
}
.era-root .atab-doc > .era-icon {
  color: var(--era-accent);
}
.era-root .atab-doc__name {
  font-size: 13px;
  font-weight: 700;
}
.era-root .atab-doc__desc {
  grid-column: 2;
  color: var(--era-muted);
  font-size: 12px;
}
.era-root .atab-list {
  margin: 0 0 0 18px;
  padding: 0;
  color: var(--era-muted);
  font-size: 13px;
  line-height: 1.7;
}
.era-root .atab-list code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--era-surface-2);
  color: var(--era-text);
  font-family: var(--era-mono);
  font-size: 12px;
}
</style>
