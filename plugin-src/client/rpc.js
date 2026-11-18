/**
 * 面板 RPC 客户端：走宿主连接层的通用 RPC 通道。
 *
 * `connection.rpc.call(channel, endpoint, payload)` 由宿主
 * `connection.rpc.handle(channel, handler)` 接手；连接层负责鉴权、rpcId
 * 与响应信封，这里只做一次解包。
 * @module dsh-magpie-bridge/client/rpc
 */

/** 宿主注册的通道（绝对路径）。 */
export const PANEL_CHANNEL = '/api/magpie-bridge'

/**
 * 解开连接层的结果信封。
 *
 * @throws 服务端失败时抛出其 message；信封畸形时抛 'invalid server-response result'。
 */
export function unwrapRpcResult(result) {
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
    if (result.ok === true) return result.value
    const error = result.error
    throw new Error((error && error.message) || 'magpie 面板请求失败')
  }
  throw new Error('invalid server-response result')
}

/**
 * 调用一个面板方法。
 *
 * @param connection - 客户端 connection 服务（每次调用重新取，连接可能重连）。
 * @param method - 'web.url' | 'web.dockUrl'。
 * @param payload - 额外负载（当前未用）。
 * @param signal - 取消信号。
 */
export async function callMagpieRpc(connection, method, payload, signal) {
  if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') {
    throw new Error('connection.rpc 不可用')
  }
  const result = await connection.rpc.call(PANEL_CHANNEL, method, payload ?? {}, signal)
  return unwrapRpcResult(result)
}
