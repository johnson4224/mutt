import { useState } from 'react'
import { Check, CircleSlash, ExternalLink, RotateCcw } from 'lucide-react'
import { api } from '@/lib/api'
import { diffStats, parseUnifiedDiff, type SideRow } from '@/lib/diff'
import { verificationGates, type FileDiff, type MuttTask } from '@/types/events'
import { cn } from '@/lib/utils'

/* --------------------------- 左右对照 diff --------------------------- */

const CELL_CLS: Record<string, string> = {
  add: 'bg-emerald-950/60 text-emerald-200',
  del: 'bg-red-950/50 text-red-300',
  context: 'text-zinc-400',
  gap: 'bg-zinc-900/60',
}

function Cell({ cell }: { cell: SideRow['left'] }) {
  if (!cell) return null
  return (
    <>
      <span className="select-none border-r border-zinc-800/70 px-1.5 text-right text-zinc-600">
        {cell.no ?? ''}
      </span>
      <span className={cn('whitespace-pre-wrap break-all px-2', CELL_CLS[cell.type])}>
        {cell.text || ' '}
      </span>
    </>
  )
}

function DiffTable({ diff }: { diff: string }) {
  const rows = parseUnifiedDiff(diff)
  return (
    <div className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950 font-mono text-[11px] leading-5">
      <div className="grid min-w-max grid-cols-[2.5rem_1fr_2.5rem_1fr]">
        {rows.map((r, i) =>
          r.raw !== undefined ? (
            <div
              key={i}
              className={cn(
                'col-span-4 px-2 py-0.5',
                r.isHunkHeader ? 'bg-zinc-900 text-sky-400/80' : 'text-zinc-600',
              )}
            >
              {r.raw}
            </div>
          ) : (
            <div key={i} className="contents">
              <Cell cell={r.left} />
              <Cell cell={r.right} />
            </div>
          ),
        )}
      </div>
    </div>
  )
}

/* --------------------------- 机器验收结果行 --------------------------- */

function GateBar({ task }: { task: MuttTask }) {
  const { gates } = verificationGates(task.verification)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5">
      {gates.map((g) => (
        <span
          key={g.key}
          className={cn(
            'inline-flex items-center gap-1 text-[11px]',
            g.ok ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {g.ok ? <Check className="h-3 w-3" /> : <CircleSlash className="h-3 w-3" />}
          {g.label}
        </span>
      ))}
    </div>
  )
}

function FileDiffCard({ task, file }: { task: MuttTask; file: FileDiff }) {
  const stats = diffStats(file.diff)
  return (
    <section className="space-y-1.5">
      <header className="flex items-baseline justify-between gap-2">
        <span className="truncate font-mono text-xs text-zinc-200">{file.file_path}</span>
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-emerald-400">+{stats.added}</span>{' '}
          <span className="text-red-400">-{stats.removed}</span>
        </span>
      </header>
      <p className="text-[11px] text-zinc-500">{file.summary}</p>
      {/* 每个文件 diff 上方的机器验收结果行 */}
      <GateBar task={task} />
      <DiffTable diff={file.diff} />
    </section>
  )
}

/* ------------------------------ 右栏主体 ------------------------------ */

export function ReviewPanel({ task }: { task: MuttTask | null }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (action: 'approve' | 'redo' | 'kill') => {
    if (!task || busy) return
    setBusy(action)
    setError(null)
    try {
      await api.review(task.task_id, action)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-xs text-zinc-500">选中任务后在这里验收。</p>
      </div>
    )
  }

  const { allGreen, missing } = verificationGates(task.verification)

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <span className="text-xs font-medium text-zinc-400">验收</span>
        <span className="ml-auto text-[11px] text-zinc-600">第 {Math.max(task.round, 1)} 轮</span>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {task.state === 'review' && task.diffs.length > 0 ? (
          task.diffs.map((f) => <FileDiffCard key={f.file_path} task={task} file={f} />)
        ) : task.state === 'merged' ? (
          <div className="rounded border border-emerald-900/60 bg-emerald-950/30 p-3">
            <p className="text-sm text-emerald-300">已合并</p>
            {task.pr_url && (
              <a
                href={task.pr_url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-sky-400 hover:underline"
              >
                {task.pr_url}
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        ) : task.state === 'killed' ? (
          <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
            <p className="text-sm text-zinc-400">已熔断终止，工作区已回收。</p>
          </div>
        ) : (
          <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
            <p className="text-sm text-zinc-400">mutt 还在工作，diff 会在进入「待审阅」后出现在这里。</p>
            <p className="mt-1 text-[11px] text-zinc-600">验收是唯一需要人动手的地方。</p>
          </div>
        )}
      </div>

      {/* 操作区 */}
      <div className="shrink-0 space-y-2 border-t border-border p-3">
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {!allGreen && task.state === 'review' && (
          <p className="text-[11px] text-zinc-500">
            批准不可用，缺：{missing.map((m) => m.label).join('；')}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={() => void act('approve')}
            disabled={task.state !== 'review' || !allGreen || busy !== null}
            title={!allGreen ? `缺：${missing.map((m) => m.label).join('；')}` : undefined}
            className="flex-1 rounded-md bg-emerald-500 px-2 py-1.5 text-xs font-medium text-emerald-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-30"
          >
            批准合并
          </button>
          <button
            onClick={() => void act('redo')}
            disabled={task.state !== 'review' || busy !== null}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <RotateCcw className="h-3 w-3" />
            要求重做
          </button>
          <button
            onClick={() => void act('kill')}
            disabled={task.state === 'merged' || task.state === 'killed' || busy !== null}
            className="inline-flex items-center gap-1 rounded-md border border-red-900 px-2.5 py-1.5 text-xs text-red-400 hover:bg-red-950/50 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <CircleSlash className="h-3 w-3" />
            熔断终止
          </button>
        </div>
      </div>
    </div>
  )
}
