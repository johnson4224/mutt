import { useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronsRight,
  FilePenLine,
  FlaskConical,
  MessageSquareText,
  PauseCircle,
} from 'lucide-react'
import { api, relTime } from '@/lib/api'
import { RUNNING_STATES, STATE_LABEL, type MuttEvent, type MuttTask } from '@/types/events'
import { cn } from '@/lib/utils'

/* ------------------------------ 单行事件 ------------------------------ */

function MonoBlock({ text, isErr }: { text: string; isErr?: boolean }) {
  return (
    <pre
      className={cn(
        'mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border px-2 py-1.5 font-mono text-xs leading-relaxed',
        isErr
          ? 'border-red-900/60 bg-red-950/40 text-red-300'
          : 'border-zinc-800 bg-zinc-950 text-zinc-400',
      )}
    >
      {text}
    </pre>
  )
}

function EventRow({
  event,
  expanded,
  onToggle,
  now,
}: {
  event: MuttEvent
  expanded: boolean
  onToggle: () => void
  now: number
}) {
  const p = event.payload
  const time = (
    <span className="ml-auto shrink-0 pl-2 text-[11px] tabular-nums text-zinc-600">
      {relTime(event.timestamp, now)}
    </span>
  )
  const iconCls = 'h-3.5 w-3.5 shrink-0 mt-0.5'

  switch (event.type) {
    case 'command':
      return (
        <div className="flex gap-2 px-3 py-1.5">
          <ChevronsRight className={cn(iconCls, 'text-sky-400')} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline">
              <span className="truncate font-mono text-xs text-zinc-200">
                <span className="text-zinc-500">$ </span>
                {p.cmd}
              </span>
              {time}
            </div>
            {p.cwd && <p className="font-mono text-[10px] text-zinc-600">{p.cwd}</p>}
          </div>
        </div>
      )
    case 'stdout':
    case 'stderr': {
      const isErr = event.type === 'stderr'
      const text: string = p.text ?? ''
      const multi = text.includes('\n')
      return (
        <div className="flex gap-2 px-3 py-1">
          <AlertTriangle className={cn(iconCls, isErr ? 'text-red-400' : 'text-zinc-600')} />
          <div className="min-w-0 flex-1">
            <button
              onClick={onToggle}
              className="flex w-full items-baseline text-left"
              disabled={!multi}
            >
              <span
                className={cn(
                  'truncate font-mono text-xs',
                  isErr ? 'text-red-400' : 'text-zinc-500',
                  multi && 'underline decoration-dotted underline-offset-2',
                )}
              >
                {text.split('\n')[0]}
              </span>
              {multi && (
                <span className="pl-1 text-[10px] text-zinc-600">
                  {expanded ? '收起' : `+${text.split('\n').length - 1} 行`}
                </span>
              )}
              {time}
            </button>
            {expanded && <MonoBlock text={text} isErr={isErr} />}
          </div>
        </div>
      )
    }
    case 'edit':
      return (
        <div className="flex gap-2 px-3 py-1.5">
          <FilePenLine className={cn(iconCls, 'text-violet-400')} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline">
              <span className="truncate font-mono text-xs text-violet-300">{p.file_path}</span>
              {time}
            </div>
            <p className="truncate text-xs text-zinc-400">{p.summary}</p>
          </div>
        </div>
      )
    case 'test':
      return (
        <div className="flex gap-2 px-3 py-1.5">
          <FlaskConical className={cn(iconCls, 'text-emerald-400')} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline">
              <span className="text-xs text-zinc-200">
                {p.suite}：{p.passed}/{p.total} 通过 · 变异分{' '}
                {p.mutation_score === null || p.mutation_score === undefined
                  ? 'N/A'
                  : `${p.mutation_score}%${p.mutation_not_decreased ? '（未降）' : '（已降）'}`}
              </span>
              {time}
            </div>
          </div>
        </div>
      )
    case 'status':
      return (
        <div className="flex items-center gap-2 px-3 py-1.5">
          <ArrowRight className={cn(iconCls, 'text-zinc-500')} />
          <span className="text-xs text-zinc-500">
            {p.from_state ? STATE_LABEL[p.from_state as keyof typeof STATE_LABEL] : '创建'} →{' '}
            <span className="text-zinc-300">{STATE_LABEL[p.to_state as keyof typeof STATE_LABEL]}</span>
          </span>
          {time}
        </div>
      )
    case 'done':
      return (
        <div className="flex gap-2 px-3 py-1.5">
          <CheckCircle2 className={cn(iconCls, 'text-emerald-400')} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline">
              <span className="text-xs font-medium text-emerald-300">{p.summary}</span>
              {time}
            </div>
          </div>
        </div>
      )
    case 'interject':
      return (
        <div className="flex gap-2 px-3 py-1.5">
          <MessageSquareText className={cn(iconCls, 'text-amber-400')} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline">
              <span className="text-xs text-amber-300">
                插嘴：{p.text}
              </span>
              {time}
            </div>
          </div>
        </div>
      )
  }
}

/* ------------------------------ 轨迹流 ------------------------------ */

export function EventStream({ task, events }: { task: MuttTask | null; events: MuttEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(false)
  const [paused, setPaused] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [interject, setInterject] = useState('')
  const [now, setNow] = useState(Date.now())

  // 相对时间刷新
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pausedRef.current = !atBottom
    setPaused(!atBottom)
  }

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    pausedRef.current = false
    setPaused(false)
  }

  // 新事件到达：未暂停则吸底
  useEffect(() => {
    if (!pausedRef.current) scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length])

  // 切任务时复位
  useEffect(() => {
    setExpanded(new Set())
    scrollToBottom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.task_id])

  const running = task ? RUNNING_STATES.includes(task.state) : false

  const sendInterject = async () => {
    const t = interject.trim()
    if (!t || !task || !running) return
    setInterject('')
    await api.interject(task.task_id, t).catch(() => setInterject(t))
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-medium text-zinc-400">实时轨迹流</span>
        {task && (
          <span className="truncate font-mono text-[11px] text-zinc-600">{task.task_id}</span>
        )}
        {paused && (
          <button
            onClick={() => scrollToBottom(true)}
            className="ml-auto inline-flex items-center gap-1 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            <PauseCircle className="h-3 w-3" />
            已暂停滚动 · 回到底部
          </button>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto py-2">
        {!task && <p className="p-4 text-xs text-zinc-500">选择或创建一个任务。</p>}
        {events.map((e) => (
          <EventRow
            key={e.event_id}
            event={e}
            now={now}
            expanded={expanded.has(e.event_id)}
            onToggle={() =>
              setExpanded((prev) => {
                const next = new Set(prev)
                if (next.has(e.event_id)) next.delete(e.event_id)
                else next.add(e.event_id)
                return next
              })
            }
          />
        ))}
        {running && (
          <div className="flex items-center gap-2 px-3 py-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
            <span className="text-[11px] text-zinc-500">mutt 工作中 · {STATE_LABEL[task!.state]}</span>
          </div>
        )}
      </div>

      {/* 输入插嘴 */}
      <div className="shrink-0 border-t border-border p-2">
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border border-input bg-zinc-900 px-2',
            !running && 'opacity-50',
          )}
        >
          <MessageSquareText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            value={interject}
            onChange={(e) => setInterject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendInterject()
            }}
            disabled={!running}
            placeholder={running ? '输入插嘴：随时给 agent 追加指令…' : '任务未在运行，无法插嘴'}
            className="h-9 w-full bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <button
            onClick={() => void sendInterject()}
            disabled={!running || !interject.trim()}
            className="shrink-0 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}
