/** 与后端 append-only event log 对齐的类型定义（字段 snake_case）。 */

export type TaskState =
  | 'patrolling' // 巡逻中
  | 'triaging' // 分诊中
  | 'fixing' // 修复中
  | 'review' // 待审阅
  | 'merged' // 已合并
  | 'killed' // 已熔断（终态，不在五态流转内）

export const RUNNING_STATES: TaskState[] = ['patrolling', 'triaging', 'fixing']

export const STATE_LABEL: Record<TaskState, string> = {
  patrolling: '巡逻中',
  triaging: '分诊中',
  fixing: '修复中',
  review: '待审阅',
  merged: '已合并',
  killed: '已熔断',
}

export type EventType =
  | 'status'
  | 'command'
  | 'stdout'
  | 'stderr'
  | 'edit'
  | 'test'
  | 'done'
  | 'interject'

export interface MuttEvent {
  event_id: string
  task_id: string
  seq: number
  type: EventType
  timestamp: string // ISO 8601
  payload: Record<string, any>
}

export interface Verification {
  tests_passed: number
  tests_total: number
  /** null = 真跑模式下 mutmut 不可用，该项跳过 */
  mutation_score: number | null
  mutation_not_decreased: boolean
  test_files_modified: boolean
}

export interface FileDiff {
  file_path: string
  summary: string
  diff: string // unified diff
}

export interface MuttTask {
  task_id: string
  title: string
  state: TaskState
  created_at: string
  updated_at: string
  verification: Verification | null
  diffs: FileDiff[]
  pr_url: string | null
  round: number
}

/** WS 下行消息 */
export type WsMessage =
  | { kind: 'snapshot'; tasks: MuttTask[] }
  | { kind: 'event'; event: MuttEvent }
  | { kind: 'task'; task: MuttTask }

/** 机器验收门槛：三项全绿才可批准合并 */
export function verificationGates(v: Verification | null) {
  const gates = [
    {
      key: 'tests',
      label: v ? `测试 ${v.tests_passed}/${v.tests_total} 通过` : '测试未运行',
      ok: !!v && v.tests_total > 0 && v.tests_passed === v.tests_total,
    },
    {
      key: 'mutation',
      label: !v
        ? '变异分未知'
        : v.mutation_score === null
          ? '变异分 未运行（跳过）'
          : `变异分 ${v.mutation_score}%（${v.mutation_not_decreased ? '未降' : '已降'}）`,
      ok: !!v && v.mutation_not_decreased,
    },
    {
      key: 'test_files',
      label: v ? (v.test_files_modified ? '测试文件被修改' : '测试文件未被修改') : '测试文件状态未知',
      ok: !!v && !v.test_files_modified,
    },
  ]
  return { gates, allGreen: gates.every((g) => g.ok), missing: gates.filter((g) => !g.ok) }
}
