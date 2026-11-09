/**
 * 客户端侧的供应商 → 平台映射：只是 Host 那份唯一真表的再导出。
 *
 * 历史上这里存过一份手抄副本，火山方舟（`ark → volcark`）只加在 Host 那份上，
 * 于是浏览器侧认不出火山方舟卡片、置顶逻辑静默失效。现在两边共用
 * `src/platform-map.ts`，这份文件保留只是为了不改动既有 import 路径。
 *
 * 单独成模块的原始动机仍然成立：纯排序逻辑（panel-order.ts）不该顺着
 * controller.ts 拖进快照 store / 浏览器设施。
 * @module dsh-quota/client/platform-map
 */

export { ARK_PLATFORM_ID, platformForProvider } from '../platform-map.ts'
