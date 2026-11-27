<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增（取代 RightRailContent/ExtraModelPanel.vue）。
  日期：2026-11-26
  目的：重新设计面板：分步更新页（进行中的解析、最近一次的结果、实际提示词与原始回复、重新解析与取消、设置）；显示告警与等待同步的楼层，新增“EJS 预处理”，复制设置时去掉密钥
        2026-11-27 正文前规划：开关与“重新规划最新玩家消息”按钮
        2026-11-27 预设、头部提示词、附带角色信息、请求方式；存为本卡推荐与清除本卡推荐；请求记录
        2026-11-27 请求记录与角色卡推荐在规划完成、切换聊天、写入或清除推荐后刷新；记录用稳定的 key；确认写入时列出写入的项；预设条目位置的说明与实现一致
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="xtab">
    <!-- 运行状态（Era.extra.status 可用时） -->
    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">运行状态</span>
        <span class="era-chip" :class="effectiveEnabled ? 'era-chip--ok' : ''">
          {{ effectiveEnabled ? '额外模型解析已启用' : '未启用（随 AI 输出）' }}
        </span>
        <span class="era-spacer"></span>
        <button v-if="hasStatus" class="era-icon-btn" title="刷新" @click="pollStatus">
          <EraIcon name="refresh" />
        </button>
      </div>

      <template v-if="hasStatus && status">
        <div v-if="status.running.length > 0" class="xtab-running">
          <div v-for="job in status.running" :key="job.mk" class="xtab-job">
            <span class="era-spinner"></span>
            <span
              >正在解析 <span class="era-mono">{{ shortMk(job.mk) }}</span></span
            >
            <span class="era-chip">第 {{ Math.max(1, job.attempt) }} 次请求</span>
            <span class="era-hint">已用 {{ elapsed(job.startedAt) }} 秒</span>
            <span class="era-spacer"></span>
            <button class="era-btn era-btn--sm era-btn--danger" @click="abort(job.mk)">取消</button>
          </div>
        </div>
        <p v-else class="era-hint">当前没有正在进行的解析。</p>
        <p v-if="status.pendingSync?.length" class="era-hint">
          已写入、等待同步算完：<span class="era-mono">{{ status.pendingSync.map(shortMk).join('、') }}</span>
        </p>

        <div v-if="status.last" class="xtab-last">
          <div class="xtab-last__head">
            <span class="era-card__sub">最近一次</span>
            <span class="era-chip" :class="status.last.ok ? 'era-chip--ok' : 'era-chip--danger'">
              {{ status.last.status ? statusLabel(status.last.status) : status.last.ok ? '成功' : '失败' }}
            </span>
            <span class="era-mono era-hint" :title="status.last.mk">{{ shortMk(status.last.mk) }}</span>
            <span class="era-spacer"></span>
            <span class="era-hint">{{ formatTime(status.last.finishedAt) }}</span>
          </div>
          <div v-if="status.last.error" class="era-status era-status--error">{{ status.last.error }}</div>
          <ul v-if="status.last.problems?.length" class="xtab-problems">
            <li v-for="(problem, index) in status.last.problems" :key="index">{{ problem }}</li>
          </ul>
          <details v-if="status.last.warnings?.length" class="xtab-details">
            <summary>告警（{{ status.last.warnings.length }}，不影响结果）</summary>
            <ul class="xtab-problems xtab-warnings">
              <li v-for="(warning, index) in status.last.warnings" :key="index">{{ warning }}</li>
            </ul>
          </details>
          <details v-if="promptText" class="xtab-details">
            <summary>
              实际发送的提示词
              <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="copy(promptText)">
                <EraIcon name="copy" :size="14" />复制
              </button>
            </summary>
            <pre class="era-code">{{ promptText }}</pre>
          </details>
          <details v-if="status.last.rawReply" class="xtab-details">
            <summary>
              模型的原始回复
              <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="copy(status.last.rawReply)">
                <EraIcon name="copy" :size="14" />复制
              </button>
            </summary>
            <pre class="era-code">{{ status.last.rawReply }}</pre>
          </details>
        </div>
        <details v-if="status.history?.length" class="xtab-details xtab-history" @toggle="onHistoryToggle">
          <summary>请求记录（最近 {{ status.history.length }} 次，切换聊天时清空）</summary>
          <details
            v-for="item in status.history"
            :key="`${item.finishedAt}-${item.type}-${item.mk}`"
            class="xtab-details xtab-history__item"
          >
            <summary>
              <span class="era-chip">{{ item.type === 'plan' ? '规划' : '分步更新' }}</span>
              <span class="era-chip" :class="item.ok ? 'era-chip--ok' : 'era-chip--danger'">{{
                statusLabel(item.status)
              }}</span>
              <span v-if="item.mk" class="era-mono era-hint" :title="item.mk">{{ shortMk(item.mk) }}</span>
              <span class="era-spacer"></span>
              <span class="era-hint">{{ formatTime(item.finishedAt) }}</span>
            </summary>
            <div v-if="item.error" class="era-status era-status--error">{{ item.error }}</div>
            <ul v-if="item.warnings?.length" class="xtab-problems xtab-warnings">
              <li v-for="(warning, i) in item.warnings" :key="i">{{ warning }}</li>
            </ul>
            <details v-if="formatPrompt(item.prompt)" class="xtab-details">
              <summary>
                提示词
                <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="copy(formatPrompt(item.prompt))">
                  <EraIcon name="copy" :size="14" />复制
                </button>
              </summary>
              <pre class="era-code">{{ formatPrompt(item.prompt) }}</pre>
            </details>
            <details v-if="item.rawReply" class="xtab-details">
              <summary>
                原始回复
                <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="copy(item.rawReply)">
                  <EraIcon name="copy" :size="14" />复制
                </button>
              </summary>
              <pre class="era-code">{{ item.rawReply }}</pre>
            </details>
          </details>
        </details>
      </template>
      <p v-else-if="!hasStatus" class="era-hint">当前版本不提供运行诊断。</p>

      <div class="xtab-actions">
        <button class="era-btn era-btn--primary" :disabled="runTask.state.busy" @click="rerun">
          <span v-if="runTask.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="play" :size="16" />重新解析最后一条 AI 消息
        </button>
        <span class="era-hint">按下面的设置请求一次模型，替换上一次额外模型的输出；消息里原有的指令不变。</span>
      </div>
      <TaskStatus :task="runTask.state" />
      <div v-if="hasPlan" class="xtab-actions">
        <button class="era-btn" :disabled="planTask.state.busy" @click="replan">
          <span v-if="planTask.state.busy" class="era-spinner"></span>
          <EraIcon v-else name="play" :size="16" />重新规划最新的玩家消息
        </button>
        <span class="era-hint"
          >按 [era_plan] 条目重新结算最新一条玩家消息，替换其中的规划；后面已有回复时需要重新生成。</span
        >
      </div>
      <TaskStatus v-if="hasPlan" :task="planTask.state" />
    </section>

    <!-- 设置 -->
    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">设置</span>
        <span v-if="dirty" class="era-chip era-chip--warn">未保存</span>
        <span class="era-spacer"></span>
        <button
          class="era-btn era-btn--sm era-btn--ghost"
          title="复制当前保存的设置，密钥会被隐藏"
          @click="copySettings"
        >
          <EraIcon name="copy" :size="14" />复制设置
        </button>
        <button class="era-btn era-btn--sm" :disabled="!dirty" @click="load">丢弃修改</button>
        <button class="era-btn era-btn--sm era-btn--primary" :disabled="saveTask.state.busy || !dirty" @click="save">
          保存
        </button>
      </div>
      <TaskStatus :task="saveTask.state" />

      <div class="xform">
        <label class="xform-row">
          <span>变量更新方式</span>
          <select v-model="draft.变量更新方式" class="era-select">
            <option v-for="mode in modeOptions" :key="mode" :value="mode">{{ MODE_LABELS[mode] ?? mode }}</option>
          </select>
        </label>
        <p v-if="cardPreference" class="era-hint xform-note">当前角色卡推荐：{{ cardPreference }}</p>
        <div v-if="hasCardWrite" class="xtab-add">
          <button
            class="era-btn era-btn--sm"
            :class="{ 'era-btn--armed': armed === 'saveCard' }"
            :disabled="cardTask.state.busy"
            title="把下面可以由角色卡推荐的设置写进这张角色卡（角色卡变量 ERA分步更新），随卡导出"
            @click="saveCard"
          >
            {{ armed === 'saveCard' ? '再点一次确认写入' : '存为本卡推荐' }}
          </button>
          <button
            v-if="cardPreference"
            class="era-btn era-btn--sm era-btn--ghost"
            :class="{ 'era-btn--armed': armed === 'clearCard' }"
            :disabled="cardTask.state.busy"
            @click="clearCard"
          >
            {{ armed === 'clearCard' ? '再点一次确认清除' : '清除本卡推荐' }}
          </button>
          <span v-if="armed === 'saveCard'" class="era-hint"
            >将写入这张卡：{{ cardSaveKeys || '（没有可推荐的项）' }}；覆盖这张卡原有的推荐。</span
          >
          <span v-else class="era-hint"
            >只写入可以推荐的项（不含接口、密钥、头部提示词、请求方式、分组预设与具体的预设名），覆盖这张卡原有的推荐；变量更新方式选“跟随角色卡”时保留卡里原有的变量更新方式推荐。</span
          >
        </div>
        <TaskStatus v-if="hasCardWrite" :task="cardTask.state" />
        <p class="era-hint xform-note">
          额外模型解析时，名字含 [era_update] 的世界书条目（以及“ERA 变量操作规则”“ERA
          变量意图说明”）只发给更新模型，剧情模型不再写指令。[era_update:组名] 可以分组并行请求。
        </p>

        <label class="xform-row">
          <span>等待方式</span>
          <select v-model="draft.等待方式" class="era-select">
            <option value="发送前等待">后台更新，发送下一条前等它完成</option>
            <option value="后台更新">后台更新，不等待</option>
          </select>
        </label>
        <label class="xform-row">
          <span>输出有问题时</span>
          <select v-model="draft.失败处理" class="era-select">
            <option value="保留有效部分">保留有效的指令</option>
            <option value="整次放弃">整次放弃，变量不变</option>
          </select>
        </label>
        <label v-if="hasPlanOption" class="xform-row">
          <span>正文前规划</span>
          <select v-model="(draft as any).正文前规划" class="era-select">
            <option value="关闭">关闭</option>
            <option value="开启">开启（发送前按 [era_plan] 条目先结算检定、骰点）</option>
          </select>
        </label>
        <label v-if="hasEjsOption" class="xform-row">
          <span>EJS 预处理</span>
          <select v-model="(draft as any).EJS预处理" class="era-select">
            <option value="自动">自动（装有提示词模板插件时按该楼的状态渲染）</option>
            <option value="关闭">关闭（发原文）</option>
          </select>
        </label>
        <label v-for="item in NUMBERS" :key="item.key" class="xform-row">
          <span>{{ item.label }}</span>
          <input
            v-model="numberText[item.key]"
            type="number"
            class="era-input"
            :class="{ 'era-input--invalid': numberErrors[item.key] }"
            :min="item.min"
          />
          <span v-if="numberErrors[item.key]" class="xform-error">{{ numberErrors[item.key] }}</span>
        </label>
        <label class="xform-row xform-row--column">
          <span>附加要求</span>
          <textarea
            v-model="draft.附加要求"
            class="era-textarea"
            rows="2"
            placeholder="附在提示词最后，可以留空"
          ></textarea>
        </label>
        <template v-if="hasPresetOptions">
          <label class="xform-row">
            <span>附带角色信息</span>
            <select v-model="(draft as any).附带角色信息" class="era-select">
              <option value="关闭">关闭</option>
              <option value="开启">开启（附上角色描述与用户人设）</option>
            </select>
          </label>
          <label class="xform-row">
            <span>请求方式</span>
            <select v-model="(draft as any).请求方式" class="era-select">
              <option value="非流式">非流式</option>
              <option value="流式">流式（有的接口只支持流式时选这个）</option>
            </select>
          </label>
          <label class="xform-row xform-row--column">
            <span>头部提示词</span>
            <textarea
              v-model="(draft as any).头部提示词"
              class="era-textarea"
              rows="2"
              placeholder="放在提示词最前面的一条系统提示词（如破限），可以留空；只存在本机，角色卡不能推荐"
            ></textarea>
          </label>
        </template>
      </div>

      <template v-if="hasPresetOptions">
        <h4 class="xtab-sub">预设</h4>
        <div class="xform">
          <p class="era-hint xform-note">
            使用预设时，预设里启用的提示词条目中，排在“聊天记录”之前的放在 ERA 的提示词前面，之后的放在后面；
            按聊天深度插入的条目不按深度插入，也按它在列表里相对“聊天记录”的位置前后放置。采样参数（温度、top_p
            等）也按预设；上面填了温度、最大回复时以上面为准。读不到预设时这次不使用预设，并记在告警里。
          </p>
          <div v-for="stage in presetStages" :key="stage.key" class="xform-row">
            <span>{{ stage.label }}</span>
            <div class="xtab-preset">
              <select v-model="(draft as any)[stage.key]" class="era-select">
                <option v-for="mode in PRESET_MODES" :key="mode" :value="mode">{{ mode }}</option>
              </select>
              <select
                v-if="(draft as any)[stage.key] === '使用指定预设'"
                v-model="(draft as any)[stage.nameKey]"
                class="era-select"
              >
                <option value="">（选择预设）</option>
                <option v-for="name in presetNamesFor((draft as any)[stage.nameKey])" :key="name" :value="name">
                  {{ name }}
                </option>
              </select>
            </div>
          </div>
          <div v-for="(choice, name) in (draft as any).分组预设" :key="`p-${name}`" class="xform-row">
            <span>分组“{{ name }}”</span>
            <div class="xtab-preset">
              <select v-model="choice.预设" class="era-select">
                <option v-for="mode in PRESET_MODES" :key="mode" :value="mode">{{ mode }}</option>
              </select>
              <select v-if="choice.预设 === '使用指定预设'" v-model="choice.预设名" class="era-select">
                <option value="">（选择预设）</option>
                <option v-for="preset in presetNamesFor(choice.预设名)" :key="preset" :value="preset">
                  {{ preset }}
                </option>
              </select>
              <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="removeGroupPreset(String(name))">
                删除
              </button>
            </div>
          </div>
          <div class="xtab-add">
            <input
              v-model="presetGroupName"
              class="era-input"
              placeholder="分组名；没有单独指定的分组按更新模型的设置"
            />
            <button class="era-btn" :disabled="!presetGroupName.trim()" @click="addGroupPreset">
              <EraIcon name="plus" :size="14" />为分组指定预设
            </button>
          </div>
        </div>
      </template>

      <h4 class="xtab-sub">接口</h4>
      <div class="xform">
        <ExtraApiForm v-model="draft.默认接口" title="默认接口" />
        <ExtraApiForm
          v-for="(_api, name) in draft.分组接口"
          :key="`g-${name}`"
          v-model="draft.分组接口[name]"
          :title="`分组“${name}”的接口`"
        >
          <template #actions>
            <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="removeGroup(String(name))">删除</button>
          </template>
        </ExtraApiForm>
        <div class="xtab-add">
          <input v-model="groupName" class="era-input" placeholder="分组名，与条目中的 [era_update:组名] 一致" />
          <button class="era-btn" :disabled="!groupName.trim()" @click="addGroup">
            <EraIcon name="plus" :size="14" />为分组指定接口
          </button>
        </div>

        <template v-if="hasFallback">
          <ExtraApiForm
            v-for="(_api, index) in (draft as any).备用接口"
            :key="`f-${index}`"
            v-model="(draft as any).备用接口[index]"
            :title="`备用接口 ${index + 1}`"
          >
            <template #actions>
              <button class="era-btn era-btn--sm era-btn--ghost" @click.prevent="removeFallback(index)">删除</button>
            </template>
          </ExtraApiForm>
          <div class="xtab-add">
            <span class="era-hint">主接口请求失败时依次换用备用接口。</span>
            <span class="era-spacer"></span>
            <button class="era-btn" @click="addFallback"><EraIcon name="plus" :size="14" />添加备用接口</button>
          </div>
        </template>
      </div>
      <p class="era-hint xtab-foot">
        设置保存在本机酒馆的全局变量里，不会随角色卡导出，但其他角色卡的脚本和前端界面都能读到。推荐“跟随酒馆”或“酒馆的代理预设”，ERA
        不保存密钥；使用来路不明的角色卡时不要在这里填密钥。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import toastr from 'toastr';
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { Era } from '../../../api/global';
import * as extraConfigModule from '../../../extra/config';
import {
  createExtraApi,
  ExtraConfig,
  ExtraConfigSchema,
  loadExtraConfig,
  saveExtraConfig,
} from '../../../extra/config';
import { copyText, errorText, formatTime, optionalExport, shortMk, useConfirm, useTask } from '../../actions';
import { useUiStore } from '../../store';
import EraIcon from '../../template/EraIcon.vue';
import TaskStatus from '../../template/TaskStatus.vue';
import ExtraApiForm from './ExtraApiForm.vue';

const store = useUiStore();

const NUMBERS = [
  { key: '聊天楼层数', label: '发送最近几楼', min: 1, integer: true },
  { key: '重试次数', label: '出错时重试次数', min: 0, max: 10, integer: true },
  { key: '超时秒数', label: '超时（秒）', min: 5 },
  { key: '最大回复', label: '最大回复 token（0 为不限）', min: 0, integer: true },
  { key: '温度', label: '温度（-1 为不设置）', min: -1 },
] as const;
type NumberKey = (typeof NUMBERS)[number]['key'];

const MODE_LABELS: Record<string, string> = {
  随AI输出: '随 AI 输出（剧情模型自己写指令）',
  额外模型解析: '额外模型解析（剧情写完后另请求一次）',
  跟随角色卡: '跟随角色卡（卡片没有声明时等同于随 AI 输出）',
};

/** 运行环境支持的更新方式（新版本增加了“跟随角色卡”）。 */
const modeOptions = computed<string[]>(() => {
  const field = (ExtraConfigSchema as any)?.shape?.变量更新方式;
  const options = field?._def?.innerType?.options ?? field?.options;
  return Array.isArray(options) ? options : ['随AI输出', '额外模型解析'];
});

// ===== 设置 =====
const draft = ref<ExtraConfig>(loadExtraConfig());
const saved = shallowRef<string>(JSON.stringify(draft.value));
const numberText = reactive<Record<NumberKey, string>>({} as any);
const groupName = ref('');
const saveTask = useTask();

function syncNumberText() {
  for (const item of NUMBERS) numberText[item.key] = String((draft.value as any)[item.key] ?? '');
}
syncNumberText();

function load() {
  draft.value = loadExtraConfig();
  saved.value = JSON.stringify(draft.value);
  syncNumberText();
  saveTask.reset();
}

const numberErrors = computed(() => {
  const errors: Partial<Record<NumberKey, string>> = {};
  for (const item of NUMBERS) {
    const text = String(numberText[item.key] ?? '').trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) errors[item.key] = '请填写数字';
    else if ('integer' in item && item.integer && !Number.isInteger(value)) errors[item.key] = '请填写整数';
    else if (value < item.min) errors[item.key] = `不能小于 ${item.min}`;
    else if ('max' in item && value > item.max) errors[item.key] = `不能大于 ${item.max}`;
  }
  return errors;
});

const candidate = computed(() => {
  const next: any = _.cloneDeep(draft.value);
  for (const item of NUMBERS) {
    if (!numberErrors.value[item.key]) next[item.key] = Number(numberText[item.key]);
  }
  return next as ExtraConfig;
});
const dirty = computed(() => JSON.stringify(candidate.value) !== saved.value);

async function save() {
  if (Object.keys(numberErrors.value).length > 0) {
    saveTask.state.kind = 'error';
    saveTask.state.text = '有数字没有填写正确，请按提示修改后再保存。';
    return;
  }
  await saveTask.run(async () => {
    await saveExtraConfig(JSON.parse(JSON.stringify(candidate.value)));
    const before = JSON.stringify(candidate.value);
    load(); // 读取保存后的值：不合法的值已被换成默认值
    if (JSON.stringify(draft.value) !== before) return { warn: '已保存，部分不合法的值已被换成默认值。' };
    return '分步更新的设置已保存。';
  }, '正在保存…');
}

function addGroup() {
  const name = groupName.value.trim();
  if (!name) return;
  if (draft.value.分组接口[name]) {
    toastr.info(`分组“${name}”已经有接口了。`);
    return;
  }
  draft.value.分组接口[name] = createExtraApi();
  groupName.value = '';
}
function removeGroup(name: string) {
  delete draft.value.分组接口[name];
}

const hasFallback = computed(() => Array.isArray((draft.value as any).备用接口));
const hasEjsOption = computed(() => typeof (draft.value as any).EJS预处理 === 'string');
const hasPlanOption = computed(() => typeof (draft.value as any).正文前规划 === 'string');
const hasPlan = typeof (Era.extra as any).replan === 'function';

/** 复制已保存的设置（不含密钥），用于求助或对比。 */
async function copySettings() {
  const redact = optionalExport(extraConfigModule, 'redactExtraConfig');
  const config = loadExtraConfig();
  if (typeof redact !== 'function') {
    toastr.warning('当前版本不能安全地复制设置。');
    return;
  }
  await copy(JSON.stringify(redact(config), null, 2));
}
function addFallback() {
  (draft.value as any).备用接口.push(createExtraApi());
}
function removeFallback(index: number) {
  (draft.value as any).备用接口.splice(index, 1);
}

// ===== 预设、头部提示词等 =====
const PRESET_MODES = ['不使用预设', '使用当前预设', '使用指定预设'];
const hasPresetOptions = computed(() => typeof (draft.value as any).更新模型预设 === 'string');
const presetStages = computed(() => [
  { key: '更新模型预设', nameKey: '更新模型预设名', label: '更新模型' },
  ...(hasPlanOption.value ? [{ key: '规划模型预设', nameKey: '规划模型预设名', label: '规划模型' }] : []),
]);
/** 酒馆里的预设名；已选的预设不在列表里（被删除或改名）时也列出，免得选择框显示成空白。 */
function presetNamesFor(current: string): string[] {
  let names: string[] = [];
  try {
    names = typeof getPresetNames === 'function' ? getPresetNames() : [];
  } catch {
    names = [];
  }
  return current && !names.includes(current) ? [current, ...names] : names;
}
const presetGroupName = ref('');
function addGroupPreset() {
  const name = presetGroupName.value.trim();
  if (!name) return;
  const groups = ((draft.value as any).分组预设 ??= {});
  if (groups[name]) {
    toastr.info(`分组“${name}”已经指定了预设。`);
    return;
  }
  groups[name] = { 预设: '使用当前预设', 预设名: '' };
  presetGroupName.value = '';
}
function removeGroupPreset(name: string) {
  delete (draft.value as any).分组预设[name];
}

// ===== 存为本卡推荐 =====
const { armed, confirm } = useConfirm();
const cardTask = useTask();
/** 写入或清除推荐、切换聊天（含切换角色卡）后刷新显示。 */
const cardVersion = ref(0);
const hasCardWrite = typeof optionalExport(extraConfigModule, 'saveCardExtraPreference') === 'function';

async function saveCard() {
  if (Object.keys(numberErrors.value).length > 0) {
    cardTask.state.kind = 'error';
    cardTask.state.text = '有数字没有填写正确，请按提示修改后再写入。';
    return;
  }
  if (!confirm('saveCard')) return;
  await cardTask.run(async () => {
    const save = optionalExport(extraConfigModule, 'saveCardExtraPreference');
    const written = await save(JSON.parse(JSON.stringify(candidate.value)));
    cardVersion.value++;
    pollStatus();
    return `已写入这张角色卡：${Object.keys(written ?? {}).join('、') || '（没有可推荐的项）'}。导出角色卡时会一起带上。`;
  }, '正在写入角色卡…');
}

async function clearCard() {
  if (!confirm('clearCard')) return;
  await cardTask.run(async () => {
    const clear = optionalExport(extraConfigModule, 'clearCardExtraPreference');
    await clear();
    cardVersion.value++;
    pollStatus();
    return '已清除这张角色卡的推荐设置。';
  }, '正在清除…');
}

/** 角色卡推荐的设置（新版本支持）。 */
const cardPreference = computed(() => {
  void cardVersion.value;
  const getter = optionalExport(extraConfigModule, 'getCardExtraPreference');
  if (typeof getter !== 'function') return '';
  try {
    const preference = getter();
    if (!preference) return '';
    return Object.entries(preference)
      .map(([key, value]) => `${key}：${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('，');
  } catch {
    return '';
  }
});
/** 确认写入时列出会写进角色卡的项（玩家是“跟随角色卡”时含卡里原有的变量更新方式）。 */
const cardSaveKeys = computed(() => {
  void cardVersion.value;
  const preview =
    optionalExport(extraConfigModule, 'previewCardPreference') ??
    optionalExport(extraConfigModule, 'pickCardPreference');
  if (typeof preview !== 'function') return '';
  try {
    return Object.keys(preview(JSON.parse(JSON.stringify(candidate.value))) ?? {}).join('、');
  } catch {
    return '';
  }
});
const effectiveEnabled = computed(() => {
  // 角色卡变量不是响应式的：写入、清除推荐或切换角色卡后靠 cardVersion 重算
  void cardVersion.value;
  const resolve = optionalExport(extraConfigModule, 'resolveExtraConfig');
  const current = extraConfigModule.extraConfig.value;
  const config = typeof resolve === 'function' ? resolve(current) : current;
  return config?.变量更新方式 === '额外模型解析';
});

// ===== 运行状态 =====
interface StatusSnapshot {
  running: { mk: string; startedAt: number; attempt: number }[];
  last: {
    mk: string;
    ok: boolean;
    error?: string;
    prompt?: unknown;
    rawReply?: string;
    finishedAt: number;
    status?: string;
    problems?: string[];
    warnings?: string[];
  } | null;
  pendingSync?: string[];
  history?: {
    type: string;
    mk: string;
    ok: boolean;
    status: string;
    error?: string;
    prompt?: unknown;
    rawReply?: string;
    finishedAt: number;
    warnings?: string[];
  }[];
}
const hasStatus = typeof (Era.extra as any).status === 'function';
const status = shallowRef<StatusSnapshot | null>(null);
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

function pollStatus() {
  now.value = Date.now();
  if (!hasStatus) return;
  try {
    status.value = (Era.extra as any).status();
  } catch (error) {
    status.value = null;
    console.warn('[ERA] 读取分步更新状态失败', error);
  }
}
const elapsed = (start: number) => Math.max(0, Math.round((now.value - start) / 1000));

const promptText = computed(() => formatPrompt(status.value?.last?.prompt));

function formatPrompt(prompt: unknown): string {
  if (prompt === undefined || prompt === null) return '';
  if (Array.isArray(prompt) && prompt.every(item => item && Array.isArray(item.messages))) {
    return prompt
      .map(item =>
        [
          `【分组 ${item.group || '默认'}】`,
          ...item.messages.map((message: any) => `--- ${message.role} ---\n${message.content}`),
        ].join('\n'),
      )
      .join('\n\n');
  }
  if (Array.isArray(prompt) && prompt.every(item => item && typeof item.content === 'string')) {
    return prompt.map((message: any) => `--- ${message.role} ---\n${message.content}`).join('\n');
  }
  return typeof prompt === 'string' ? prompt : JSON.stringify(prompt, null, 2);
}

const STATUS_LABELS: Record<string, string> = {
  done: '已写入',
  no_entries: '没有更新条目',
  no_change: '没有修改',
  aborted: '已取消',
  failed: '失败',
};
const statusLabel = (value: string) => STATUS_LABELS[value] ?? value;

const runTask = useTask();
async function rerun() {
  await runTask.run(async () => {
    const result: any = await store.track(() => Era.extra.run());
    pollStatus();
    if (result && typeof result === 'object' && 'status' in result) {
      if (result.status === 'aborted') return { warn: '解析被取消或被新的解析取代。' };
      if (result.ok === false) throw new Error(result.problems?.join('\n') || statusLabel(result.status));
      return `解析完成：${statusLabel(result.status)}。`;
    }
    return '解析完成。';
  }, '正在请求模型…');
}

const planTask = useTask();
async function replan() {
  await planTask.run(async () => {
    const result: any = await store.track(() => (Era.extra as any).replan());
    pollStatus();
    if (!result) throw new Error('没有重新规划，原因见弹窗。');
    if (result.status === 'aborted') return { warn: '规划被取消或被新的规划取代。' };
    if (result.status === 'no_change') return '规划模型认为这一轮不需要结算，已去掉原来的规划。';
    return `已重新规划：${result.summary || '（没有摘要）'}`;
  }, '正在请求规划模型…');
}

function abort(mk: string) {
  try {
    Era.extra.abort(mk);
    toastr.info('已请求取消。');
  } catch (error) {
    toastr.error(errorText(error), '取消失败');
  }
  pollStatus();
}

async function copy(text: string) {
  await copyText(text);
  toastr.success('已复制。');
}

/** 展开“请求记录”时读取一次。 */
function onHistoryToggle(event: Event) {
  if ((event.target as HTMLDetailsElement | null)?.open) pollStatus();
}

/** 没有进行中的解析时，每隔这么多秒读一次状态：正文前规划不发状态事件，它的记录靠这里刷新。 */
const IDLE_POLL_SECONDS = 5;
let idleTicks = 0;

watch(() => store.extraRunning.size, pollStatus);
// 切换聊天：控制器会清空请求记录，角色卡也可能换了。稍后再读，让控制器先处理完这个事件
watch(
  () => store.chatVersion,
  () => {
    cardVersion.value++;
    setTimeout(pollStatus, 50);
  },
);
onMounted(() => {
  pollStatus();
  timer = setInterval(() => {
    if ((status.value?.running.length ?? 0) > 0 || store.extraRunning.size > 0) {
      idleTicks = 0;
      pollStatus();
    } else if (++idleTicks >= IDLE_POLL_SECONDS) {
      idleTicks = 0;
      pollStatus();
    } else {
      now.value = Date.now();
    }
  }, 1000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style>
.era-root .xtab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.era-root .xtab .era-card + .era-card {
  margin-top: 0;
}
.era-root .xtab-running {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.era-root .xtab-job {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: 9px;
  background: var(--era-accent-soft);
  font-size: 13px;
}
.era-root .xtab-last {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--era-line);
}
.era-root .xtab-last__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.era-root .xtab-last .era-status {
  margin-top: 0;
}
.era-root .xtab-problems {
  margin: 0 0 0 18px;
  color: var(--era-muted);
  font-size: 12px;
}
.era-root .xtab-warnings {
  color: var(--era-warn);
}
.era-root .xtab-details summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
}
.era-root .xtab-details summary::-webkit-details-marker {
  display: none;
}
.era-root .xtab-details summary::before {
  content: '▸';
  color: var(--era-muted);
  transition: transform 0.15s ease;
}
.era-root .xtab-details[open] summary::before {
  transform: rotate(90deg);
}
.era-root .xtab-details .era-code {
  max-height: 320px;
}
.era-root .xtab-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 14px;
}
.era-root .xtab-actions .era-hint {
  flex: 1 1 200px;
}
.era-root .xtab-sub {
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 700;
}
.era-root .xform {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.era-root .xform-row {
  display: grid;
  grid-template-columns: minmax(110px, 1fr) minmax(0, 2fr);
  gap: 4px 12px;
  align-items: center;
  font-size: 13px;
}
.era-root .xform-row > span:first-child {
  color: var(--era-muted);
}
.era-root .xform-row--column {
  grid-template-columns: 1fr;
}
.era-root .xform-error {
  grid-column: 2;
  color: var(--era-danger);
  font-size: 12px;
}
.era-root .xform-note {
  margin-top: -4px;
}
.era-root .xtab-add {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.era-root .xtab-add .era-input {
  flex: 1 1 200px;
}
.era-root .xtab-preset {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.era-root .xtab-preset .era-select {
  flex: 1 1 140px;
}
.era-root .xtab-history {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--era-line);
}
.era-root .xtab-history__item {
  margin-left: 14px;
}
.era-root .xtab-history__item > .era-status,
.era-root .xtab-history__item > ul,
.era-root .xtab-history__item > .xtab-details {
  margin-left: 14px;
}
.era-root .xtab-foot {
  margin-top: 14px;
}
@media (max-width: 640px) {
  .era-root .xform-row {
    grid-template-columns: 1fr;
  }
  .era-root .xform-error {
    grid-column: 1;
  }
}
</style>
