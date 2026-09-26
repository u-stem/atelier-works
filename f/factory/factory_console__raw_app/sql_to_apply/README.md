# SQL Migrations Folder

This folder is for SQL migration files that will be applied to datatables during development.

## How to Use

1. Configure a datatable in `raw_app.yaml`:
   ```yaml
   data:
     datatable: main  # Your datatable name
     tables: []       # Add tables here after creating them
   ```

2. Create SQL files in this folder (e.g., `001_create_users.sql`)

3. Run `wmill app dev .` - the dev server watches this folder

4. When a SQL file is created/modified, a modal appears to confirm execution

5. After creating tables, add them to `data.tables` in `raw_app.yaml`

## Important

- This folder is **excluded from push** - SQL files are not synced
- Always add created tables to `data.tables` so your app can access them
- Use idempotent SQL (`CREATE TABLE IF NOT EXISTS`, etc.)
