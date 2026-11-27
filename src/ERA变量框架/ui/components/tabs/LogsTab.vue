<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：日志页（最近的问题、最新一楼的操作、按楼分页查看全部日志），不再一次渲染整个聊天的日志；问题可以跳转到对应页面（2026-11-26）
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <div class="ltab">
    <section v-if="store.problems.length > 0" class="era-card ltab-problems">
      <div class="era-card__head">
        <EraIcon name="alert" :size="16" class="ltab-problems__icon" />
        <span class="era-card__title">最近的问题</span>
        <span class="era-card__sub">{{ store.problems.length }} 条，只保存在本次页面中</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm" @click="store.clearProblems()">清空</button>
      </div>
      <ul class="ltab-problem-list">
        <li v-for="problem in shownProblems" :key="problem.id" class="ltab-problem">
          <div class="ltab-problem__head">
            <span class="era-chip era-chip--danger">{{ problem.source }}</span>
            <span class="ltab-problem__title">{{ problem.title }}</span>
            <span class="era-spacer"></span>
            <button v-if="problem.tab" class="era-btn era-btn--sm" @click="store.openPanel(problem.tab)">
              {{ problem.tabLabel || '查看' }}
            </button>
            <span class="ltab-time">{{ formatTime(problem.time) }}</span>
          </div>
          <pre v-if="problem.detail" class="ltab-problem__detail">{{ problem.detail }}</pre>
        </li>
      </ul>
      <button v-if="store.problems.length > shownProblems.length" class="vn-more" @click="problemLimit += 10">
        显示更多
      </button>
    </section>

    <div v-if="!data" class="era-empty">
      <EraIcon name="logs" :size="22" />
      还没有收到 ERA 的写入记录。发送或重新生成一条消息后会显示在这里。
    </div>

    <template v-else>
      <section class="era-card">
        <div class="era-card__head">
          <span class="era-card__title">最新一楼</span>
          <span class="era-spacer"></span>
          <button class="era-btn era-btn--sm" title="复制 MK" @click="copy(data.mk)">
            <EraIcon name="copy" :size="14" />复制 MK
          </button>
        </div>
        <dl class="ltab-kv">
          <div>
            <dt>楼层</dt>
            <dd>第 {{ data.message_id }} 楼（{{ data.is_user ? '用户' : 'AI' }}）</dd>
          </div>
          <div>
            <dt>MK</dt>
            <dd class="era-mono" :title="data.mk">{{ data.mk || '—' }}</dd>
          </div>
          <div>
            <dt>本轮</dt>
            <dd class="ltab-actions">
              <span v-for="action in actionChips" :key="action" class="era-chip era-chip--accent">{{ action }}</span>
              <span v-if="actionChips.length === 0" class="era-chip">无变化</span>
              <span v-if="data.consecutiveProcessingCount > 1" class="era-chip">
                连续第 {{ data.consecutiveProcessingCount }} 次
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section class="era-card">
        <div class="era-card__head">
          <span class="era-card__title">最新一楼的操作</span>
          <span class="era-card__sub">{{ latestLogs.length }} 条</span>
        </div>
        <LogEntries :entries="latestLogs" />
      </section>

      <section class="era-card">
        <div class="era-card__head">
          <span class="era-card__title">全部楼层</span>
          <span class="era-card__sub">{{ floors.length }} 楼有日志</span>
          <span class="era-spacer"></span>
          <input
            v-model.number="jumpTo"
            class="era-input ltab-jump"
            type="number"
            min="0"
            placeholder="跳到楼层"
            aria-label="跳到楼层"
            @keyup.enter="jump"
          />
        </div>
        <div v-if="floors.length === 0" class="era-hint">没有逐楼日志（可能已被“日志保留楼层数”折叠）。</div>
        <ul v-else class="ltab-floors">
          <li v-for="floor in pageFloors" :key="floor.mk" class="ltab-floor">
            <button class="ltab-floor__head" :aria-expanded="expanded === floor.mk" @click="toggleFloor(floor.mk)">
              <EraIcon name="chevron" :size="14" class="ltab-caret" :class="{ open: expanded === floor.mk }" />
              <span class="ltab-floor__id">#{{ floor.message_id }}</span>
              <span class="era-mono ltab-floor__mk" :title="floor.mk">{{ shortMk(floor.mk) }}</span>
              <span class="era-spacer"></span>
              <span class="era-chip">{{ floor.count }} 条</span>
            </button>
            <LogEntries v-if="expanded === floor.mk" :entries="logsOf(floor.mk)" class="ltab-floor__body" />
          </li>
        </ul>
        <div v-if="pageCount > 1" class="ltab-pager">
          <button class="era-btn era-btn--sm" :disabled="page === 0" @click="page--">上一页</button>
          <span class="era-hint">{{ page + 1 }} / {{ pageCount }}</span>
          <button class="era-btn era-btn--sm" :disabled="page >= pageCount - 1" @click="page++">下一页</button>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import toastr from 'toastr';
import { computed, onMounted, ref, watch } from 'vue';
import { copyText, formatTime, shortMk } from '../../actions';
import { useUiStore } from '../../store';
import EraIcon from '../../template/EraIcon.vue';
import LogEntries from '../../template/LogEntries.vue';

const PAGE_SIZE = 20;

const store = useUiStore();
const data = computed(() => store.eventData);

onMounted(() => store.markProblemsSeen());
watch(
  () => store.problems,
  () => store.markProblemsSeen(),
);

const problemLimit = ref(5);
const shownProblems = computed(() => store.problems.slice(0, problemLimit.value));

const ACTION_LABELS: Record<string, string> = {
  rollback: '回滚',
  apply: '写入',
  resync: '重算',
  api: '接口调用',
  apiWrite: '接口写入',
  editedResync: '编辑后重算',
  swipedRollback: '滑动回退',
};
const actionChips = computed(() =>
  Object.entries(data.value?.actions ?? {})
    .filter(([, on]) => on)
    .map(([key]) => ACTION_LABELS[key] ?? key),
);

const logsOf = (mk: string): any[] => {
  const logs = data.value?.editLogs?.[mk];
  return Array.isArray(logs) ? logs : [];
};
const latestLogs = computed(() => (data.value ? logsOf(data.value.mk) : []));

/** 有日志的楼层，最新的在前。 */
const floors = computed(() => {
  const payload = data.value;
  if (!payload) return [];
  const list: { mk: string; message_id: number; count: number }[] = [];
  const mks = payload.selectedMks ?? [];
  for (let id = mks.length - 1; id >= 0; id--) {
    const mk = mks[id];
    if (!mk) continue;
    const logs = payload.editLogs?.[mk];
    if (Array.isArray(logs)) list.push({ mk, message_id: id, count: logs.length });
  }
  return list;
});

const page = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(floors.value.length / PAGE_SIZE)));
const pageFloors = computed(() => floors.value.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE));
watch(pageCount, count => (page.value = Math.min(page.value, count - 1)));

const expanded = ref<string | null>(null);
function toggleFloor(mk: string) {
  expanded.value = expanded.value === mk ? null : mk;
}

const jumpTo = ref<number | ''>('');
function jump() {
  if (jumpTo.value === '' || !Number.isFinite(jumpTo.value)) return;
  const index = floors.value.findIndex(floor => floor.message_id <= Number(jumpTo.value));
  if (index === -1) {
    toastr.info('没有找到这一楼之前的日志。');
    return;
  }
  page.value = Math.floor(index / PAGE_SIZE);
  expanded.value = floors.value[index].mk;
}

async function copy(text: string) {
  await copyText(text);
  toastr.success('已复制。');
}
</script>

<style>
.era-root .ltab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.era-root .ltab .era-card + .era-card {
  margin-top: 0;
}
.era-root .ltab-problems {
  border-color: color-mix(in srgb, var(--era-danger) 40%, transparent);
}
.era-root .ltab-problems__icon {
  color: var(--era-danger);
}
.era-root .ltab-problem-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
}
.era-root .ltab-problem {
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--era-surface);
}
.era-root .ltab-problem__head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.era-root .ltab-problem__title {
  font-size: 13px;
  font-weight: 600;
}
.era-root .ltab-problem__detail {
  max-height: 120px;
  margin-top: 6px;
  overflow: auto;
  color: var(--era-muted);
  font-family: var(--era-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.era-root .ltab-time {
  color: var(--era-faint);
  font-size: 11px;
}
.era-root .ltab-kv {
  display: grid;
  gap: 6px;
  margin: 0;
}
.era-root .ltab-kv > div {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 10px;
  align-items: baseline;
}
.era-root .ltab-kv dt {
  color: var(--era-muted);
  font-size: 12px;
}
.era-root .ltab-kv dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
}
.era-root .ltab-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.era-root .era-card__head > .ltab-jump {
  width: 110px;
  height: 28px;
}
.era-root .ltab-floors {
  display: flex;
  flex-direction: column;
  gap: 2px;
  list-style: none;
}
.era-root .ltab-floor__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--era-text);
  font-size: 13px;
  cursor: pointer;
}
.era-root .ltab-floor__head:hover {
  background: var(--era-hover);
}
.era-root .ltab-caret {
  color: var(--era-muted);
  transition: transform 0.15s ease;
}
.era-root .ltab-caret.open {
  transform: rotate(90deg);
}
.era-root .ltab-floor__id {
  min-width: 44px;
  font-weight: 700;
}
.era-root .ltab-floor__mk {
  color: var(--era-muted);
  font-size: 12px;
}
.era-root .ltab-floor__body {
  margin: 2px 0 8px 22px;
}
.era-root .ltab-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 10px;
}
</style>
