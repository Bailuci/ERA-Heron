/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：重新设计面板：布局与状态持久化、悬浮球状态提示；事件数据改用 shallowRef，面板关闭时不重算；问题可以带一个跳转的页面（变量结构诊断）
 *       2026-11-27 记录切换聊天的次数（chatVersion），面板据此刷新请求记录与角色卡推荐
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import { defineStore } from 'pinia';
import { computed, reactive, ref, shallowRef, watch } from 'vue';
import type { ExtraStatusPayload, WriteDonePayload } from '../utils/constants';
import { settings, updateScriptSettings } from '../utils/era_data';
import { clearLayout, defaultLayout, loadLayout, saveLayout, ThemeChoice } from './host';

/** 面板记录的一条问题（指令没有生效、schema 拦截、分步更新失败、面板操作失败）。 */
export interface UiProblem {
  id: number;
  time: number;
  source: '指令' | '变量结构' | '分步更新' | '面板';
  title: string;
  detail?: string;
  message_id?: number;
  /** 点击后打开的面板页面，例如变量结构诊断的 `diagnose`。 */
  tab?: string;
  /** 跳转按钮的文字。 */
  tabLabel?: string;
}

const MAX_PROBLEMS = 50;
let problemSeq = 0;

export const useUiStore = defineStore('ui', () => {
  const layout = reactive(loadLayout());
  watch(
    layout,
    _.debounce(() => saveLayout(layout), 300),
    { deep: true },
  );

  const open = ref(false);
  /** 最近一次 `era:writeDone` 的数据。shallowRef：整体替换，不做深层响应式代理。 */
  const eventData = shallowRef<WriteDonePayload | null>(null);
  /** 面板发起、尚未完成的操作数。 */
  const busy = ref(0);
  /** 正在进行的分步更新，按 MK。 */
  const extraRunning = reactive(new Map<string, { message_id: number; status: string; since: number }>());
  const problems = shallowRef<UiProblem[]>([]);
  /** 切换聊天（含切换角色卡）的次数：面板据此重新读取只属于当前聊天或角色卡的状态。 */
  const chatVersion = ref(0);
  const unseenProblems = ref(0);

  const ballVisible = computed(() => settings.value.开启悬浮球 !== false && !layout.ball.hidden);
  const theme = computed<ThemeChoice>(() => layout.theme ?? (settings.value.开启黑夜模式 ? 'dark' : 'tavern'));

  function setEventData(data: WriteDonePayload | null) {
    // 同一个对象也会交给其他监听者，不能冻结或代理它
    eventData.value = data;
  }

  function openPanel(tab?: string) {
    if (tab) layout.tab = tab;
    open.value = true;
    layout.panel.minimized = false;
  }
  function closePanel() {
    open.value = false;
  }
  function togglePanel() {
    if (open.value) closePanel();
    else openPanel();
  }

  async function showBall() {
    layout.ball.hidden = false;
    if (settings.value.开启悬浮球 === false) {
      await updateScriptSettings(current => ({ ...current, 开启悬浮球: true }));
    }
  }
  function hideBall() {
    layout.ball.hidden = true;
  }

  function resetLayout() {
    const fresh = defaultLayout();
    clearLayout();
    Object.assign(layout.ball, fresh.ball);
    Object.assign(layout.panel, fresh.panel);
  }

  /** 执行一个面板操作，期间悬浮球显示“进行中”。 */
  async function track<T>(task: () => Promise<T>): Promise<T> {
    busy.value++;
    try {
      return await task();
    } finally {
      busy.value--;
    }
  }

  function addProblem(problem: Omit<UiProblem, 'id' | 'time'>) {
    problems.value = [{ ...problem, id: ++problemSeq, time: Date.now() }, ...problems.value].slice(0, MAX_PROBLEMS);
    unseenProblems.value = Math.min(unseenProblems.value + 1, MAX_PROBLEMS);
  }
  function markProblemsSeen() {
    unseenProblems.value = 0;
  }
  function clearProblems() {
    problems.value = [];
    unseenProblems.value = 0;
  }

  function onExtraStatus(payload: ExtraStatusPayload) {
    if (!payload?.mk) return;
    if (payload.status === 'started' || payload.status === 'retry') {
      const prev = extraRunning.get(payload.mk);
      extraRunning.set(payload.mk, {
        message_id: payload.message_id,
        status: payload.status,
        since: prev?.since ?? Date.now(),
      });
      return;
    }
    extraRunning.delete(payload.mk);
    if (payload.status === 'failed') {
      addProblem({
        source: '分步更新',
        title: `第 ${payload.message_id} 楼的分步更新失败`,
        detail: payload.problems?.join('\n'),
        message_id: payload.message_id,
      });
    }
  }

  return {
    layout,
    open,
    eventData,
    busy,
    extraRunning,
    chatVersion,
    problems,
    unseenProblems,
    ballVisible,
    theme,
    setEventData,
    openPanel,
    closePanel,
    togglePanel,
    showBall,
    hideBall,
    resetLayout,
    track,
    addProblem,
    markProblemsSeen,
    clearProblems,
    onExtraStatus,
  };
});

export type UiStore = ReturnType<typeof useUiStore>;
