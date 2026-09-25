import { useState } from 'react'
import { CheckCircle2, CircleSlash, Eye, KeyRound, Loader2 } from 'lucide-react'
import { api, relTime } from '@/lib/api'
import { RUNNING_STATES, STATE_LABEL, type MuttTask, type TaskState } from '@/types/events'
import { cn } from '@/lib/utils'

function StateBadge({ state }: { state: TaskState }) {
  if (RUNNING_STATES.includes(state)) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-sky-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        {STATE_LABEL[state]}
      </span>
    )
  }
  if (state === 'review') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
        <Eye className="h-3 w-3" />
        待审阅
      </span>
    )
  }
  if (state === 'merged') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        已合并
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
      <CircleSlash className="h-3 w-3" />
      已熔断
    </span>
  )
}

export function TaskSidebar({
  tasks,
  selectedId,
  onSelect,
  llmKey,
  onKeyChange,
  ghToken,
  onGhTokenChange,
  online = true,
}: {
  tasks: MuttTask[]
  selectedId: string | null
  onSelect: (id: string) => void
  llmKey: string
  onKeyChange: (k: string) => void
  ghToken: string
  onGhTokenChange: (k: string) => void
  /** false = 静态演示版（无后端），key 无处可发 */
  online?: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)

  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      const { task } = await api.createTask(t, llmKey || undefined, ghToken || undefined)
      setText('')
      onSelect(task.task_id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={3}
          placeholder={'pytest 挂了，去修好\n（可附 GitHub 仓库地址；不附则用内置演示仓库）'}
          className="w-full resize-none rounded-md border border-input bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-600"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          className="mt-2 w-full rounded-md bg-zinc-100 px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          派出 mutt
        </button>

        {/* BYOK：自带 DeepSeek key，只存在本浏览器（需要后端；静态演示版不可用） */}
        {online ? (
          <>
            <button
              onClick={() => setKeyOpen((v) => !v)}
              className="mt-2 flex w-full items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              <KeyRound className="h-3 w-3" />
              {llmKey ? 'DeepSeek key 已配置（真跑模式）' : '配置 DeepSeek key 启用真跑'}
              <span className="ml-auto">{keyOpen ? '−' : '+'}</span>
            </button>
            {keyOpen && (
              <div className="mt-1.5 space-y-1.5">
                <input
                  type="password"
                  value={llmKey}
                  onChange={(e) => onKeyChange(e.target.value)}
                  placeholder="DeepSeek key（sk-...）"
                  autoComplete="off"
                  className="w-full rounded-md border border-input bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
                />
                <input
                  type="password"
                  value={ghToken}
                  onChange={(e) => onGhTokenChange(e.target.value)}
                  placeholder="GitHub token（ghp_...，可选）"
                  autoComplete="off"
                  className="w-full rounded-md border border-input bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
                />
                <p className="text-[10px] leading-snug text-zinc-600">
                  两个 key 都只保存在你自己的浏览器里，建任务时随请求发给后端，不落服务端、不进代码。
                  配了 GitHub token 后，批准合并会真推分支并开出 PR；不配则只在本地 git 合并。
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">
            本地演示版：没有后端，全部流程在浏览器里模拟；演示不需要任何 key。
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 && (
          <p className="p-4 text-xs text-zinc-500">暂无任务。贴一段报错，或一句话派活。</p>
        )}
        {tasks.map((t) => (
          <button
            key={t.task_id}
            onClick={() => onSelect(t.task_id)}
            className={cn(
              'block w-full border-b border-border/60 px-3 py-2.5 text-left hover:bg-zinc-900',
              t.task_id === selectedId && 'bg-zinc-900',
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <StateBadge state={t.state} />
              <span className="shrink-0 text-[11px] text-zinc-500">{relTime(t.updated_at)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-zinc-200">{t.title}</p>
            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{t.task_id}</p>
          </button>
        ))}
      </div>
    </div>
  )
}
