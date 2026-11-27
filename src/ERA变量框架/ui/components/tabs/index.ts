/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 新增。
 * 日期：2026-11-26
 * 目的：重新设计面板：注册内置标签页；新增“诊断”页（变量结构诊断与一键修复、聊天数据体积）
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
/**
 * 内置标签页。新增功能时写一个组件，在这里注册即可；`available` 用于特性探测，
 * 例如运行环境没有对应的 `Era` 接口时不显示。
 */
import { Era } from '../../../api/global';
import { registerTab } from '../../tabs';
import AboutTab from './AboutTab.vue';
import DiagnoseTab from './DiagnoseTab.vue';
import ExtraTab from './ExtraTab.vue';
import LogsTab from './LogsTab.vue';
import SettingsTab from './SettingsTab.vue';
import SnapshotsTab from './SnapshotsTab.vue';
import ToolsTab from './ToolsTab.vue';
import VariablesTab from './VariablesTab.vue';

registerTab({ id: 'variables', label: '变量', icon: 'variables', order: 10, component: VariablesTab });
registerTab({ id: 'logs', label: '日志', icon: 'logs', order: 20, component: LogsTab });
registerTab({ id: 'snapshots', label: '快照', icon: 'history', order: 30, component: SnapshotsTab });
registerTab({
  id: 'extra',
  label: '分步更新',
  icon: 'layers',
  order: 40,
  component: ExtraTab,
  available: () => typeof Era?.extra?.run === 'function',
});
registerTab({ id: 'tools', label: '工具', icon: 'tools', order: 50, component: ToolsTab });
registerTab({ id: 'diagnose', label: '诊断', icon: 'search', order: 55, component: DiagnoseTab });
registerTab({ id: 'settings', label: '设置', icon: 'settings', order: 60, component: SettingsTab });
registerTab({ id: 'about', label: '关于', icon: 'info', order: 70, component: AboutTab });
