<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增（取代 SnapshotManager.vue）。
  日期：2026-11-26
  目的：重新设计面板：历史快照页；只列最近的楼层，更早的按消息 ID 查询；查询失败时显示原因；可从快照回滚
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <div class="stab">
    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">查看某一楼之后的变量</span>
      </div>
      <div class="stab-query">
        <input
          v-model.number="messageId"
          class="era-input"
          type="number"
          min="0"
          placeholder="消息 ID（楼层号）"
          aria-label="消息 ID"
          @keyup.enter="queryById"
        />
        <button class="era-btn era-btn--primary" :disabled="task.state.busy" @click="queryById">
          <span v-if="task.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="search" :size="16" />查询
        </button>
      </div>
      <div v-if="recent.length > 0" class="stab-recent">
        <span class="era-hint">最近的楼层：</span>
        <button
          v-for="floor in recent"
          :key="floor.mk"
          class="era-chip stab-floor"
          :class="{ 'era-chip--accent': result?.mk === floor.mk }"
          :title="floor.mk"
          @click="query({ mk: floor.mk }, floor.message_id)"
        >
          #{{ floor.message_id }}<template v-if="floor.latest">（最新）</template>
        </button>
      </div>
      <div v-if="task.state.kind === 'error'" class="era-status era-status--error">{{ task.state.text }}</div>
    </section>

    <section v-if="result" class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">第 {{ result.message_id }} 楼之后</span>
        <span class="era-chip">{{ result.is_user ? '用户消息' : 'AI 消息' }}</span>
        <span class="era-mono era-card__sub" :title="result.mk">{{ shortMk(result.mk) }}</span>
        <span class="era-spacer"></span>
        <div class="era-segmented">
          <button :class="{ active: view === 'pure' }" @click="view = 'pure'">变量</button>
          <button :class="{ active: view === 'full' }" @click="view = 'full'">含 $meta</button>
        </div>
      </div>
      <div class="stab-search">
        <input v-model="search" class="era-input" placeholder="在快照中搜索" aria-label="在快照中搜索" />
      </div>
      <div class="stab-tree">
        <VarTree :value="view === 'pure' ? result.statWithoutMeta : result.stat" readonly :query="search" />
      </div>
      <div class="stab-rollback">
        <p class="era-hint">回滚会把当前变量恢复到这一楼处理完的状态，并停在那里，直到下一次同步。消息不会被删除。</p>
        <button
          class="era-btn"
          :class="confirmState.armed.value === 'rollback' ? 'era-btn--armed' : 'era-btn--danger'"
          :disabled="rollbackTask.state.busy"
          @click="rollback"
        >
          <span v-if="rollbackTask.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="undo" :size="16" />
          {{ confirmState.armed.value === 'rollback' ? '再点一次确认回滚' : '回滚到这一楼' }}
        </button>
        <div
          v-if="rollbackTask.state.kind || rollbackTask.state.busy"
          class="era-status"
          :class="`era-status--${rollbackTask.state.busy ? 'busy' : rollbackTask.state.kind}`"
        >
          {{ rollbackTask.state.text }}
        </div>
      </div>
    </section>
    <div v-else-if="!task.state.busy && task.state.kind !== 'error'" class="era-empty">
      <EraIcon name="history" :size="22" />
      选择一个楼层，查看它处理完之后的变量。
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { QueryResultItem } from '../../../utils/constants';
import { forceSync, querySnapshot, shortMk, SnapshotQuery, useConfirm, useTask } from '../../actions';
import { useUiStore } from '../../store';
import EraIcon from '../../template/EraIcon.vue';
import VarTree from '../../template/VarTree.vue';

const RECENT = 12;

const store = useUiStore();
const messageId = ref<number | ''>('');
const result = ref<QueryResultItem | null>(null);
const view = ref<'pure' | 'full'>('pure');
const search = ref('');
const task = useTask();
const rollbackTask = useTask();
const confirmState = useConfirm();

const recent = computed(() => {
  const mks = store.eventData?.selectedMks ?? [];
  const list: { mk: string; message_id: number; latest: boolean }[] = [];
  for (let id = mks.length - 1; id >= 0 && list.length < RECENT; id--) {
    const mk = mks[id];
    if (mk) list.push({ mk, message_id: id, latest: list.length === 0 });
  }
  return list;
});

async function query(q: SnapshotQuery, id?: number) {
  if (id !== undefined) messageId.value = id;
  rollbackTask.reset();
  await task.run(async () => {
    result.value = null;
    result.value = await querySnapshot(q);
  }, '正在查询…');
}

function queryById() {
  const id = messageId.value;
  if (id === '' || !Number.isInteger(id) || id < 0) {
    task.state.kind = 'error';
    task.state.text = '请输入一个非负整数的消息 ID。';
    return;
  }
  query({ message_id: id });
}

async function rollback() {
  const target = result.value;
  if (!target || !confirmState.confirm('rollback')) return;
  await rollbackTask.run(async () => {
    const done = await store.track(() => forceSync({ mode: 'rollbackTo', message_id: target.message_id }, 120000));
    if (!done) return { warn: '已发出回滚请求，但两分钟内没有收到完成通知，可能仍在进行。' };
    return `已回滚到第 ${target.message_id} 楼之后的状态。`;
  }, `正在回滚到第 ${target.message_id} 楼…`);
}
</script>

<style>
.era-root .stab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.era-root .stab .era-card + .era-card {
  margin-top: 0;
}
.era-root .stab-query {
  display: flex;
  gap: 8px;
}
.era-root .stab-query .era-input {
  flex: 1;
}
.era-root .stab-recent {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 10px;
}
.era-root .stab-floor {
  height: 24px;
  border: 0;
  cursor: pointer;
}
.era-root .stab-search {
  margin-bottom: 8px;
}
.era-root .stab-tree {
  max-height: 55vh;
  padding: 4px;
  overflow: auto;
  border: 1px solid var(--era-line);
  border-radius: var(--era-radius-sm);
}
.era-root .stab-rollback {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--era-line);
}
.era-root .stab-rollback .era-status {
  align-self: stretch;
  margin-top: 0;
}
</style>
