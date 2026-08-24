# 0010 — Database safety boundary

## Decision

OpenVoxel uses four explicit database ownership layers.

`@velarscript-labs/database` owns the engine-neutral operation boundary. It
keeps trusted SQL grammar and runtime values structurally separate, renders
driver-selected placeholders, validates returned rows, and enforces operation
cardinality. A runtime value may enter a statement only through
`sqlParameter`, `sqlTuple`, `sqlRows`, or the values side of
`trustedSqlTemplate`.

`@velarscript-labs/sql` is the optional convenience layer. It owns reusable,
common DML composition: checked table/column identifiers, select projections,
joins, predicates, ordering, pagination, inserts, updates, and deletes. It
still produces opaque `DatabaseStatement`, `DatabaseQuery`, and
`DatabaseCommand` values; it does not execute SQL or own application tables.

`@velarscript-labs/sqlite` owns SQLite-specific execution and security. It
quotes runtime-selected identifiers and non-bindable literals, parses exactly
one SQLite statement, binds values through prepared statements, applies
connection limits, and configures defensive mode, extension policy, attached
database policy, concurrency, transactions, and cleanup.

OpenVoxel owns its schema, migrations, dialect-specific SQL grammar, row
contracts, and business meaning. Those are product rules and do not move into
Labs. Common DML uses `@velarscript-labs/sql`; source-authored DDL, PRAGMA, and
SQLite conflict clauses use the lower structured statement API. Request,
configuration, and persisted values always use bound value APIs.

## Consequences

- A value such as `'); DROP TABLE worlds; --` remains a bound value and cannot
  change statement structure.
- Dynamic chunk row lists use `sqlTupleIn`; they do not construct placeholder
  text.
- Updates and deletes require an explicit predicate; an intentional unfiltered
  write is visible as `sqlAllRows()`.
- Common DML table and column names use `sqlTable` and `sqlColumn`;
  SQLite-only grammar positions use `sqliteIdentifier`. Identifiers cannot use
  ordinary value binding.
- Schema defaults and PRAGMA assignments use `sqliteLiteral` only because those
  grammar positions do not accept bound parameters.
- Raw placeholders, multiple statements, trailing statements, attached
  databases, and extension loading fail at the SQLite adapter boundary.
- Labs remains reusable and contains no OpenVoxel tables, migrations, entities,
  block rules, or world-store behavior.
