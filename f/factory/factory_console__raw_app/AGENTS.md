# AI Agent Instructions

For complete raw app documentation (app structure, backend runnables, datatables, SQL migrations), use the `raw-app` skill.

This file contains **app-specific configuration** for this raw app instance.

---

## Data Configuration

**No default datatable configured.** Set `data.datatable` in `raw_app.yaml` to enable database access.

### Whitelisted Tables

**No tables whitelisted.** Add tables to `data.tables` in `raw_app.yaml`.

### Adding a Table

Edit `raw_app.yaml`:

```yaml
data:
  datatable: main
  tables:
    # Add tables here
    - main/new_table  # ← Add like this
```

**Table reference formats:**
- `<datatable>/<table>` - Table in public schema
- `<datatable>/<schema>:<table>` - Table in specific schema

---

## Quick Reference

**Backend runnable:** Add `backend/<name>.ts` (or .py, etc.), then run `wmill generate-metadata`

**Call from frontend:**
```typescript
import { backend } from './wmill';
const result = await backend.<name>({ arg: 'value' });
```

**Query datatable (TypeScript):**
```typescript
const sql = wmill.datatable();
const rows = await sql`SELECT * FROM table WHERE id = ${id}`.fetch();
```

**SQL migrations:** Add `.sql` files to `sql_to_apply/`, run `wmill app dev`, then whitelist tables

---
*Run `wmill app generate-agents` to refresh. See `.claude/skills/raw-app` skill for full documentation.*
