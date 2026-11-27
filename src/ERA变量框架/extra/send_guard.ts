/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-25 至 2026-11-26
 * 目的：修复复审中发现的问题；发送前等待只拦玩家的发送，脚本用 Era.extra.wait()；修复 [1] 形式的键在 Patch 中的回滚；放弃等待时提示玩家
 *       2026-11-27 等待之后可以先做正文前规划，把结果写进输入框再发送
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 变量框架 - 发送前等待
 * @description
 * 玩家点击发送时，如果变量还在更新，先拦下这次点击，等更新完再替玩家点一次。
 *
 * 不在 `GENERATION_STARTED` 里拦截玩家的发送：那时酒馆已经进入生成流程，却还没有锁定界面，
 * 玩家可以再点一次发送、滑动、重新生成或切换聊天，而已经进入流程的那次又无法干净地取消。
 * 因此脚本、快速回复触发的生成不等待；需要等待的脚本可以先 `await Era.extra.wait()`。
 */
'use strict';

import { Logger } from '../utils/log';

const logger = new Logger();

export interface SendGuardOptions {
  /** 现在是否需要等待。 */
  shouldHold(): boolean;
  /** 等待到可以发送为止。返回 `false` 表示没有等到完成就放弃了（到了时限或玩家不想再等）。 */
  wait(): Promise<boolean | void>;
  /** 这次发送是否要先做正文前规划。 */
  shouldPlan?(text: string): boolean;
  /** 正文前规划：返回要发送的新文本，`null` 表示不发送，`undefined` 表示照原样发送。 */
  plan?(text: string): Promise<string | null | undefined>;
}

/** 安装拦截，返回卸载函数。 */
export function installSendGuard({ shouldHold, wait, shouldPlan, plan }: SendGuardOptions): () => void {
  const page: Window = window.parent ?? window;
  const getText = () => String($('#send_textarea').val() ?? '');
  let holding = false;
  let passing = false;

  const hold = async (planning: boolean) => {
    holding = true;
    const snapshot = () => [SillyTavern.getCurrentChatId?.(), SillyTavern.chat?.length, getText()];
    let before = snapshot();
    let finished: boolean | void;
    const changed = () => {
      if (_.isEqual(snapshot(), before) && !builtin.duringGenerating()) return false;
      logger.log('hold', '等待期间内容或聊天已经改变，不再自动发送');
      toastr.info('等待期间内容有变化，没有自动发送。', '[ERA]');
      return true;
    };
    try {
      finished = await wait();
      await new Promise(resolve => setTimeout(resolve, 50));
      if (changed()) return;
      if (planning && plan) {
        // 规划要在变量更新完之后做：它依据的是上一轮结束时的变量
        const next = await plan(getText());
        if (next === null || changed()) return;
        if (next !== undefined) {
          $('#send_textarea').val(next).trigger('input');
          before = snapshot();
        }
      }
    } finally {
      holding = false;
    }
    if (changed()) return;
    if (finished === false) {
      toastr.warning('变量仍在更新，已先发送。更新完成后仍会写回原来那一楼，但这次生成看到的是更新前的变量。', '[ERA]');
    }
    passing = true;
    try {
      page.document.querySelector<HTMLElement>('#send_but')?.click();
    } finally {
      passing = false;
    }
  };

  const intercept = (event: Event) => {
    if (passing) return;
    let planning = false;
    if (!holding) {
      // 斜杠命令不会产生剧情
      if (getText().startsWith('/') || builtin.duringGenerating()) return;
      planning = !!shouldPlan?.(getText());
      if (!planning && !shouldHold()) return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!holding) void hold(planning);
  };

  const onClick = (event: Event) => {
    if ((event.target as Element | null)?.closest?.('#send_but')) intercept(event);
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return;
    if ((event.target as Element | null)?.id !== 'send_textarea') return;
    // 没有文字时 Ctrl+Enter 是重新生成
    if (event.ctrlKey && getText() === '') return;
    if ((SillyTavern as any).shouldSendOnEnter?.()) intercept(event);
  };

  page.addEventListener('click', onClick, true);
  page.addEventListener('keydown', onKeydown, true);
  return () => {
    page.removeEventListener('click', onClick, true);
    page.removeEventListener('keydown', onKeydown, true);
  };
}
