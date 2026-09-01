import { connect } from "@tursodatabase/database"
import type { Database, Transaction } from "@tursodatabase/database"
import { Context, Effect, Layer } from "effect"
import {
  DatabaseError,
  TransactionError,
  isCheguersError,
  type CheguersError
} from "../errors.js"
import { MIGRATIONS } from "./migrations.js"
import type { SqlExecutor, SqlRow } from "./sql.js"

export class TursoAdapter extends Context.Service<TursoAdapter, TursoAdapterShape>()(
  "cheguers/db/TursoAdapter"
) {}

export interface DatabaseCapabilities {
  /**
   * Whether the embedded engine compiles WITH RECURSIVE. Some embedded Turso
   * builds do not support recursive CTEs yet; callers fall back to equivalent
   * unrolled forms when this is false.
   */
  readonly recursiveCte: boolean
}

export interface TursoAdapterShape {
  readonly transact: <A>(
    f: (tx: SqlExecutor) => Effect.Effect<A, CheguersError>
  ) => Effect.Effect<A, CheguersError>
  readonly close: Effect.Effect<void, DatabaseError>
  readonly capabilities: DatabaseCapabilities
}

const rowsFrom = (promise: Promise<unknown[]>): Promise<ReadonlyArray<SqlRow>> =>
  promise.then((rows) => rows as ReadonlyArray<SqlRow>)

const executorFor = (target: Database | Transaction): SqlExecutor => ({
  all: (sql, ...params) => rowsFrom(target.all(sql, ...params)),
  get: (sql, ...params) =>
    target.get(sql, ...params).then((row) => row as SqlRow | undefined),
  run: (sql, ...params) =>
    target.run(sql, ...params).then((info) => ({
      changes: info.changes,
      lastInsertRowid: info.lastInsertRowid
    })),
  exec: (sql) => target.exec(sql)
})

class ProgramFailure extends Error {
  constructor(readonly error: unknown) {
    super("cheguers-program-failure")
  }
}

const runInTransaction = async <A>(
  db: Database,
  f: (tx: SqlExecutor) => Effect.Effect<A, CheguersError>
): Promise<A> => {
  let result!: A
  await db.transactionAsync(async (txn: Transaction) => {
    try {
      result = await Effect.runPromise(f(executorFor(txn)))
    } catch (error) {
      throw new ProgramFailure(error)
    }
  }).immediate()
  return result
}

const openDatabase = (
  path: string
): Effect.Effect<Database, DatabaseError> =>
  Effect.tryPromise({
    try: () => connect(path),
    catch: (cause) => new DatabaseError({ operation: "open", cause })
  })

const tryDb = <A>(
  operation: string,
  thunk: () => Promise<A>
): Effect.Effect<A, DatabaseError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (cause) => new DatabaseError({ operation, cause })
  })

const RECURSIVE_CTE_PROBE =
  "WITH RECURSIVE probe(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM probe WHERE n < 2) SELECT n FROM probe"

const detectCapabilities = (db: Database): Effect.Effect<DatabaseCapabilities, never> =>
  Effect.gen(function* () {
    const recursiveCte = yield* Effect.promise(async (): Promise<boolean> => {
      try {
        await db.all(RECURSIVE_CTE_PROBE)
        return true
      } catch {
        return false
      }
    })
    return { recursiveCte }
  })

export const migrateDatabase = (  db: Database
): Effect.Effect<number, DatabaseError> =>
  Effect.gen(function* () {
    yield* tryDb("migrate-meta", () =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS _cheguers_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
      )
    )
    const row = yield* tryDb("migrate-read-version", () =>
      db.get("SELECT value FROM _cheguers_meta WHERE key = 'schema_version'")
    ).pipe(Effect.map((r) => r as SqlRow | undefined))
    const appliedVersion = row === undefined ? 0 : Number(row.value)

    for (const migration of MIGRATIONS) {
      if (migration.version <= appliedVersion) continue
      yield* applyMigration(db, migration)
    }
    return MIGRATIONS[MIGRATIONS.length - 1]!.version
  })

interface MigrationLike {
  readonly version: number
  readonly statements: ReadonlyArray<string>
}

const applyMigration = (
  db: Database,
  migration: MigrationLike
): Effect.Effect<void, DatabaseError> =>
  tryDb(`migrate-${migration.version}`, () =>
    db.transactionAsync(async (txn) => {
      for (const statement of migration.statements) {
        await txn.exec(statement)
      }
      await txn.run(
        "INSERT INTO _cheguers_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(migration.version)
      )
    }).immediate()
  )

const makeAdapterFor = (
  db: Database,
  capabilities: DatabaseCapabilities
): TursoAdapterShape => {
  // Transactions are serialized: a single embedded connection cannot host
  // overlapping write transactions, and interleaving them would drop work.
  let chainTail: Promise<void> = Promise.resolve()

  const mapCause = (cause: unknown): CheguersError => {
    if (cause instanceof ProgramFailure && isCheguersError(cause.error)) {
      return cause.error
    }
    if (isCheguersError(cause)) return cause
    return new TransactionError({ operation: "transact", cause })
  }

  return {
    transact: <A>(
      f: (tx: SqlExecutor) => Effect.Effect<A, CheguersError>
    ) =>
      Effect.suspend(() => {
        let releaseTurn!: () => void
        const myTurn = new Promise<void>((resolve) => {
          releaseTurn = resolve
        })
        const previousTail = chainTail
        chainTail = myTurn
        return Effect.tryPromise({
          try: async () => {
            await previousTail
            try {
              return await runInTransaction(db, f)
            } finally {
              releaseTurn()
            }
          },
          catch: mapCause
        })
      }),
    close: tryDb("close", () => db.close()),
    capabilities
  }
}

export const makeTursoAdapter = (
  path: string
): Effect.Effect<TursoAdapterShape, DatabaseError> =>
  Effect.gen(function* () {
    const db = yield* openDatabase(path)
    yield* tryDb("configure", () => db.exec("PRAGMA foreign_keys = ON"))
    yield* migrateDatabase(db)
    const capabilities = yield* detectCapabilities(db)
    return makeAdapterFor(db, capabilities)
  })

export const tursoAdapterLayer = (
  path: string
): Layer.Layer<TursoAdapter, DatabaseError> =>
  Layer.effect(TursoAdapter, makeTursoAdapter(path))
