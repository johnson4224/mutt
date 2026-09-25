/** 纯浏览器本地引擎：静态部署（无后端）时接管全部数据流。
 *
 *  与 server/ 后端行为一一对应：同一事件 schema（snake_case）、同一剧本、
 *  同一验收门槛与状态机。区别只是事件不再经过 WebSocket，而是直接在本页
 *  内存里产生并广播。任务不持久化——刷新页面即重置（演示用途）。 */
import type { MuttEvent, MuttTask, TaskState, Verification, WsMessage } from '@/types/events'

const RUNNING: TaskState[] = ['patrolling', 'triaging', 'fixing']

/* ------------------------- 剧本素材（与 server/simulator.py 一致） ------------------------- */

const DIFF_TRIAGE = `--- a/src/mutt/triage.py
+++ b/src/mutt/triage.py
@@ -41,7 +41,10 @@ class TriageResult:
 def classify_failure(output: str) -> FailureKind:
-    if "AssertionError" in output:
-        return FailureKind.ASSERTION
-    return FailureKind.UNKNOWN
+    lowered = output.lower()
+    if "assertionerror" in lowered:
+        return FailureKind.ASSERTION
+    if "modulenotfounderror" in lowered or "importerror" in lowered:
+        return FailureKind.MISSING_DEP
+    if "timeout" in lowered:
+        return FailureKind.FLAKY
+    return FailureKind.UNKNOWN
@@ -58,3 +61,6 @@ def rank_causes(kinds: list[FailureKind]) -> list[FailureKind]:
-    return sorted(set(kinds))
+    order = {FailureKind.MISSING_DEP: 0, FailureKind.ASSERTION: 1,
+             FailureKind.FLAKY: 2, FailureKind.UNKNOWN: 3}
+    return sorted(set(kinds), key=lambda k: order[k])
`

const DIFF_RUNNER = `--- a/src/mutt/runner.py
+++ b/src/mutt/runner.py
@@ -12,9 +12,13 @@ async def run_pipeline(repo: str, budget_s: int = 600):
     sandbox = await Sandbox.create(repo)
-    result = await sandbox.exec("pytest -x -q")
-    if result.exit_code != 0:
-        report = triage(result.stderr)
-        patch = propose_patch(report)
-        await sandbox.apply(patch)
+    try:
+        result = await sandbox.exec("pytest -x -q", timeout=budget_s)
+        if result.exit_code != 0:
+            report = triage(result.stderr)
+            patch = propose_patch(report)
+            await sandbox.apply(patch)
+            await sandbox.exec("pytest -q", timeout=budget_s)
+    finally:
+        await sandbox.teardown()
     return report
`

const STDOUT_BOOT = [
  "Cloning into '/tmp/mutt/work/repo'...",
  'remote: Enumerating objects: 1482, done.',
  'remote: Counting objects: 100% (1482/1482), done.',
  'Checking connectivity... done.',
  'HEAD is now at 9f31ac2 fix: retry transient sandbox errors',
]

const STDERR_FAIL = [
  '=================================== FAILURES ===================================',
  '____________________ test_classify_failure_missing_dep _____________________',
  '',
  '    def test_classify_failure_missing_dep():',
  ">       assert classify_failure('ModuleNotFoundError: No module named \\'yaml\\'') == FailureKind.MISSING_DEP",
  'E       AssertionError: assert <FailureKind.UNKNOWN: 99> == <FailureKind.MISSING_DEP: 2>',
  '',
  'src/mutt/triage.py:44: AssertionError',
  '=========================== short test summary info ============================',
  'FAILED tests/test_triage.py::test_classify_failure_missing_dep - AssertionError',
  '!!!!!!!!!!!!!!!!!!!!!! stopping after 1 failures !!!!!!!!!!!!!!!!!!!!!!!',
  '1 failed, 86 passed in 4.12s',
]

const STDOUT_PASS = [
  '................................................................................',
  '................................................................................',
  '87 passed in 5.43s',
  '',
  'mutmut run --paths-to-mutate src/mutt/triage.py',
  '- Mutation testing summary -',
  'killed: 41, survived: 4, timeout: 0, suspicious: 0',
  'mutation score: 91%',
]

/* --------------------------------- 引擎核心 --------------------------------- */

type Listener = (msg: WsMessage) => void

let seq = 0
let taskN = 0
let started = false
const tasks = new Map<string, MuttTask>()
const eventsByTask = new Map<string, MuttEvent[]>()
const listeners = new Set<Listener>()

const nowIso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const cloneTask = (t: MuttTask): MuttTask => ({ ...t, diffs: t.diffs.map((d) => ({ ...d })) })

function emit(msg: WsMessage) {
  for (const cb of [...listeners]) {
    try {
      cb(msg)
    } catch {
      /* listener 异常不影响引擎 */
    }
  }
}

function touchTask(task: MuttTask) {
  task.updated_at = nowIso()
  emit({ kind: 'task', task: cloneTask(task) })
}

function append(taskId: string, type: MuttEvent['type'], payload: Record<string, unknown>) {
  const task = tasks.get(taskId)
  if (!task) return
  seq += 1
  const event: MuttEvent = {
    event_id: `evt_${String(seq).padStart(6, '0')}`,
    task_id: taskId,
    seq,
    type,
    timestamp: nowIso(),
    payload,
  }
  const list = eventsByTask.get(taskId) ?? []
  list.push(event)
  eventsByTask.set(taskId, list)
  if (type === 'status') task.state = payload.to_state as TaskState
  emit({ kind: 'event', event })
  if (type === 'status') touchTask(task)
}

function newTask(title: string): MuttTask {
  taskN += 1
  const t = nowIso()
  const task: MuttTask = {
    task_id: `tsk_${String(taskN).padStart(4, '0')}`,
    title: title.trim() || '未命名任务',
    state: 'patrolling',
    created_at: t,
    updated_at: t,
    verification: null,
    diffs: [],
    pr_url: null,
    round: 0,
  }
  tasks.set(task.task_id, task)
  eventsByTask.set(task.task_id, [])
  emit({ kind: 'task', task: cloneTask(task) })
  return task
}

const killed = (task: MuttTask) => task.state === 'killed'

async function emitOut(
  taskId: string,
  lines: string[],
  stream: 'stdout' | 'stderr' = 'stdout',
  delay = 280,
) {
  for (const ln of lines) {
    const task = tasks.get(taskId)
    if (!task || killed(task)) return
    append(taskId, stream, { text: ln })
    await sleep(delay)
  }
}

/** 一轮修复：改代码 → 跑测试 → 进待审阅。第 1 轮故意变异分下降，让批准门保持红。 */
async function runFixRound(task: MuttTask, roundNo: number) {
  task.round = roundNo
  touchTask(task)

  append(task.task_id, 'command', { cmd: 'pytest -x -q', cwd: '/tmp/mutt/work/repo' })
  await emitOut(task.task_id, STDERR_FAIL, 'stderr', 160)
  if (killed(task)) return

  append(task.task_id, 'status', { from_state: task.state, to_state: 'fixing' })
  append(task.task_id, 'edit', {
    file_path: 'src/mutt/triage.py',
    summary: 'classify_failure 支持大小写不敏感匹配，新增 MISSING_DEP / FLAKY 分类',
    diff: DIFF_TRIAGE,
  })
  await sleep(600)
  append(task.task_id, 'edit', {
    file_path: 'src/mutt/runner.py',
    summary: 'pipeline 增加 try/finally 沙箱回收，补丁后复跑全量测试',
    diff: DIFF_RUNNER,
  })
  await sleep(800)
  if (killed(task)) return

  append(task.task_id, 'command', { cmd: 'pytest -q && mutmut run', cwd: '/tmp/mutt/work/repo' })
  await emitOut(task.task_id, STDOUT_PASS, 'stdout', 200)
  if (killed(task)) return

  const regression = roundNo === 1
  const verification: Verification = {
    tests_passed: 87,
    tests_total: 87,
    mutation_score: 91,
    mutation_not_decreased: !regression,
    test_files_modified: false,
  }
  task.verification = verification
  task.diffs = [
    { file_path: 'src/mutt/triage.py', summary: 'classify_failure 分类修复', diff: DIFF_TRIAGE },
    { file_path: 'src/mutt/runner.py', summary: 'runner 沙箱回收与复跑', diff: DIFF_RUNNER },
  ]
  touchTask(task)
  append(task.task_id, 'test', {
    suite: 'pytest + mutmut',
    passed: 87,
    failed: 0,
    total: 87,
    mutation_score: 91,
    mutation_not_decreased: !regression,
    test_files_modified: false,
  })
  append(task.task_id, 'status', { from_state: 'fixing', to_state: 'review' })
}

/** 完整巡逻生命周期。 */
async function runTask(task: MuttTask) {
  append(task.task_id, 'status', { from_state: null, to_state: 'patrolling' })
  append(task.task_id, 'command', {
    cmd: 'git clone https://github.com/acme/payments.git /tmp/mutt/work/repo',
    cwd: '/tmp/mutt/work',
  })
  await emitOut(task.task_id, STDOUT_BOOT, 'stdout', 220)
  append(task.task_id, 'command', {
    cmd: 'git log --oneline -3 && git status -sb',
    cwd: '/tmp/mutt/work/repo',
  })
  await emitOut(
    task.task_id,
    [
      '9f31ac2 fix: retry transient sandbox errors',
      'b02e71d chore: bump pytest to 8.3',
      '4ca90ef feat: add FailureKind enum',
      '## main...origin/main',
    ],
    'stdout',
    150,
  )
  if (killed(task)) return

  append(task.task_id, 'status', { from_state: 'patrolling', to_state: 'triaging' })
  append(task.task_id, 'stdout', { text: '[mutt] 进入分诊：复现失败、定位根因、评估修复预算' })
  await runFixRound(task, 1)
}

/** 种子：一条已合并的历史任务（同步追加，立即出现）。 */
function seed() {
  const hist = newTask('修复 CI 里 payments 模块的 ImportError')
  append(hist.task_id, 'status', { from_state: null, to_state: 'patrolling' })
  append(hist.task_id, 'command', { cmd: 'git clone …/payments.git', cwd: '/tmp/mutt/work' })
  append(hist.task_id, 'status', { from_state: 'patrolling', to_state: 'triaging' })
  append(hist.task_id, 'status', { from_state: 'triaging', to_state: 'fixing' })
  append(hist.task_id, 'edit', {
    file_path: 'src/payments/__init__.py',
    summary: '补全缺失的懒加载导入',
    diff: `--- a/src/payments/__init__.py
+++ b/src/payments/__init__.py
@@ -1,2 +1,3 @@
 from .core import charge
+from .receipts import issue_receipt
`,
  })
  hist.verification = {
    tests_passed: 87,
    tests_total: 87,
    mutation_score: 91,
    mutation_not_decreased: true,
    test_files_modified: false,
  }
  append(hist.task_id, 'test', {
    suite: 'pytest + mutmut',
    passed: 87,
    failed: 0,
    total: 87,
    mutation_score: 91,
    mutation_not_decreased: true,
    test_files_modified: false,
  })
  append(hist.task_id, 'status', { from_state: 'fixing', to_state: 'review' })
  append(hist.task_id, 'status', { from_state: 'review', to_state: 'merged' })
  hist.pr_url = 'https://github.com/acme/payments/pull/482'
  append(hist.task_id, 'done', { summary: 'PR #482 已合并', pr_url: hist.pr_url })
  touchTask(hist)
}

function listTasks(): MuttTask[] {
  return [...tasks.values()]
    .sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || b.task_id.localeCompare(a.task_id),
    )
    .map(cloneTask)
}

export const localEngine = {
  /** 订阅事件流；首次调用时播种历史 + 自动演示任务。返回退订函数。 */
  start(onMsg: Listener): () => void {
    listeners.add(onMsg)
    if (!started) {
      started = true
      seed()
      void runTask(newTask('pytest 挂了，去修好（演示任务，自动开始）'))
    }
    onMsg({ kind: 'snapshot', tasks: listTasks() })
    return () => {
      listeners.delete(onMsg)
    }
  },

  listTasks,

  taskEvents(taskId: string, afterSeq = 0): MuttEvent[] {
    return (eventsByTask.get(taskId) ?? []).filter((e) => e.seq > afterSeq)
  },

  createTask(text: string): { task: MuttTask } {
    const task = newTask(text)
    void runTask(task)
    return { task: cloneTask(task) }
  },

  interject(taskId: string, text: string): { ok: boolean } {
    const task = tasks.get(taskId)
    if (!task) throw new Error('task not found')
    if (!RUNNING.includes(task.state))
      throw new Error(`task is ${task.state}, interject only while running`)
    const t = text.trim()
    if (!t) throw new Error('text must not be empty')
    append(taskId, 'interject', { author: 'you', text: t })
    append(taskId, 'stdout', { text: `[mutt] 收到插嘴：「${t}」（本地演示，仅记录）` })
    return { ok: true }
  },

  review(taskId: string, action: 'approve' | 'redo' | 'kill'): { task: MuttTask } {
    const task = tasks.get(taskId)
    if (!task) throw new Error('task not found')

    if (action === 'kill') {
      if (task.state === 'merged' || task.state === 'killed')
        throw new Error(`task already ${task.state}`)
      append(taskId, 'status', { from_state: task.state, to_state: 'killed' })
      append(taskId, 'done', { summary: '已熔断终止，工作区已回收', pr_url: null })
      return { task: cloneTask(task) }
    }

    if (task.state !== 'review')
      throw new Error(`task is ${task.state}, review action needs state=review`)

    if (action === 'approve') {
      const v = task.verification
      const missing: string[] = []
      if (!(v && v.tests_total > 0 && v.tests_passed === v.tests_total)) missing.push('测试未全通过')
      if (!v?.mutation_not_decreased) missing.push('变异分下降')
      if (v?.test_files_modified) missing.push('测试文件被修改')
      if (missing.length) throw new Error(`机器验收未全绿：${missing.join('、')}`)
      task.pr_url = `https://github.com/acme/payments/pull/${483 + task.round}`
      append(taskId, 'status', { from_state: 'review', to_state: 'merged' })
      append(taskId, 'done', { summary: `PR 已合并：${task.pr_url}`, pr_url: task.pr_url })
      touchTask(task)
      return { task: cloneTask(task) }
    }

    // redo：回到修复阶段再跑一轮（第 2 轮起验收全绿）
    append(taskId, 'interject', { author: 'you', text: '要求重做：回到修复阶段' })
    void runFixRound(task, task.round + 1)
    return { task: cloneTask(task) }
  },
}
