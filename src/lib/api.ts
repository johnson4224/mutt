/** REST 客户端 + 相对时间工具。
 *  静态部署（无后端）时自动切换到 localEngine，接口保持不变。 */
import type { MuttEvent, MuttTask } from '@/types/events'
import { localEngine } from '@/lib/localEngine'

let localMode = false
export function setLocalMode(v: boolean) {
  localMode = v
}
export function isLocalMode() {
  return localMode
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      const body = await res.json()
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body)
    } catch {
      /* ignore */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const api = {
  listTasks: async (): Promise<{ tasks: MuttTask[] }> =>
    localMode ? { tasks: localEngine.listTasks() } : req('/api/tasks'),
  createTask: async (
    text: string,
    apiKey?: string,
    ghToken?: string,
  ): Promise<{ task: MuttTask }> =>
    localMode
      ? localEngine.createTask(text)
      : req('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            text,
            ...(apiKey ? { api_key: apiKey } : {}),
            ...(ghToken ? { gh_token: ghToken } : {}),
          }),
        }),
  taskEvents: async (taskId: string, afterSeq = 0): Promise<{ events: MuttEvent[] }> =>
    localMode
      ? { events: localEngine.taskEvents(taskId, afterSeq) }
      : req(`/api/tasks/${taskId}/events?after_seq=${afterSeq}`),
  interject: async (taskId: string, text: string): Promise<{ ok: boolean }> =>
    localMode
      ? localEngine.interject(taskId, text)
      : req(`/api/tasks/${taskId}/interject`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        }),
  review: async (
    taskId: string,
    action: 'approve' | 'redo' | 'kill',
  ): Promise<{ task: MuttTask }> =>
    localMode
      ? localEngine.review(taskId, action)
      : req(`/api/tasks/${taskId}/review`, {
          method: 'POST',
          body: JSON.stringify({ action }),
        }),
}

export function relTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000))
  if (s < 5) return '刚刚'
  if (s < 60) return `${s}s 前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m 前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h 前`
  return `${Math.floor(h / 24)}d 前`
}
