/**
 * dsh-drag-graft-chip-restore — host half.
 * 纯 client 插件：没有 agent 工具、没有状态文件、没有 REST API。
 * host 半只存在是为了满足 DSH bundle 的入口契约；真正的逻辑全在 client.js。
 */
export const name = 'chip-restore'
export function apply(ctx) {
  ctx.logger?.info?.('[chip-restore] host half loaded (client-side token→chip restore)')
}
