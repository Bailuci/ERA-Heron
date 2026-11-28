<!--
  修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增（取代 RightRailContent/EraSettingsPanel.vue）。
  日期：2026-11-26
  目的：重新设计面板：设置页（面板外观与悬浮球；脚本设置分组显示、带说明；保存前逐项校验，数字框清空时拒绝保存，保存后重新读取校验后的值）；
        2026-11-26 新增“思考标签”“指令外层标签”的说明
        2026-11-27 说明里不再写“1.7 起”，改为“只对新建的聊天生效”
        2026-11-28 改正“调试模式”“下划线只读”的说明
  原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
-->
<template>
  <div class="gtab">
    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">面板与悬浮球</span>
        <span class="era-card__sub">只保存在这台设备的浏览器里</span>
      </div>
      <div class="gtab-rows">
        <div class="gtab-row">
          <div class="gtab-row__text">
            <div class="gtab-row__label">配色</div>
            <div class="era-hint">“跟随酒馆”使用酒馆界面主题的颜色。</div>
          </div>
          <div class="era-segmented">
            <button
              v-for="item in THEMES"
              :key="item.value"
              :class="{ active: store.theme === item.value }"
              @click="store.layout.theme = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
        <div class="gtab-row">
          <div class="gtab-row__text">
            <div class="gtab-row__label">显示悬浮球</div>
            <div class="era-hint">
              隐藏后可从酒馆扩展菜单（魔棒图标）的“ERA 面板”，或发送 /era 打开面板；/era ball 重新显示悬浮球。
            </div>
          </div>
          <label class="era-switch">
            <input type="checkbox" :checked="store.ballVisible" aria-label="显示悬浮球" @change="toggleBall" />
            <span></span>
          </label>
        </div>
        <div class="gtab-row">
          <div class="gtab-row__text">
            <div class="gtab-row__label">面板位置</div>
            <div class="era-hint">
              浮动窗口可拖动标题栏、拖右下角调整大小；停靠时拖内侧边缘调整宽度。手机上总是全屏。
            </div>
          </div>
          <div class="gtab-inline">
            <div class="era-segmented">
              <button :class="{ active: store.layout.panel.mode === 'float' }" @click="setMode('float')">浮动</button>
              <button :class="{ active: store.layout.panel.mode === 'dock' }" @click="setMode('dock')">停靠</button>
            </div>
            <div v-if="store.layout.panel.mode === 'dock'" class="era-segmented">
              <button
                :class="{ active: store.layout.panel.dockSide === 'left' }"
                @click="store.layout.panel.dockSide = 'left'"
              >
                左
              </button>
              <button
                :class="{ active: store.layout.panel.dockSide === 'right' }"
                @click="store.layout.panel.dockSide = 'right'"
              >
                右
              </button>
            </div>
          </div>
        </div>
        <div class="gtab-row">
          <div class="gtab-row__text">
            <div class="gtab-row__label">重置位置与大小</div>
            <div class="era-hint">悬浮球和面板找不到或位置不合适时使用。</div>
          </div>
          <button class="era-btn era-btn--sm" @click="resetLayout">重置</button>
        </div>
      </div>
    </section>

    <section class="era-card">
      <div class="era-card__head">
        <span class="era-card__title">ERA 设置</span>
        <span v-if="changedKeys.length > 0" class="era-chip era-chip--warn">{{ changedKeys.length }} 项未保存</span>
        <span class="era-spacer"></span>
        <button class="era-btn era-btn--sm" :disabled="changedKeys.length === 0" @click="load(false)">丢弃修改</button>
        <button
          class="era-btn era-btn--sm era-btn--primary"
          :disabled="saveTask.state.busy || changedKeys.length === 0"
          @click="save"
        >
          保存
        </button>
      </div>
      <p class="era-hint">保存在 ERA 脚本的脚本变量中；ERA 装在角色卡脚本里时会随角色卡导出。</p>
      <TaskStatus :task="saveTask.state" />

      <div v-for="group in groups" :key="group.title" class="gtab-group">
        <h4 class="gtab-group__title">{{ group.title }}</h4>
        <div class="gtab-rows">
          <div
            v-for="field in group.fields"
            :key="field.key"
            class="gtab-row"
            :class="{ changed: isChanged(field.key) }"
          >
            <div class="gtab-row__text">
              <div class="gtab-row__label">{{ field.label }}</div>
              <div v-if="field.desc" class="era-hint">{{ field.desc }}</div>
              <div v-if="errors[field.key]" class="gtab-error">{{ errors[field.key] }}</div>
            </div>
            <label v-if="field.type === 'boolean'" class="era-switch">
              <input v-model="drafts[field.key]" type="checkbox" :aria-label="field.label" />
              <span></span>
            </label>
            <input
              v-else-if="field.type === 'number'"
              v-model="drafts[field.key]"
              type="number"
              class="era-input gtab-number"
              :class="{ 'era-input--invalid': errors[field.key] }"
              :min="field.min"
              :aria-label="field.label"
            />
            <input
              v-else-if="field.type === 'string'"
              v-model="drafts[field.key]"
              type="text"
              class="era-input gtab-text"
              :class="{ 'era-input--invalid': errors[field.key] }"
              :aria-label="field.label"
            />
            <textarea
              v-else
              v-model="drafts[field.key]"
              class="era-textarea gtab-json"
              :class="{ 'era-input--invalid': errors[field.key] }"
              :aria-label="field.label"
            ></textarea>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import toastr from 'toastr';
import { computed, reactive, ref, watch } from 'vue';
import * as constants from '../../../utils/constants';
import { settings, updateScriptSettings } from '../../../utils/era_data';
import { errorText, optionalExport, useTask } from '../../actions';
import type { PanelMode, ThemeChoice } from '../../host';
import { useUiStore } from '../../store';
import TaskStatus from '../../template/TaskStatus.vue';

const store = useUiStore();

const THEMES: { value: ThemeChoice; label: string }[] = [
  { value: 'tavern', label: '跟随酒馆' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
];

function toggleBall(event: Event) {
  if ((event.target as HTMLInputElement).checked) {
    store.showBall().catch(error => toastr.error(errorText(error), '显示悬浮球失败'));
  } else {
    store.hideBall();
  }
}
function setMode(mode: PanelMode) {
  store.layout.panel.mode = mode;
}
function resetLayout() {
  store.resetLayout();
  toastr.success('悬浮球和面板已回到默认位置。');
}

// ===== 脚本设置 =====
type FieldType = 'boolean' | 'number' | 'string' | 'json';
interface FieldMeta {
  label?: string;
  desc?: string;
  group: string;
  min?: number;
  integer?: boolean;
  nonEmpty?: boolean;
}

/** 已知设置的说明；新版本增加的设置没有说明时也会显示在“其他”中。 */
const META: Record<string, FieldMeta> = {
  在ai消息尾部生成特殊符号: {
    group: '状态栏',
    desc: 'AI 消息末尾没有特殊符号时自动追加，配合正则替换成状态栏。',
  },
  特殊符号值: { group: '状态栏', desc: '上一项追加的符号。', nonEmpty: true },
  强制重载功能: {
    group: '状态栏',
    desc: '每次写入或同步后约 1 秒，把最近几条消息原样写回一次，让楼层重新渲染、刷新其中的宏。',
  },
  强制重载消息数: { group: '状态栏', desc: '上一项重新渲染的消息数，至少 1。', min: 1, integer: true },
  宽松解析: { group: '指令解析', desc: '指令块的 JSON 写坏时（尾逗号、单引号、全角标点等）尝试修复后再解析。' },
  繁体转简体: { group: '指令解析', desc: '解析前把繁体中文转成简体，避免 AI 输出繁体键名导致路径对不上。' },
  数组内保留对象: {
    group: '指令解析',
    desc: '默认把数组内的对象转成 JSON 字符串保存（兼容旧卡）；开启后数组可以直接存放对象。',
  },
  下划线只读: {
    group: '指令解析',
    desc: 'AI 的指令不能修改或删除以 _ 开头的字段；面板、Era.commit、钩子和工具不受限制，Era.applyText 和追加到正文的写入事件同样受限。',
  },
  指令失败提示: { group: '指令解析', desc: '最新一条消息有指令没有生效时弹窗提示。' },
  API写入不修改消息: { group: '指令解析', desc: '脚本通过事件写入变量时，不再把指令块追加到消息正文。' },
  思考标签: {
    group: '指令解析',
    desc: '这些标签里的指令不执行（逗号分隔，按你的预设增删）。只对新建的聊天生效，旧聊天保持原样；留空表示不遮蔽。',
  },
  指令外层标签: {
    group: '指令解析',
    desc: '填写后（例如 ERA_Update）只执行该标签内的指令。只对新建的聊天生效，旧聊天保持原样；留空表示不启用。',
  },
  清理失效日志: { group: '日志与性能', desc: '重算时删除已被删除或滑走的消息留下的日志，减小聊天文件。' },
  日志保留楼层数: {
    group: '日志与性能',
    desc: '只保留最近 N 楼的逐楼日志，更早的合并成一份；0 为不折叠，长聊天建议 100。',
    min: 0,
    integer: true,
  },
  折叠日志存档: { group: '日志与性能', desc: '把折叠掉的日志存到酒馆服务器上的单独文件，仍可回滚和查询旧楼层。' },
  调试模式: {
    group: '调试',
    desc: 'ERA 的警告和错误除了写到控制台，还用弹窗显示。详细日志在控制台用 eraDebug.add("*") 开启。',
  },
};
/** 在“面板与悬浮球”中处理，或已由面板配色取代的设置。 */
const HIDDEN = new Set(['开启悬浮球', '开启黑夜模式']);
const GROUP_ORDER = ['状态栏', '指令解析', '日志与性能', '调试', '其他'];

const detectType = (value: unknown): FieldType =>
  typeof value === 'boolean'
    ? 'boolean'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'string'
        ? 'string'
        : 'json';

const original = ref<Record<string, any>>({});
const drafts = reactive<Record<string, any>>({});
const types = reactive<Record<string, FieldType>>({});

function toDraft(value: any, type: FieldType) {
  if (type === 'number') return String(value);
  if (type === 'json') return JSON.stringify(value, null, 2);
  return value;
}

function load(silent = true) {
  const current = _.cloneDeep(settings.value) as Record<string, any>;
  original.value = current;
  for (const key of Object.keys(drafts)) delete drafts[key];
  for (const [key, value] of Object.entries(current)) {
    if (HIDDEN.has(key)) continue;
    types[key] = detectType(value);
    drafts[key] = toDraft(value, types[key]);
  }
  if (!silent) saveTask.reset();
}

const groups = computed(() => {
  const byGroup = new Map<string, { key: string; label: string; desc?: string; type: FieldType; min?: number }[]>();
  for (const key of Object.keys(drafts)) {
    const meta = META[key];
    const group = meta?.group ?? '其他';
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group)!.push({ key, label: meta?.label ?? key, desc: meta?.desc, type: types[key], min: meta?.min });
  }
  return GROUP_ORDER.filter(title => byGroup.has(title)).map(title => ({ title, fields: byGroup.get(title)! }));
});

/** 把编辑框中的内容转换成设置值；不合法时返回错误说明。 */
function parseField(key: string): { value?: any; error?: string } {
  const type = types[key];
  const raw = drafts[key];
  const meta = META[key];
  let value: any = raw;
  if (type === 'number') {
    const text = String(raw ?? '').trim();
    value = Number(text);
    if (text === '' || !Number.isFinite(value)) return { error: '请填写数字，不能留空' };
    if (meta?.integer && !Number.isInteger(value)) return { error: '请填写整数' };
    if (meta?.min !== undefined && value < meta.min) return { error: `不能小于 ${meta.min}` };
  } else if (type === 'string') {
    if (meta?.nonEmpty && !String(raw).trim()) return { error: '不能为空' };
  } else if (type === 'json') {
    try {
      value = JSON.parse(String(raw));
    } catch (error) {
      return { error: `JSON 格式错误：${errorText(error)}` };
    }
  }
  // 运行环境提供严格校验时再核对一次（例如新增的取值范围）
  const strict = optionalExport(constants, 'StrictSettingsSchema')?.shape?.[key];
  if (strict && typeof strict.safeParse === 'function') {
    const result = strict.safeParse(value);
    if (!result.success) return { error: result.error?.issues?.[0]?.message ?? '取值不合法' };
  }
  return { value };
}

const parsed = computed(() => {
  const values: Record<string, any> = {};
  const errs: Record<string, string> = {};
  for (const key of Object.keys(drafts)) {
    const result = parseField(key);
    if (result.error) errs[key] = result.error;
    else values[key] = result.value;
  }
  return { values, errors: errs };
});
const serverErrors = reactive<Record<string, string>>({});
const errors = computed(() => ({ ...serverErrors, ...parsed.value.errors }));
const changedKeys = computed(() =>
  Object.keys(drafts).filter(
    key => key in parsed.value.errors || !_.isEqual(parsed.value.values[key], original.value[key]),
  ),
);
const isChanged = (key: string) => changedKeys.value.includes(key);

watch(
  () => ({ ...drafts }),
  () => {
    for (const key of Object.keys(serverErrors)) delete serverErrors[key];
  },
);

const saveTask = useTask();
async function save() {
  const { values, errors: errs } = parsed.value;
  if (Object.keys(errs).length > 0) {
    saveTask.state.kind = 'error';
    saveTask.state.text = `有 ${Object.keys(errs).length} 项设置不合法，请按提示修改后再保存。`;
    return;
  }
  const changes = _.pick(values, changedKeys.value);
  await saveTask.run(async () => {
    try {
      await updateScriptSettings(current => ({ ...current, ...changes }) as any);
    } catch (error) {
      // 保存时被拒绝：把错误对应到字段上
      // 新版本抛出 InvalidSettingsError，error.fields 是非法字段名；旧版本只能从错误信息里找键名
      const message = errorText(error);
      const fields: unknown = (error as any)?.fields;
      const keys = Array.isArray(fields)
        ? fields.map(String)
        : Object.keys(changes).filter(key => message.includes(key));
      for (const key of keys) serverErrors[key] = '取值不合法，未保存';
      throw error;
    }
    window.dispatchEvent(new CustomEvent('era-settings-updated'));
    const expected = _.cloneDeep(changes);
    load();
    const adjusted = Object.keys(expected).filter(
      key => !_.isEqual(settings.value[key as keyof typeof settings.value], expected[key]),
    );
    if (adjusted.length > 0) return { warn: `已保存。以下设置被调整为合法的值：${adjusted.join('、')}。` };
    return `已保存 ${Object.keys(changes).length} 项设置。`;
  }, '正在保存…');
}

load();
</script>

<style>
.era-root .gtab {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.era-root .gtab .era-card + .era-card {
  margin-top: 0;
}
.era-root .gtab-group {
  margin-top: 16px;
}
.era-root .gtab-group__title {
  margin-bottom: 4px;
  color: var(--era-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
}
.era-root .gtab-rows {
  display: flex;
  flex-direction: column;
}
.era-root .gtab-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid var(--era-line);
}
.era-root .gtab-rows > .gtab-row:first-child {
  border-top: 0;
}
.era-root .gtab-row.changed .gtab-row__label::after {
  content: ' •';
  color: var(--era-warn);
}
.era-root .gtab-row__text {
  flex: 1;
  min-width: 0;
}
.era-root .gtab-row__label {
  font-size: 13px;
  font-weight: 600;
}
.era-root .gtab-error {
  margin-top: 3px;
  color: var(--era-danger);
  font-size: 12px;
}
.era-root .gtab-inline {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.era-root .gtab-row > .gtab-number {
  flex: none;
  width: 96px;
}
.era-root .gtab-row > .gtab-text {
  flex: none;
  width: 220px;
}
.era-root .gtab-row > .gtab-json {
  flex: 0 1 260px;
}
@media (max-width: 640px) {
  .era-root .gtab-row {
    flex-wrap: wrap;
  }
  .era-root .gtab-row > .gtab-text,
  .era-root .gtab-row > .gtab-json {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
