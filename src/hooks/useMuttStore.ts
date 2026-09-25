/** 全局数据层：优先连后端（WebSocket 事件流）；探测不到后端（静态部署）时
 *  自动切换到浏览器内本地引擎，界面与交互完全一致。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, setLocalMode } from '@/lib/api'
import { localEngine } from '@/lib/localEngine'
import type { MuttEvent, MuttTask, WsMessage } from '@/types/events'

export type WsStatus = 'connecting' | 'open' | 'closed' | 'local'

/** 探测后端是否存在。静态托管的 SPA 回退会让 /api/status 返回 HTML，
 *  json() 解析失败即判定无后端。 */
async function probeBackend(): Promise<'live' | 'sim' | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 2500)
    const res = await fetch('/api/status', { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const d = await res.json()
    if (d?.mode === 'live') return 'live'
    if (d?.mode === 'sim') return 'sim'
    return null
  } catch {
    return null
  }
}

export function useMuttStore() {
  const [tasks, setTasks] = useState<MuttTask[]>([])
  const [eventsByTask, setEventsByTask] = useState<Record<string, MuttEvent[]>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting')
  const [serverMode, setServerMode] = useState<'live' | 'sim'>('sim')
  // online: null=探测中，true=有后端，false=纯浏览器本地引擎
  const [online, setOnline] = useState<boolean | null>(null)
  // BYOK：key 只存在用户自己的浏览器 localStorage，随建任务请求发送
  const [llmKey, setLlmKeyState] = useState<string>(() => localStorage.getItem('mutt_llm_key') ?? '')
  const setLlmKey = useCallback((k: string) => {
    const v = k.trim()
    setLlmKeyState(v)
    if (v) localStorage.setItem('mutt_llm_key', v)
    else localStorage.removeItem('mutt_llm_key')
  }, [])
  // BYOK GitHub token：批准后真推分支、真开 PR
  const [ghToken, setGhTokenState] = useState<string>(() => localStorage.getItem('mutt_gh_token') ?? '')
  const setGhToken = useCallback((k: string) => {
    const v = k.trim()
    setGhTokenState(v)
    if (v) localStorage.setItem('mutt_gh_token', v)
    else localStorage.removeItem('mutt_gh_token')
  }, [])
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  // 运行模式：live = 有后端且（服务端配了 key 或用户 BYOK），其余皆为剧本演示
  const mode: 'live' | 'sim' =
    online === true && (serverMode === 'live' || llmKey) ? 'live' : 'sim'

  const upsertTask = useCallback((t: MuttTask) => {
    setTasks((prev) => {
      const i = prev.findIndex((x) => x.task_id === t.task_id)
      if (i === -1) return [t, ...prev]
      const next = prev.slice()
      next[i] = t
      return next
    })
  }, [])

  const appendEvent = useCallback((e: MuttEvent) => {
    setEventsByTask((prev) => {
      const list = prev[e.task_id] ?? []
      if (list.some((x) => x.seq === e.seq)) return prev
      return { ...prev, [e.task_id]: [...list, e].sort((a, b) => a.seq - b.seq) }
    })
  }, [])

  // 连接层：先探测后端，有则 WebSocket（自动重连、指数退避封顶 8s），无则本地引擎
  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | undefined

    const dispatch = (data: WsMessage) => {
      if (data.kind === 'snapshot') setTasks(data.tasks)
      else if (data.kind === 'event') appendEvent(data.event)
      else if (data.kind === 'task') upsertTask(data.task)
    }

    const connectWs = () => {
      let ws: WebSocket | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      let attempt = 0
      let dead = false

      const connect = () => {
        if (dead) return
        setWsStatus('connecting')
        const proto = location.protocol === 'https:' ? 'wss' : 'ws'
        ws = new WebSocket(`${proto}://${location.host}/ws`)
        ws.onopen = () => {
          attempt = 0
          setWsStatus('open')
        }
        ws.onmessage = (msg) => dispatch(JSON.parse(msg.data) as WsMessage)
        ws.onclose = () => {
          if (dead) return
          setWsStatus('closed')
          timer = setTimeout(connect, Math.min(8000, 1000 * 2 ** attempt++))
        }
      }
      connect()
      return () => {
        dead = true
        clearTimeout(timer)
        ws?.close()
      }
    }

    void probeBackend().then((m) => {
      if (disposed) return
      if (m) {
        setOnline(true)
        setServerMode(m)
        setLocalMode(false)
        cleanup = connectWs()
      } else {
        // 静态部署：无后端，全部在浏览器内跑
        setOnline(false)
        setServerMode('sim')
        setLocalMode(true)
        setWsStatus('local')
        cleanup = localEngine.start(dispatch)
      }
    })

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [appendEvent, upsertTask])

  // 选中任务：拉全量事件回放（合并去重），并自动选中最新任务
  useEffect(() => {
    if (!selectedId && tasks.length > 0) setSelectedId(tasks[0].task_id)
  }, [tasks, selectedId])

  useEffect(() => {
    if (!selectedId) return
    api
      .taskEvents(selectedId)
      .then(({ events }) =>
        setEventsByTask((prev) => {
          const merged = new Map<number, MuttEvent>()
          for (const e of [...(prev[selectedId] ?? []), ...events]) merged.set(e.seq, e)
          return { ...prev, [selectedId]: [...merged.values()].sort((a, b) => a.seq - b.seq) }
        }),
      )
      .catch(() => {})
  }, [selectedId])

  const selected = tasks.find((t) => t.task_id === selectedId) ?? null

  return {
    tasks,
    selected,
    selectedId,
    setSelectedId,
    events: selectedId ? (eventsByTask[selectedId] ?? []) : [],
    wsStatus,
    mode,
    online,
    llmKey,
    setLlmKey,
    ghToken,
    setGhToken,
  }
}
