<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
  日期：2026-11-26
  目的：面板“诊断”页：变量结构诊断与一键修复（写入前核对、写入后可撤销），聊天数据体积诊断
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
-->
<template>
  <div class="dtab">
    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">结构诊断</span>
        <span class="era-card__sub">检查变量是否符合角色卡注册的变量结构</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm" :disabled="diagTask.state.busy || !hasSchema" @click="diagnose()">
          <span v-if="diagTask.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="search" :size="14" />{{ fix ? '重新诊断' : '诊断' }}
        </button>
      </div>
      <p v-if="!hasSchema" class="era-hint">当前角色卡没有注册变量结构（Era.registerSchema），不需要诊断。</p>
      <p v-else-if="!fix" class="era-hint">
        变量不符合结构时，ERA 不会拦截之后的修改（无法判断是哪条修改造成的），只在“最近的问题”里提示。
        常见原因是角色卡升级后新增了必填字段，而旧存档里没有。诊断只读取变量；确认修复后才会写入最新一条 AI 消息。
      </p>
      <TaskStatus :task="diagTask.state" />

      <template v-if="fix">
        <div v-if="fix.diagnosis.error" class="era-status era-status--error">
          变量结构执行出错：{{ fix.diagnosis.error }}
        </div>
        <div v-else-if="fix.diagnosis.valid && !fix.plan" class="era-status era-status--ok">
          第 {{ fix.message_id }} 楼处理完之后的变量符合结构，不需要修复。
        </div>
        <template v-else>
          <p class="era-hint">
            第 {{ fix.message_id }} 楼（最新的 AI 消息）处理完之后，有 {{ fix.diagnosis.issues.length }} 处不符合结构：
          </p>
          <div v-for="group in issueGroups" :key="group.kind" class="dtab-group">
            <div class="dtab-group__title">
              <span class="era-chip" :class="group.kind === 'missing' ? 'era-chip--accent' : 'era-chip--danger'">
                {{ group.label }}
              </span>
              <span class="era-hint">{{ group.hint }}</span>
            </div>
            <ul class="dtab-list">
              <li v-for="(issue, index) in group.items" :key="index">
                <span class="era-mono">{{ issue.path || '（根）' }}</span>：{{ issue.message }}
              </li>
            </ul>
          </div>

          <template v-if="fix.plan">
            <div class="dtab-group__title"><strong>修复方案</strong></div>
            <p v-if="fix.plan.steps.length === 0" class="era-hint">没有能自动推导的修复。</p>
            <ol v-else class="dtab-list">
              <li v-for="(step, index) in fix.plan.steps" :key="index">
                <span class="era-chip" :class="stepChip(step.action)">{{ stepLabel(step.action) }}</span>
                <span class="era-mono">{{ step.path }}</span>
                <span v-if="'before' in step" class="era-mono dtab-value">{{ previewValue(step.before) }}</span>
                <span v-if="'after' in step" class="era-mono dtab-value">→ {{ previewValue(step.after) }}</span>
              </li>
            </ol>

            <div v-if="fix.plan.remaining.length > 0" class="dtab-manual">
              <p class="era-hint">
                以下字段是必填的、又没有默认值，无法自动推导，请手动填写（JSON 格式，例如
                <code>0</code>、<code>"文字"</code>、<code>{}</code>），然后重新诊断：
              </p>
              <label v-for="issue in fix.plan.remaining" :key="issue.path" class="dtab-manual__row">
                <span class="era-mono">{{ issue.path || '（根）' }}</span>
                <input
                  v-model="manualText[keyOf(issue.segments)]"
                  class="era-input"
                  :placeholder="issue.message"
                  :disabled="issue.segments.length === 0"
                />
              </label>
              <div class="era-row">
                <span class="era-spacer"></span>
                <button class="era-btn era-btn--sm" :disabled="diagTask.state.busy" @click="diagnose(true)">
                  带上手填的值重新诊断
                </button>
              </div>
            </div>
          </template>

          <div v-if="fix.problems.length > 0" class="era-status era-status--error">
            <div>
              试算发现 {{ fix.problems.length }} 个问题，提交会被放弃：
              <ul class="dtab-list">
                <li v-for="(problem, index) in fix.problems" :key="index">
                  <span class="era-mono">{{ problem.path || '（根）' }}</span>：{{ problem.reason }}
                </li>
              </ul>
            </div>
          </div>
          <div v-else-if="fix.after && !fix.after.valid" class="era-status era-status--warn">
            试算后仍有 {{ fix.after.issues.length }} 处不符合结构（可能是钩子又改回去了），暂不能写入。
          </div>
          <div v-else-if="fix.ready" class="era-status era-status--ok">
            试算通过：写入后变量符合结构。修改作为旁路写入挂在第 {{ fix.message_id }} 楼，消息正文不会改变。
          </div>

          <div class="era-row">
            <span class="era-spacer"></span>
            <button
              class="era-btn era-btn--primary"
              :class="armed === 'apply' ? 'era-btn--armed' : ''"
              :disabled="!fix.ready || applyTask.state.busy"
              @click="apply"
            >
              <span v-if="applyTask.state.busy" class="era-spinner"></span>
              <EraIcon v-else name="check" :size="14" />{{ armed === 'apply' ? '再点一次确认' : '写入修复' }}
            </button>
          </div>
        </template>
      </template>
      <TaskStatus :task="applyTask.state" />
      <div v-if="undo" class="era-row">
        <span class="era-hint">已写入第 {{ undo.message_id }} 楼。</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm" :disabled="undoTask.state.busy" @click="revert">
          <span v-if="undoTask.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="undo" :size="14" />撤销本次修复
        </button>
      </div>
      <TaskStatus :task="undoTask.state" />
    </section>

    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">聊天数据体积</span>
        <span class="era-card__sub">长聊天变卡时，用它看看是哪部分在变大</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm" @click="measure"><EraIcon name="refresh" :size="14" />统计</button>
      </div>
      <p v-if="!size" class="era-hint">只读取、不修改任何数据。</p>
      <dl v-else class="dtab-kv">
        <div>
          <dt>消息</dt>
          <dd>{{ size.messages }} 条</dd>
        </div>
        <div>
          <dt>变量 stat_data</dt>
          <dd>{{ formatBytes(size.stat) }}</dd>
        </div>
        <div>
          <dt>逐楼日志 EditLogs</dt>
          <dd>
            {{ formatBytes(size.editLogs) }}（{{ size.logFloors }} 楼）<span v-if="size.archived"
              >，更早的已存档到文件</span
            >
          </dd>
        </div>
        <div>
          <dt>旁路写入 ApiOps</dt>
          <dd>{{ formatBytes(size.apiOps) }}（{{ size.apiOpCount }} 条）</dd>
        </div>
        <div>
          <dt>其他元数据</dt>
          <dd>{{ formatBytes(size.otherMeta) }}</dd>
        </div>
        <div>
          <dt>正文</dt>
          <dd>{{ formatBytes(size.text) }}（含未显示的回复 {{ formatBytes(size.allSwipes) }}）</dd>
        </div>
        <div>
          <dt>挂载的 iframe</dt>
          <dd>{{ size.iframes === null ? '无法统计' : `${size.iframes} 个` }}（状态栏、前端界面）</dd>
        </div>
      </dl>
      <p v-if="size" class="era-hint">
        EditLogs 很大时可以开启“日志保留楼层数”和“折叠日志存档”；iframe
        很多时可以在酒馆助手里调小“渲染深度”，只渲染最近几楼的状态栏。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import { Era } from '../../../api/global';
import { CHAT_SCOPE } from '../../../utils/constants';
import { errorText, useConfirm, useTask } from '../../actions';
import { hostWindow } from '../../host';
import { applySchemaFix, prepareSchemaFix, SchemaFixPreview, SchemaFixUndo, undoSchemaFix } from '../../schema_fix';
import { ChatSizeReport, countChatIframes, formatBytes, measureChatSize } from '../../size_diag';
import { useUiStore } from '../../store';
import { preview } from '../../workbench';
import EraIcon from '../../template/EraIcon.vue';
import TaskStatus from '../../template/TaskStatus.vue';

const store = useUiStore();
const { armed, confirm } = useConfirm();
const diagTask = useTask();
const applyTask = useTask();
const undoTask = useTask();

// 注册 schema 不是响应式的：打开页面时读一次，之后每次收到写入时再读
const hasSchema = ref(Era.hasSchema());
watch(
  () => store.eventData,
  () => (hasSchema.value = Era.hasSchema()),
);

const fix = shallowRef<SchemaFixPreview | null>(null);
const undo = shallowRef<SchemaFixUndo | null>(null);
const manualText = reactive<Record<string, string>>({});
const keyOf = (segments: (string | number)[]) => JSON.stringify(segments);

const issueGroups = computed(() => {
  const issues = fix.value?.diagnosis.issues ?? [];
  return [
    {
      kind: 'missing',
      label: '缺必填字段',
      hint: '多半是角色卡升级后新增了字段，旧存档里没有',
      items: issues.filter(issue => issue.kind === 'missing'),
    },
    {
      kind: 'invalid',
      label: '类型不符',
      hint: '值的类型或取值不符合结构',
      items: issues.filter(issue => issue.kind === 'invalid'),
    },
  ].filter(group => group.items.length > 0);
});

const stepLabel = (action: string) =>
  ({ coerce: '转换', delete: '删除', fill: '补空值', manual: '手填' })[action] ?? action;
const stepChip = (action: string) =>
  ({ coerce: 'era-chip--accent', delete: 'era-chip--danger', fill: 'era-chip--ok', manual: 'era-chip--ok' })[action] ??
  '';
const previewValue = (value: any) => preview(value, 60);

function manualValues(): Record<string, any> {
  const values: Record<string, any> = {};
  for (const [key, text] of Object.entries(manualText)) {
    if (!text?.trim()) continue;
    try {
      values[key] = JSON.parse(text);
    } catch {
      throw new Error(`手填的值不是有效的 JSON：${text}`);
    }
  }
  return values;
}

async function diagnose(withManual = false) {
  undoTask.reset();
  applyTask.reset();
  if (!withManual) for (const key of Object.keys(manualText)) delete manualText[key];
  await diagTask.run(async () => {
    fix.value = await store.track(() => prepareSchemaFix(withManual ? manualValues() : {}));
    if (fix.value.diagnosis.valid && !fix.value.plan) return '变量符合结构。';
    if (fix.value.ready) return `找到了修复方案，共 ${fix.value.ops.length} 项修改。`;
    return { warn: '没有找到能让变量完全符合结构的修复方案，见下方说明。' };
  }, '正在试算…');
}

async function apply() {
  const current = fix.value;
  if (!current || !confirm('apply')) return;
  const ok = await applyTask.run(async () => {
    undo.value = await store.track(() => applySchemaFix(current));
    fix.value = null;
    return undo.value.rev < 0 ? { warn: '已写入，但之后马上有新的写入，无法撤销。' } : '已写入修复。';
  }, '正在写入…');
  if (!ok) store.addProblem({ source: '面板', title: '变量结构修复写入失败', detail: applyTask.state.text });
}

async function revert() {
  const current = undo.value;
  if (!current) return;
  const ok = await undoTask.run(async () => {
    await store.track(() => undoSchemaFix(current));
    undo.value = null;
    return '已撤销本次修复。';
  }, '正在撤销…');
  if (!ok) store.addProblem({ source: '面板', title: '撤销变量结构修复失败', detail: undoTask.state.text });
}

const size = ref<ChatSizeReport | null>(null);
function measure() {
  try {
    const messages = getChatMessages('0-{{lastMessageId}}', { include_swipes: true }) ?? [];
    size.value = measureChatSize(getVariables(CHAT_SCOPE), messages, countChatIframes(hostWindow().document));
  } catch (error) {
    store.addProblem({ source: '面板', title: '统计聊天数据体积失败', detail: errorText(error) });
  }
}
</script>

<style>
.era-root .dtab {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.era-root .dtab-group {
  margin: 6px 0;
}
.era-root .dtab-group__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 2px;
}
.era-root .dtab-list {
  margin: 4px 0;
  padding-left: 20px;
  line-height: 1.7;
}
.era-root .dtab-value {
  margin-left: 6px;
  opacity: 0.85;
}
.era-root .dtab-manual {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 0;
}
.era-root .dtab-manual__row {
  display: grid;
  grid-template-columns: minmax(80px, 30%) 1fr;
  align-items: center;
  gap: 8px;
}
.era-root .dtab-kv {
  display: grid;
  gap: 4px;
  margin: 6px 0;
}
.era-root .dtab-kv > div {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 8px;
}
.era-root .dtab-kv dt {
  opacity: 0.75;
}
.era-root .dtab-kv dd {
  margin: 0;
}
</style>
