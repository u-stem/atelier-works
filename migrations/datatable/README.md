# Data table migrations

Migrations under `main/` are managed with `wmill datatable migrate new|up|down` and applied to
the `factory` schema of the workspace's default (instance-backed) data table.

Migrations here are **additive-only**: once a migration has shipped, never edit its `.up.sql` /
`.down.sql` in place and never rename or drop a column or table in a later migration in a way
that breaks code depending on the old shape. Add a new migration instead (new column, new table,
new view). This keeps `wmill datatable migrate up` safe to re-run across every deployed instance
regardless of which migrations it has already applied.
