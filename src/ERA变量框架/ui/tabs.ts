/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：标签页注册表，按功能探测显示，便于以后增加新功能
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 修改记录.md
 */
/**
 * @file ERA 面板 - 标签页注册表
 * @description
 * 面板左侧（手机上是顶部）的导航由这里注册的标签页生成。新增功能时只需要写一个组件并调用 `registerTab`；
 * `available` 返回假时不显示（例如运行环境里没有对应的 `Era` 接口）。
 */
'use strict';

import { Component, computed, markRaw, shallowReactive } from 'vue';
import type { IconName } from './icons';

export interface PanelTab {
  /** 唯一标识，也用于记住上次打开的标签页。 */
  id: string;
  label: string;
  icon: IconName;
  /** 排序，从小到大。 */
  order: number;
  component: Component;
  /** 是否显示；缺省为显示。会在面板打开时求值，可以做特性探测。 */
  available?: () => boolean;
}

const registry = shallowReactive<PanelTab[]>([]);

/** 注册一个标签页；同 id 的会被替换。返回注销函数。 */
export function registerTab(tab: PanelTab): () => void {
  const entry = { ...tab, component: markRaw(tab.component) };
  const index = registry.findIndex(item => item.id === tab.id);
  if (index === -1) registry.push(entry);
  else registry.splice(index, 1, entry);
  return () => {
    const at = registry.indexOf(entry);
    if (at !== -1) registry.splice(at, 1);
  };
}

/** 当前可用的标签页，按 `order` 排序。 */
export const availableTabs = computed(() =>
  [...registry]
    .filter(tab => {
      try {
        return tab.available ? tab.available() : true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.order - b.order),
);
