/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：重新设计面板：挂载点不再自带定位与层级，由面板根元素决定
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
export function createMountPoint(): JQuery<HTMLDivElement> {
  // 先移除上一次加载残留的挂载点
  destroyMountPoint();
  return $('<div>').attr('id', `era-ui-mount-point-${getScriptId()}`) as JQuery<HTMLDivElement>;
}

export function destroyMountPoint(): void {
  $(`div#era-ui-mount-point-${getScriptId()}`).remove();
}

export function teleportStyle(): void {
  const scriptId = getScriptId();
  // 先移除旧的，确保样式是最新的
  $(`head > div[script_id="${scriptId}"]`).remove();

  const $div = $('<div>').attr('script_id', scriptId).append($(document).find('head > style').clone());
  $('head').append($div);
}

export function deteleportStyle(): void {
  $(`head > div[script_id="${getScriptId()}"]`).remove();
}
