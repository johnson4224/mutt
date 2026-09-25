import { useState } from 'react'
import { PanelLeft, PanelRight, X } from 'lucide-react'
import { useMuttStore } from '@/hooks/useMuttStore'
import { TaskSidebar } from '@/sections/TaskSidebar'
import { EventStream } from '@/sections/EventStream'
import { ReviewPanel } from '@/sections/ReviewPanel'
import { cn } from '@/lib/utils'

function WsDot({ status }: { status: 'connecting' | 'open' | 'closed' | 'local' }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          (status === 'open' || status === 'local') && 'bg-emerald-400',
          status === 'connecting' && 'bg-amber-400 animate-pulse',
          status === 'closed' && 'bg-red-500',
        )}
      />
      {status === 'open'
        ? '已连接'
        : status === 'local'
          ? '本地演示引擎'
          : status === 'connecting'
            ? '连接中'
            : '重连中'}
    </span>
  )
}

export default function App() {
  const {
    tasks, selected, selectedId, setSelectedId, events, wsStatus, mode, online,
    llmKey, setLlmKey, ghToken, setGhToken,
  } = useMuttStore()
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* 顶栏 */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <button
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 lg:hidden"
          onClick={() => setLeftOpen(true)}
          aria-label="任务列表"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <span className="font-mono text-sm font-semibold tracking-tight text-zinc-100">mutt</span>
        <span className="text-[11px] text-zinc-600">自主代码巡检控制台</span>
        <span
          className={cn(
            'rounded border px-1.5 py-0.5 text-[10px]',
            mode === 'live'
              ? 'border-emerald-800 text-emerald-400'
              : 'border-zinc-700 text-zinc-500',
          )}
          title={
            online === false
              ? '静态演示版：无后端，任务全流程在你的浏览器内模拟运行'
              : mode === 'live'
                ? '已接 DeepSeek，真跑测试与补丁'
                : '未配置 key，剧本演示（左栏粘贴 DeepSeek key 即可真跑）'
          }
        >
          {online === false ? '本地演示' : mode === 'live' ? 'LIVE · DeepSeek' : '模拟模式'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <WsDot status={wsStatus} />
          <button
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 xl:hidden"
            onClick={() => setRightOpen(true)}
            aria-label="验收面板"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* 三栏主体 */}
      <main className="flex min-h-0 flex-1">
        {/* 左栏：任务与历史 */}
        <aside className="hidden w-[300px] shrink-0 border-r border-border lg:block">
          <TaskSidebar
            tasks={tasks}
            selectedId={selectedId}
            onSelect={setSelectedId}
            llmKey={llmKey}
            onKeyChange={setLlmKey}
            ghToken={ghToken}
            onGhTokenChange={setGhToken}
            online={online !== false}
          />
        </aside>

        {/* 中栏：实时轨迹流（核心，窄屏优先） */}
        <section className="min-w-0 flex-1">
          <EventStream task={selected} events={events} />
        </section>

        {/* 右栏：验收（≥1280px 常驻，窄屏为抽屉） */}
        <aside className="hidden w-[420px] shrink-0 border-l border-border xl:block">
          <ReviewPanel task={selected} />
        </aside>
      </main>

      {/* 窄屏：左栏抽屉 */}
      {leftOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setLeftOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[300px] border-r border-border bg-zinc-950">
            <div className="flex h-11 items-center justify-between border-b border-border px-3">
              <span className="text-xs text-zinc-400">任务与历史</span>
              <button onClick={() => setLeftOpen(false)} aria-label="关闭">
                <X className="h-4 w-4 text-zinc-400" />
              </button>
            </div>
            <div className="h-[calc(100%-2.75rem)]">
              <TaskSidebar
                tasks={tasks}
                selectedId={selectedId}
                llmKey={llmKey}
                onKeyChange={setLlmKey}
                ghToken={ghToken}
                onGhTokenChange={setGhToken}
                online={online !== false}
                onSelect={(id) => {
                  setSelectedId(id)
                  setLeftOpen(false)
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 窄屏：右栏验收抽屉 */}
      {rightOpen && (
        <div className="fixed inset-0 z-40 xl:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setRightOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-[min(440px,100vw)] border-l border-border bg-zinc-950">
            <div className="flex h-11 items-center justify-between border-b border-border px-3">
              <span className="text-xs text-zinc-400">验收</span>
              <button onClick={() => setRightOpen(false)} aria-label="关闭">
                <X className="h-4 w-4 text-zinc-400" />
              </button>
            </div>
            <div className="h-[calc(100%-2.75rem)]">
              <ReviewPanel task={selected} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
