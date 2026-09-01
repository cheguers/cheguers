export interface SqlRow {
  readonly [column: string]: unknown
}

export interface RunInfo {
  readonly changes: number
  readonly lastInsertRowid: number | undefined
}

export interface SqlExecutor {
  readonly all: (
    sql: string,
    ...params: ReadonlyArray<unknown>
  ) => Promise<ReadonlyArray<SqlRow>>
  readonly get: (
    sql: string,
    ...params: ReadonlyArray<unknown>
  ) => Promise<SqlRow | undefined>
  readonly run: (
    sql: string,
    ...params: ReadonlyArray<unknown>
  ) => Promise<RunInfo>
  readonly exec: (sql: string) => Promise<void>
}

export const nowIso = (): string => new Date().toISOString()
