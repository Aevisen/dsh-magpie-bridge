/**
 * 网关存活探测（仅用于日志诊断，不作为启动开关）。
 * @module dsh-magpie-bridge/gateway
 */
/** 探测 `<baseURL>/api/hello`，失败再退到 `/v1/models`。 */
export async function probeGateway(
  baseURL: string,
  timeoutMs = 3000,
): Promise<{ reachable: boolean; version?: string }> {
  const base = baseURL.replace(/\/+$/u, '')

  try {
    const response = await fetch(`${base}/api/hello`, { signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok) {
      const text = await response.text()
      let version: string | undefined
      try {
        const json = JSON.parse(text) as { version?: unknown }
        if (typeof json.version === 'string') version = json.version
      } catch {
        /* 非 JSON 也算在线 */
      }
      return { reachable: true, version }
    }
  } catch {
    /* 落到 /v1/models */
  }

  try {
    const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok) return { reachable: true }
  } catch {
    /* 离线 */
  }

  return { reachable: false }
}
