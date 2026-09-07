import sqlite3
import json

conn = sqlite3.connect(r'C:\Users\Nedal\.codex\state_5.sqlite')
cursor = conn.cursor()

# List tables
cursor.execute('SELECT name FROM sqlite_master WHERE type="table"')
tables = cursor.fetchall()
print("=== TABLES ===")
for t in tables:
    print(t[0])

# Check for providers/models tables
for table in ['providers', 'models', 'provider_models', 'model_config', 'provider_config']:
    try:
        cursor.execute(f'SELECT * FROM {table} LIMIT 10')
        rows = cursor.fetchall()
        if rows:
            print(f"\n=== {table} ===")
            cols = [desc[0] for desc in cursor.description]
            print(cols)
            for row in rows:
                print(row)
    except:
        pass

conn.close()