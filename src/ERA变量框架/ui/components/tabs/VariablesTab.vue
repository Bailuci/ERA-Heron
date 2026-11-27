<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：重新设计面板：变量编辑工作台（搜索；节点上修改、新增、删除；粘贴完整 JSON 计算差异；提交前试算，统一以原子提交写入）；提交前的试算改用楼内试算器，与原子提交的检查一致（2026-11-26）
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <div class="vtab">
    <div class="vtab-toolbar">
      <label class="vtab-search">
        <EraIcon name="search" :size="16" />
        <input v-model="query" class="era-input" placeholder="搜索键名、路径或值" aria-label="搜索变量" />
        <button v-if="query" class="era-icon-btn era-icon-btn--sm" title="清除" @click="query = ''">
          <EraIcon name="close" :size="14" />
        </button>
      </label>
      <div class="era-segmented" role="group" aria-label="显示方式">
        <button :class="{ active: wb.view === 'pure' }" @click="wb.view = 'pure'">变量</button>
        <button :class="{ active: wb.view === 'full' }" title="包含 $meta 与 $template，只读" @click="wb.view = 'full'">
          含 $meta
        </button>
        <button :class="{ active: wb.view === 'bulk' }" title="粘贴完整 JSON，自动计算差异" @click="openBulk">
          批量
        </button>
      </div>
      <button class="era-icon-btn" title="重新读取" @click="refresh"><EraIcon name="refresh" /></button>
    </div>

    <div class="vtab-meta">
      <span v-if="latest">第 {{ latest.message_id }} 楼之后</span>
      <span v-if="topCount !== null">· {{ topCount }} 个顶层变量</span>
      <span v-if="query.trim() && wb.view !== 'bulk'">
        · 匹配 {{ searchInfo.matches }} 项<template v-if="searchInfo.truncated">（只显示前 500 项）</template>
      </span>
      <span class="era-spacer"></span>
      <button
        v-if="wb.view === 'pure'"
        class="era-btn era-btn--sm era-btn--ghost"
        title="在最外层新增一个变量"
        @click="startAdd('', false)"
      >
        <EraIcon name="plus" :size="14" />新增变量
      </button>
    </div>

    <!-- 批量模式 -->
    <section v-if="wb.view === 'bulk'" class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">粘贴完整 JSON</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm" @click="fillCurrent">
          <EraIcon name="clipboard" :size="14" />填入当前变量
        </button>
      </div>
      <p class="era-hint">
        在下面改好整份变量（不含 $meta），点“计算差异”，面板会算出需要的修改并暂存。$meta 与 $template 会被忽略。
      </p>
      <textarea
        v-model="wb.bulkText"
        class="era-textarea vtab-bulk"
        spellcheck="false"
        placeholder='{ "player": { "hp": 100 } }'
      ></textarea>
      <div class="era-row vtab-bulk-actions">
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--primary" :disabled="!wb.bulkText.trim()" @click="computeDiff">
          <EraIcon name="diff" :size="16" />计算差异
        </button>
      </div>
      <div v-if="bulkStatus" class="era-status" :class="`era-status--${bulkStatus.kind}`">{{ bulkStatus.text }}</div>
    </section>

    <!-- 变量树 -->
    <section v-else class="vtab-tree">
      <VarTree
        :key="wb.view"
        :value="viewData"
        :readonly="wb.view === 'full'"
        :query="debouncedQuery"
        :changed="changedPaths"
        :editor="editor"
        @edit="startEdit"
        @add="startAdd"
        @remove="stageRemove"
        @submit="submitEditor"
        @cancel="editor = null"
        @searched="info => (searchInfo = info)"
      />
      <p v-if="wb.view === 'full'" class="era-hint vtab-note">
        这里显示含保护规则（$meta）和模板（$template）的完整数据，只读。修改请切回“变量”。
      </p>
    </section>

    <!-- 暂存的修改 -->
    <section v-if="wb.ops.length > 0" class="vtab-staged">
      <div class="vtab-staged__bar">
        <span class="era-chip era-chip--warn">{{ wb.ops.length }} 项待提交</span>
        <span v-if="failedCount > 0" class="era-chip era-chip--danger">{{ failedCount }} 项无法应用到当前变量</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm era-btn--ghost" title="撤销最后一项" @click="undoLast">
          <EraIcon name="undo" :size="14" />撤销
        </button>
        <button class="era-btn era-btn--sm era-btn--ghost" @click="clearOps">清空</button>
        <button class="era-btn era-btn--sm era-btn--primary" :disabled="checking" @click="runPreview">
          <span v-if="checking" class="era-spinner"></span>
          <EraIcon v-else name="check" :size="14" />检查并提交
        </button>
      </div>

      <div v-if="preview" class="vtab-preview">
        <ol class="vtab-ops">
          <li v-for="(item, index) in previewItems" :key="index" class="vtab-op">
            <span class="era-chip" :class="opChip(item.op.op)">{{ opLabel(item.op.op) }}</span>
            <span class="vtab-op__path era-mono">{{ displayPath(item.op.path) }}</span>
            <span v-if="'value' in item.op" class="vtab-op__value era-mono">= {{ previewValue(item.op.value) }}</span>
            <button class="era-icon-btn era-icon-btn--sm" title="移除这一项" @click="removeOp(index)">
              <EraIcon name="close" :size="14" />
            </button>
            <p v-for="hint in item.hints" :key="hint.text" class="vtab-op__hint" :class="`is-${hint.level}`">
              {{ hint.text }}
            </p>
          </li>
        </ol>

        <div v-if="preview.error" class="era-status era-status--error">试算失败：{{ preview.error }}</div>
        <template v-else>
          <div v-if="blockingProblems.length > 0" class="era-status era-status--error">
            <div>
              <strong>试算发现 {{ blockingProblems.length }} 个问题</strong
              >，提交是原子的：有任何一项不能生效就全部放弃。
              <ul class="vtab-problems">
                <li v-for="(problem, index) in blockingProblems" :key="index">
                  <span class="era-mono">{{ problemPath(problem.path) }}</span>：{{ problem.reason }}
                </li>
              </ul>
            </div>
          </div>
          <div v-else class="era-status era-status--ok">试算通过，可以提交。</div>
          <p v-if="ignorableProblems.length > 0" class="era-hint">
            另有 {{ ignorableProblems.length }} 项“下划线只读”提示：只限制 AI 的指令，面板提交不受影响。
          </p>
        </template>

        <p class="era-hint">
          修改作为旁路写入挂在最后一条 AI 消息上，删除或重新生成该消息时会一同撤销；消息正文不会改变。
        </p>
        <div class="era-row vtab-commit">
          <span class="era-spacer"></span>
          <button class="era-btn" @click="preview = null">返回修改</button>
          <button
            class="era-btn era-btn--primary"
            :disabled="commitTask.state.busy || !!preview.error || blockingProblems.length > 0"
            @click="commit"
          >
            <span v-if="commitTask.state.busy" class="era-spinner"></span>
            <EraIcon v-else name="check" :size="16" />确认提交
          </button>
        </div>
      </div>
    </section>
    <div v-if="commitTask.state.kind" class="era-status" :class="`era-status--${commitTask.state.kind}`">
      {{ commitTask.state.text }}
    </div>
  </div>
</template>

<script setup lang="ts">
import toastr from 'toastr';
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { Era } from '../../../api/global';
import { settings } from '../../../utils/era_data';
import { errorText, useTask } from '../../actions';
import { previewCommit } from '../../floor_preview';
import { useUiStore } from '../../store';
import EraIcon from '../../template/EraIcon.vue';
import type { EditorState } from '../../template/var_tree';
import VarTree from '../../template/VarTree.vue';
import {
  applyLocal,
  diffToOps,
  displayPath,
  fromPointer,
  getAt,
  isUnderscoreOnlyProblem,
  kindOf,
  parseInput,
  preview as previewValue,
  protectionHints,
  WorkbenchOp,
} from '../../workbench';
import { workbench as wb } from './workbench_state';

const store = useUiStore();
const latest = computed(() => store.eventData);

// ===== 数据 =====
const base = shallowRef<{ stat: any; statWithoutMeta: any }>({ stat: {}, statWithoutMeta: {} });
const currentChatId = () => (SillyTavern as any).getCurrentChatId?.() as string | undefined;

function refresh() {
  try {
    base.value = Era.getCurrentVars();
  } catch (error) {
    toastr.error(errorText(error), '读取变量失败');
  }
  if (wb.ops.length > 0 && wb.chatId !== currentChatId()) {
    wb.ops = [];
    preview.value = null;
    toastr.info('聊天已切换，之前暂存的修改已清空。', 'ERA 变量');
  }
}
onMounted(refresh);
watch(() => store.eventData, refresh);

/** 应用暂存修改之后的草稿。 */
const drafted = computed(() => {
  const pure = base.value.statWithoutMeta;
  if (wb.ops.length === 0) return { data: pure, failed: [] as number[] };
  const copy = _.cloneDeep(pure);
  const failed: number[] = [];
  wb.ops.forEach((op, index) => {
    if (!applyLocal(copy, op)) failed.push(index);
  });
  return { data: copy, failed };
});
const failedCount = computed(() => drafted.value.failed.length);
const viewData = computed(() => (wb.view === 'full' ? base.value.stat : drafted.value.data));
const topCount = computed(() => {
  const data = viewData.value;
  return data && typeof data === 'object' ? Object.keys(data).filter(key => !key.startsWith('$')).length : null;
});
const changedPaths = computed(() => new Set(wb.ops.map(op => op.path)));

// ===== 搜索 =====
const query = ref('');
const debouncedQuery = ref('');
const applyQuery = _.debounce((value: string) => (debouncedQuery.value = value), 200);
watch(query, value => {
  if (value.trim()) {
    applyQuery(value);
  } else {
    // 清空时立即恢复完整的树
    applyQuery.cancel();
    debouncedQuery.value = '';
  }
});
const searchInfo = ref({ matches: 0, truncated: false });

// ===== 编辑器 =====
const editor = ref<EditorState | null>(null);
const readonlyUnderscore = computed(() => settings.value.下划线只读 === true);

function hintsFor(op: WorkbenchOp): string[] {
  return protectionHints(base.value.stat, op, readonlyUnderscore.value).map(hint => hint.text);
}

function startEdit(path: string, value: unknown) {
  const kind = kindOf(value);
  editor.value = reactive({
    mode: 'edit',
    path,
    parentIsArray: false,
    key: '',
    kind,
    text: kind === 'json' ? JSON.stringify(value, null, 2) : kind === 'null' ? '' : String(value),
    error: '',
    hints: hintsFor({ op: 'replace', path, value }),
  }) as EditorState;
}

function startAdd(path: string, isArray: boolean) {
  editor.value = reactive({
    mode: 'add',
    path,
    parentIsArray: isArray,
    key: '',
    kind: 'string',
    text: '',
    error: '',
    hints: hintsFor({ op: isArray ? 'insert' : 'replace', path: `${path}/-`, value: null }).filter(
      text => !text.includes('updatable'),
    ),
  }) as EditorState;
}

function stage(op: WorkbenchOp) {
  if (wb.ops.length === 0) wb.chatId = currentChatId();
  wb.ops.push(op);
  preview.value = null;
  commitTask.reset();
}

function submitEditor() {
  const state = editor.value;
  if (!state) return;
  let value: any;
  try {
    value = parseInput(state.text, state.kind);
  } catch (error) {
    state.error = errorText(error);
    return;
  }
  if (state.mode === 'edit') {
    if (_.isEqual(getAt(drafted.value.data, fromPointer(state.path)), value)) {
      editor.value = null;
      return;
    }
    stage({ op: 'replace', path: state.path, value });
  } else if (state.parentIsArray) {
    stage({ op: 'insert', path: `${state.path}/-`, value });
  } else {
    const key = state.key;
    if (!key) {
      state.error = '请填写键名';
      return;
    }
    if (key === '$meta' || key === '$template') {
      state.error = '面板不修改 $meta 与 $template，请用指令修改保护规则和模板';
      return;
    }
    const parent = getAt(drafted.value.data, fromPointer(state.path));
    if (parent && typeof parent === 'object' && key in parent) {
      state.error = '这个键已经存在，请直接修改它';
      return;
    }
    stage({ op: 'replace', path: `${state.path}${toSegment(key)}`, value });
  }
  editor.value = null;
}

const toSegment = (key: string) => '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');

function stageRemove(path: string) {
  editor.value = null;
  stage({ op: 'remove', path });
}

function undoLast() {
  wb.ops.pop();
  preview.value = null;
}
function clearOps() {
  wb.ops = [];
  preview.value = null;
}
function removeOp(index: number) {
  wb.ops.splice(index, 1);
  if (wb.ops.length === 0) preview.value = null;
  else runPreview();
}

// ===== 批量 =====
const bulkStatus = ref<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
function openBulk() {
  wb.view = 'bulk';
  editor.value = null;
  if (!wb.bulkText.trim()) fillCurrent();
}
function fillCurrent() {
  wb.bulkText = JSON.stringify(drafted.value.data ?? {}, null, 2);
  bulkStatus.value = null;
}
function computeDiff() {
  let parsed: any;
  try {
    parsed = JSON.parse(wb.bulkText);
  } catch (error) {
    bulkStatus.value = { kind: 'error', text: `JSON 格式错误：${errorText(error)}` };
    return;
  }
  try {
    const { ops, ignored } = diffToOps(base.value.statWithoutMeta, parsed);
    if (ops.length === 0) {
      bulkStatus.value = { kind: 'warn', text: '与当前变量相同，没有需要修改的内容。' };
      return;
    }
    wb.ops = ops;
    wb.chatId = currentChatId();
    preview.value = null;
    const note = ignored.length > 0 ? `，忽略了 ${ignored.length} 处 $meta / $template` : '';
    bulkStatus.value = { kind: 'ok', text: `已算出 ${ops.length} 项修改并暂存（替换了之前暂存的修改）${note}。` };
    runPreview();
  } catch (error) {
    bulkStatus.value = { kind: 'error', text: errorText(error) };
  }
}

// ===== 试算与提交 =====
const preview = ref<{ problems: { path: string; reason: string }[]; error?: string } | null>(null);
const checking = ref(false);
const previewItems = computed(() =>
  wb.ops.map(op => ({ op, hints: protectionHints(base.value.stat, op, readonlyUnderscore.value) })),
);
const blockingProblems = computed(
  () =>
    preview.value?.problems.filter(problem => !(readonlyUnderscore.value && isUnderscoreOnlyProblem(problem))) ?? [],
);
const ignorableProblems = computed(
  () => preview.value?.problems.filter(problem => readonlyUnderscore.value && isUnderscoreOnlyProblem(problem)) ?? [],
);

async function runPreview() {
  if (wb.ops.length === 0) return;
  checking.value = true;
  commitTask.reset();
  try {
    // 与原子提交用同一个试算器：从上一楼开始重算最新 AI 楼，再加上这次的修改；Era.simulate 会把修改当成新的一楼
    const { result } = await previewCommit([{ patch: _.cloneDeep(wb.ops) }]);
    preview.value = { problems: result.problems.map(({ path, reason }) => ({ path, reason })) };
  } catch (error) {
    preview.value = { problems: [], error: errorText(error) };
  } finally {
    checking.value = false;
  }
}

const commitTask = useTask();
async function commit() {
  if (wb.chatId !== currentChatId()) {
    clearOps();
    commitTask.state.kind = 'error';
    commitTask.state.text = '聊天已切换，暂存的修改已清空，请重新编辑。';
    return;
  }
  const ops = _.cloneDeep(wb.ops);
  const ok = await commitTask.run(async () => {
    const result = await store.track(() => Era.commit([{ patch: ops }], { atomic: true }));
    return `已提交 ${ops.length} 项修改（写入 MK …${String(result?.mk ?? '').slice(-6)}）。`;
  }, '正在提交…');
  if (ok) {
    wb.ops = [];
    preview.value = null;
    refresh();
  } else {
    store.addProblem({ source: '面板', title: '变量修改提交失败', detail: commitTask.state.text });
  }
}

const problemPath = (path: string) => (path.startsWith('/') ? displayPath(path) : path || '（根）');
const opLabel = (op: string) => ({ replace: '修改', insert: '追加', remove: '删除' })[op] ?? op;
const opChip = (op: string) =>
  ({ replace: 'era-chip--accent', insert: 'era-chip--ok', remove: 'era-chip--danger' })[op] ?? '';
</script>

<style>
.era-root .vtab {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 100%;
}
.era-root .vtab-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.era-root .vtab-search {
  position: relative;
  display: flex;
  flex: 1 1 200px;
  align-items: center;
  min-width: 0;
}
.era-root .vtab-search > .era-icon {
  position: absolute;
  left: 10px;
  color: var(--era-faint);
  pointer-events: none;
}
.era-root .vtab-search .era-input {
  padding-left: 34px;
  padding-right: 32px;
}
.era-root .vtab-search .era-icon-btn {
  position: absolute;
  right: 4px;
}
.era-root .vtab-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  min-height: 26px;
  color: var(--era-muted);
  font-size: 12px;
}
.era-root .vtab-tree {
  padding: 6px;
  border: 1px solid var(--era-line);
  border-radius: var(--era-radius);
  background: var(--era-surface);
}
.era-root .vtab-note {
  margin: 8px 6px 2px;
}
.era-root .vtab .vtab-bulk {
  min-height: 240px;
  margin-top: 10px;
}
.era-root .vtab-bulk-actions {
  margin-top: 10px;
}
.era-root .vtab-staged {
  position: sticky;
  bottom: -16px;
  z-index: 1;
  margin: 0 -4px;
  padding: 10px;
  border: 1px solid var(--era-accent-line);
  border-radius: var(--era-radius);
  /* 面板底色通常半透明；叠三层并模糊，避免下面的内容透出来 */
  background:
    linear-gradient(var(--era-panel), var(--era-panel)), linear-gradient(var(--era-panel), var(--era-panel)),
    var(--era-panel);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 -6px 18px color-mix(in srgb, var(--era-shadow-color) 50%, transparent);
}
.era-root .vtab-staged__bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.era-root .vtab-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 50vh;
  margin-top: 10px;
  overflow: auto;
}
.era-root .vtab-ops {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
}
.era-root .vtab-op {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--era-surface);
  font-size: 12px;
}
.era-root .vtab-op__path {
  font-weight: 600;
  word-break: break-all;
}
.era-root .vtab-op__value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--era-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.era-root .vtab-op > .era-icon-btn {
  margin-left: auto;
}
.era-root .vtab-op__hint {
  flex-basis: 100%;
  font-size: 12px;
}
.era-root .vtab-op__hint.is-block {
  color: var(--era-danger);
}
.era-root .vtab-op__hint.is-info {
  color: var(--era-muted);
}
.era-root .vtab-problems {
  margin: 4px 0 0 18px;
  padding: 0;
}
.era-root .vtab-commit {
  margin-top: 2px;
}
</style>
