<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增（取代 RightRailContent/ActionButtons.vue）。
  日期：2026-11-26
  目的：重新设计面板：维护工具（完全重算、重算最后一楼、回滚、快速初始化、更新旧卡的规则），显示进行中与完成/失败反馈，危险操作两步确认
          2026-11-28 补全快速初始化的说明
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="ttab">
    <h3 class="ttab-group">变量</h3>

    <section class="era-card ttab-item">
      <div class="ttab-item__text">
        <div class="era-card__title">重算最后一楼</div>
        <p class="era-hint">按最新一条消息重新计算变量，速度快。手动编辑了最后一条消息后可以用它。</p>
      </div>
      <button class="era-btn" :disabled="latestTask.state.busy" @click="syncLatest">
        <span v-if="latestTask.state.busy" class="era-spinner"></span>
        <EraIcon v-else name="refresh" :size="16" />重算
      </button>
      <TaskStatus :task="latestTask.state" />
    </section>

    <section class="era-card ttab-item">
      <div class="ttab-item__text">
        <div class="era-card__title">完全重算</div>
        <p class="era-hint">
          从第一条消息开始重新计算全部变量。变量和预期不符时使用；聊天很长时需要较长时间，期间请不要切换聊天。
        </p>
      </div>
      <button
        class="era-btn"
        :class="armed === 'full' ? 'era-btn--armed' : ''"
        :disabled="fullTask.state.busy"
        @click="syncFull"
      >
        <span v-if="fullTask.state.busy" class="era-spinner"></span>
        <EraIcon v-else name="refresh" :size="16" />{{ armed === 'full' ? '再点一次确认' : '完全重算' }}
      </button>
      <TaskStatus :task="fullTask.state" />
    </section>

    <section class="era-card ttab-item">
      <div class="ttab-item__text">
        <div class="era-card__title">回滚到某一楼</div>
        <p class="era-hint">把变量恢复到指定楼层处理完的状态并停在那里，直到下一次同步。消息不会被删除。</p>
      </div>
      <div class="ttab-inline">
        <input
          v-model.number="rollbackId"
          class="era-input"
          :class="{ 'era-input--invalid': rollbackInvalid }"
          type="number"
          min="0"
          placeholder="消息 ID"
          aria-label="要回滚到的消息 ID"
        />
        <button
          class="era-btn"
          :class="armed === 'rollback' ? 'era-btn--armed' : 'era-btn--danger'"
          :disabled="rollbackTask.state.busy"
          @click="rollback"
        >
          <span v-if="rollbackTask.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="undo" :size="16" />{{ armed === 'rollback' ? '再点一次确认' : '回滚' }}
        </button>
      </div>
      <TaskStatus :task="rollbackTask.state" />
    </section>

    <h3 class="ttab-group">角色卡作者</h3>

    <section class="era-card ttab-item">
      <div class="ttab-item__text">
        <div class="era-card__title">ERA 快速初始化</div>
        <p class="era-hint">向当前角色卡加入 ERA 的基础配置，已存在的不会重复添加：</p>
        <ul class="ttab-list">
          <li>四条隐藏用的局部正则（数据、元数据、思考块、状态栏占位符）：不让这些标签显示出来或发给 AI；</li>
          <li>局部正则“ERA 状态栏模板”：把占位符替换成状态栏；</li>
          <li>主世界书条目“ERA 变量操作规则”：告诉 AI 如何写变量指令；</li>
          <li>主世界书条目“ERA 变量意图说明”：在这里写每个变量的用途。</li>
        </ul>
        <p class="era-hint">之后还需要：在开场白里写好初始变量，在“ERA 变量意图说明”里说明变量，并修改状态栏模板。</p>
      </div>
      <button class="era-btn" :disabled="initTask.state.busy" @click="quickInit">
        <span v-if="initTask.state.busy" class="era-spinner"></span>
        <EraIcon v-else name="play" :size="16" />快速初始化
      </button>
      <TaskStatus :task="initTask.state" />
    </section>

    <section class="era-card ttab-item">
      <div class="ttab-item__text">
        <div class="era-card__title">更新旧卡的规则</div>
        <p class="era-hint">
          把已有的“ERA 变量操作规则”条目和“ERA 数据隐藏正则”“ERA 元数据隐藏正则”更新到当前版本，让 AI
          认识新的指令。原来的内容会另存为关闭的备份。
        </p>
      </div>
      <button class="era-btn" :disabled="rulesTask.state.busy" @click="updateRules">
        <span v-if="rulesTask.state.busy" class="era-spinner"></span>
        <EraIcon v-else name="refresh" :size="16" />更新规则
      </button>
      <TaskStatus :task="rulesTask.state" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { initEraCharacterRegexes } from '../../../initer/manual/regex';
import { describeUpdateResult, updateEraRules } from '../../../initer/manual/update';
import { initEraWorldbookEntries } from '../../../initer/manual/worldbook';
import { forceSync, useConfirm, useTask } from '../../actions';
import { useUiStore } from '../../store';
import EraIcon from '../../template/EraIcon.vue';
import TaskStatus from '../../template/TaskStatus.vue';

const store = useUiStore();
const { armed, confirm } = useConfirm();

const latestTask = useTask();
const fullTask = useTask();
const rollbackTask = useTask();
const initTask = useTask();
const rulesTask = useTask();

const seconds = (start: number) => ((Date.now() - start) / 1000).toFixed(1);

/** 失败时同时记入“最近的问题”，关闭面板后仍能在悬浮球上看到。 */
async function runTracked(
  task: ReturnType<typeof useTask>,
  title: string,
  fn: () => Promise<string | { warn: string } | void>,
  busyText: string,
) {
  const ok = await task.run(() => store.track(fn), busyText);
  if (!ok) store.addProblem({ source: '面板', title, detail: task.state.text });
}

function syncLatest() {
  const start = Date.now();
  runTracked(
    latestTask,
    '重算最后一楼失败',
    async () => {
      const done = await forceSync({ mode: 'latest' }, 60000);
      if (!done) return { warn: '已发出请求，但一分钟内没有收到完成通知，可能仍在进行。' };
      return `完成，用时 ${seconds(start)} 秒。`;
    },
    '正在重算最后一楼…',
  );
}

function syncFull() {
  if (!confirm('full')) return;
  const start = Date.now();
  runTracked(
    fullTask,
    '完全重算失败',
    async () => {
      const done = await forceSync({ mode: 'full' }, 10 * 60 * 1000);
      if (!done) return { warn: '已发出请求，但十分钟内没有收到完成通知，可能仍在后台进行。' };
      return `完成，用时 ${seconds(start)} 秒。`;
    },
    '正在从第一条消息开始重算，聊天很长时需要一些时间…',
  );
}

const rollbackId = ref<number | ''>('');
const rollbackInvalid = ref(false);
function rollback() {
  const id = rollbackId.value;
  if (id === '' || !Number.isInteger(id) || id < 0) {
    rollbackInvalid.value = true;
    rollbackTask.state.kind = 'error';
    rollbackTask.state.text = '请输入一个非负整数的消息 ID。';
    return;
  }
  rollbackInvalid.value = false;
  if (!confirm('rollback')) return;
  runTracked(
    rollbackTask,
    '回滚失败',
    async () => {
      const done = await forceSync({ mode: 'rollbackTo', message_id: id }, 120000);
      if (!done) return { warn: '已发出回滚请求，但两分钟内没有收到完成通知，可能仍在进行。' };
      return `已回滚到第 ${id} 楼之后的状态。`;
    },
    `正在回滚到第 ${id} 楼…`,
  );
}

const statusCount = (details: { status: string }[], status: string) =>
  details.filter(item => item.status === status).length;

function quickInit() {
  runTracked(
    initTask,
    '快速初始化失败',
    async () => {
      const first = getChatMessages(0);
      if (!first || first.length === 0) {
        throw new Error('当前聊天没有开场白。请先在角色卡的开场白中写入任意内容，再点快速初始化。');
      }
      const lines: string[] = [];
      const regex = await initEraCharacterRegexes();
      if (!regex.success) throw new Error(`正则初始化失败：${regex.reason ?? '未知错误'}`);
      lines.push(
        `正则：新增 ${statusCount(regex.details, 'injected')} 条，已存在 ${statusCount(regex.details, 'exists')} 条。`,
      );
      const worldbook = await initEraWorldbookEntries();
      if (!worldbook.success) {
        throw new Error(`${lines.join('')}世界书初始化失败：${worldbook.reason ?? '一个或多个条目写入失败'}`);
      }
      lines.push(
        `世界书：新增 ${statusCount(worldbook.details, 'injected')} 个条目，已存在 ${statusCount(worldbook.details, 'exists')} 个。`,
      );
      return lines.join('\n');
    },
    '正在写入正则和世界书…',
  );
}

function updateRules() {
  runTracked(
    rulesTask,
    '更新旧卡的规则失败',
    async () => {
      const report = describeUpdateResult(await updateEraRules());
      const lines = [...report.updated];
      if (report.upToDate) lines.push('已经是最新版本，没有需要更新的内容。');
      if (report.warnings.length > 0) return { warn: [...lines, ...report.warnings].join('\n') };
      return lines.join('\n');
    },
    '正在更新规则…',
  );
}
</script>

<style>
.era-root .ttab {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.era-root .ttab .era-card + .era-card {
  margin-top: 0;
}
.era-root .ttab-group {
  margin: 6px 2px 0;
  color: var(--era-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.era-root .ttab-group:first-child {
  margin-top: 0;
}
.era-root .ttab-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px 16px;
  align-items: center;
}
.era-root .ttab-item > .era-status {
  grid-column: 1 / -1;
  margin-top: 4px;
}
.era-root .ttab-item__text .era-hint {
  margin-top: 3px;
}
.era-root .ttab-inline {
  display: flex;
  gap: 6px;
}
.era-root .ttab-inline .era-input {
  width: 96px;
}
.era-root .ttab-list {
  margin: 4px 0 4px 18px;
  padding: 0;
  color: var(--era-muted);
  font-size: 12px;
  line-height: 1.6;
}
@media (max-width: 640px) {
  .era-root .ttab-item {
    grid-template-columns: 1fr;
  }
  .era-root .ttab-item > .era-btn,
  .era-root .ttab-inline {
    justify-self: start;
  }
}
</style>
