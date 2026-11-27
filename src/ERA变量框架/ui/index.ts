/*
 * 修改声明（AFPL 第 2(c)(i) 条）：本文件由 Bailuci 修改。
 * 日期：2026-11-26
 * 目的：重新设计面板：关闭悬浮球时仍可从酒馆扩展菜单、/era 命令或脚本按钮打开面板；记录指令与 schema 问题、分步更新进度，显示在悬浮球上；注册 /era-get、/era-issues 命令；变量不符合结构时提示，点此诊断（2026-11-26）
 *       2026-11-27 切换聊天时通知面板刷新请求记录与角色卡推荐
 * 原项目：RockingSisyphus/ERA-EfficientRollbackArchitecture，修改记录见仓库根目录的 更新日志.md
 */
import { createPinia } from 'pinia';
import { App as VueApp, createApp } from 'vue';
import type {
  CommandErrorPayload,
  ExtraStatusPayload,
  SchemaErrorPayload,
  SchemaInvalidPayload,
  WriteDonePayload,
} from '../utils/constants';
import { Logger } from '../utils/log';
import App from './App.vue';
import { registerDataCommands } from './commands';
import { hostWindow } from './host';
import { UiStore, useUiStore } from './store';
import { createMountPoint, destroyMountPoint, deteleportStyle, teleportStyle } from './utils/dom';

const logger = new Logger();
let vueApp: VueApp | null = null;
let store: UiStore | null = null;
const cleanups: (() => void)[] = [];

/** 脚本按钮名（酒馆助手 → ERA 脚本 → 按钮），默认不显示，玩家可以自己打开。 */
const SCRIPT_BUTTON = 'ERA 面板';
const MENU_ITEM_ID = 'era-heron-menu-open';

/**
 * 兼容旧接口：切换视图。
 * @deprecated 内部使用，可能在以后的版本移除。
 */
function switchView(viewName: 'FloatingBall' | 'ExpandedView') {
  if (!store) return;
  if (viewName === 'ExpandedView') store.openPanel();
  else store.closePanel();
}
(window as any).eraUiSwitchView = switchView;

// ===== 入口：酒馆扩展菜单 =====
function addExtensionsMenuItem() {
  const $menu = $('#extensionsMenu');
  if ($menu.length === 0) return;
  $(`#${MENU_ITEM_ID}`).remove();
  const $item = $('<div class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem">')
    .attr('id', MENU_ITEM_ID)
    .attr('title', '打开 ERA-Heron 面板')
    .append($('<div class="fa-solid fa-feather-pointed extensionsMenuExtensionButton"></div>'))
    .append($('<span>').text('ERA 面板'));
  $item.on('click keydown', (event: JQuery.TriggeredEvent) => {
    if (event.type === 'keydown' && !['Enter', ' '].includes((event as any).key)) return;
    store?.openPanel();
    // 菜单本身的显示由酒馆控制；点击后收起
    $menu.hide();
  });
  $menu.append($item);
  cleanups.push(() => $(`#${MENU_ITEM_ID}`).remove());
}

// ===== 入口：/era 斜杠命令 =====
let commandAlive = false;
function handleCommand(arg: string): string {
  if (!commandAlive || !store) {
    toastr.warning('ERA 脚本没有在运行。', 'ERA');
    return '';
  }
  switch (arg.trim().toLowerCase()) {
    case '':
    case 'open':
      store.openPanel();
      break;
    case 'close':
      store.closePanel();
      break;
    case 'toggle':
      store.togglePanel();
      break;
    case 'ball':
    case 'show':
      store.showBall().catch(error => logger.error('handleCommand', '显示悬浮球失败', error));
      break;
    case 'hide':
      store.hideBall();
      break;
    default:
      // 其余参数当作标签页名，例如 /era settings
      store.openPanel(arg.trim());
  }
  return '';
}

function registerSlashCommand() {
  const context: any = SillyTavern;
  const { SlashCommandParser, SlashCommand, SlashCommandArgument } = context ?? {};
  if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
  try {
    const props: Record<string, any> = {
      name: 'era',
      aliases: ['era-heron'],
      callback: (_named: unknown, value: unknown) => handleCommand(String(value ?? '')),
      helpString:
        'ERA-Heron 面板。<code>/era</code> 打开面板；<code>/era close</code> 关闭；<code>/era ball</code> 显示悬浮球；<code>/era hide</code> 隐藏悬浮球；<code>/era settings</code> 等打开指定页面。',
    };
    if (SlashCommandArgument?.fromProps) {
      props.unnamedArgumentList = [
        SlashCommandArgument.fromProps({
          description:
            'open / close / toggle / ball / hide，或页面名（variables、logs、snapshots、extra、tools、settings、about）',
          typeList: ['string'],
          isRequired: false,
        }),
      ];
    }
    SlashCommandParser.addCommandObject(SlashCommand.fromProps(props));
    commandAlive = true;
    cleanups.push(() => (commandAlive = false));
  } catch (error) {
    logger.warn('registerSlashCommand', '注册 /era 命令失败', error);
  }
}

// ===== 入口：酒馆助手脚本按钮 =====
function registerScriptButton() {
  try {
    // 只在按钮列表里还没有时追加，并且默认不显示，不改变玩家已有的按钮设置
    appendInexistentScriptButtons([{ name: SCRIPT_BUTTON, visible: false }]);
    const { stop } = eventOn(getButtonEvent(SCRIPT_BUTTON), () => store?.togglePanel()) as any;
    if (typeof stop === 'function') cleanups.push(stop);
  } catch (error) {
    logger.debug('registerScriptButton', '当前酒馆助手不支持脚本按钮', error);
  }
}

// ===== 事件 =====
function listen<T>(event: string, handler: (payload: T) => void) {
  const result: any = eventOn(event as any, handler as any);
  cleanups.push(() => {
    if (typeof result?.stop === 'function') result.stop();
    else eventRemoveListener(event as any, handler as any);
  });
}

function wireEvents(ui: UiStore) {
  listen<WriteDonePayload>('era:writeDone', data => ui.setEventData(data));
  listen<CommandErrorPayload>('era:commandError', payload => {
    const errors = payload?.errors ?? [];
    if (errors.length === 0) return;
    const first = errors[0];
    ui.addProblem({
      source: '指令',
      title: `第 ${first.message_id} 楼有 ${errors.length} 条指令没有生效`,
      detail: errors
        .slice(0, 20)
        .map(error => `#${error.message_id} ${error.type} ${error.path || '（根）'}：${error.reason}`)
        .join('\n'),
      message_id: first.message_id,
    });
  });
  listen<SchemaErrorPayload>('era:schemaError', payload => {
    const errors = payload?.errors ?? [];
    if (errors.length === 0) return;
    ui.addProblem({
      source: '变量结构',
      title: `变量结构拦截了 ${errors.length} 处修改`,
      detail: errors
        .slice(0, 20)
        .map(error => `#${error.message_id} ${error.op} ${error.path}：${error.message}`)
        .join('\n'),
      message_id: errors[0].message_id,
    });
  });
  listen<SchemaInvalidPayload>('era:schemaInvalid', payload => {
    const issues = payload?.issues ?? [];
    const missing = issues.filter(issue => issue.kind === 'missing').length;
    ui.addProblem({
      source: '变量结构',
      title: '变量当前不符合结构，点此诊断',
      detail: payload?.error
        ? `变量结构执行出错：${payload.error}`
        : [
            missing > 0 ? `缺必填字段 ${missing} 处（多半是角色卡升级后新增了字段）` : '',
            ...issues
              .slice(0, 20)
              .map(
                issue => `${issue.kind === 'missing' ? '缺少' : '不符'} ${issue.path || '（根）'}：${issue.message}`,
              ),
          ]
            .filter(Boolean)
            .join('\n'),
      message_id: payload?.message_id,
      tab: 'diagnose',
      tabLabel: '诊断',
    });
  });
  listen<ExtraStatusPayload>('era:extraStatus', payload => ui.onExtraStatus(payload));
  // 切换聊天：问题与进行中的解析属于上一个聊天
  try {
    listen(tavern_events.CHAT_CHANGED, () => {
      ui.extraRunning.clear();
      ui.chatVersion++;
    });
  } catch {
    // 忽略
  }
}

// ===== 挂载与卸载 =====
function unloadUI() {
  logger.log('unloadUI', 'UI 脚本开始卸载');
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!();
    } catch {
      // 忽略
    }
  }
  if (vueApp) {
    vueApp.unmount();
    vueApp = null;
  }
  store = null;
  deteleportStyle();
  destroyMountPoint();
  window.removeEventListener('pagehide', unloadUI);
  logger.log('unloadUI', 'UI 脚本卸载完成');
}

$(() => {
  logger.log('initialize', 'UI 脚本开始初始化');
  const mountPoint = createMountPoint();
  $('body').append(mountPoint);

  vueApp = createApp(App);
  const pinia = createPinia();
  vueApp.use(pinia);
  store = useUiStore(pinia);
  // 先接上事件，避免错过挂载期间的 writeDone
  wireEvents(store);
  vueApp.mount(mountPoint[0]);
  (window as any).eraUiStore = store;

  teleportStyle();

  addExtensionsMenuItem();
  registerSlashCommand();
  const stopDataCommands = registerDataCommands();
  if (stopDataCommands) cleanups.push(stopDataCommands);
  registerScriptButton();

  logger.debug('initialize', `UI 已挂载到 ${hostWindow() === window ? '当前页面' : '酒馆页面'}`);
  window.removeEventListener('pagehide', unloadUI);
  window.addEventListener('pagehide', unloadUI);
});
