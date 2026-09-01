export interface Migration {
  readonly version: number
  readonly name: string
  readonly statements: ReadonlyArray<string>
}

export const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "canonical-model",
    statements: [
      `CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      )`,
      `CREATE TABLE record_labels (
        record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (record_id, label_id)
      )`,
      `CREATE INDEX idx_record_labels_label_id ON record_labels(label_id, record_id)`,
      `CREATE INDEX idx_record_labels_record_id ON record_labels(record_id)`,
      `CREATE TABLE relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        source_id INTEGER NOT NULL REFERENCES records(id),
        target_id INTEGER NOT NULL REFERENCES records(id),
        type TEXT NOT NULL,
        properties TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_relationships_source ON relationships(source_id)`,
      `CREATE INDEX idx_relationships_target ON relationships(target_id)`,
      `CREATE INDEX idx_relationships_source_type ON relationships(source_id, type)`,
      `CREATE INDEX idx_relationships_target_type ON relationships(target_id, type)`,
      `CREATE TABLE vectors (
        record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
        namespace TEXT NOT NULL DEFAULT 'default',
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (record_id, namespace)
      )`,
      `CREATE INDEX idx_vectors_namespace ON vectors(namespace)`,
      `CREATE TABLE schema_catalog (
        label TEXT NOT NULL,
        property TEXT NOT NULL,
        inferred_type TEXT NOT NULL,
        observations INTEGER NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (label, property)
      )`
    ]
  }
]

export const CURRENT_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
