import sqlite3
import json

# Check memories_1.sqlite
conn = sqlite3.connect(r'C:\Users\Nedal\.codex\memories_1.sqlite')
cursor = conn.cursor()
cursor.execute('SELECT name FROM sqlite_master WHERE type="table"')
tables = cursor.fetchall()
print("=== memories_1.sqlite TABLES ===")
for t in tables:
    print(t[0])
for table in tables:
    tname = table[0]
    try:
        cursor.execute(f'SELECT * FROM {tname} LIMIT 5')
        rows = cursor.fetchall()
        if rows:
            print(f"\n--- {tname} ---")
            cols = [desc[0] for desc in cursor.description]
            print(cols)
            for row in rows:
                print(row)
    except Exception as e:
        print(f"Error reading {tname}: {e}")
conn.close()

# Check goals_1.sqlite
conn = sqlite3.connect(r'C:\Users\Nedal\.codex\goals_1.sqlite')
cursor = conn.cursor()
cursor.execute('SELECT name FROM sqlite_master WHERE type="table"')
tables = cursor.fetchall()
print("\n=== goals_1.sqlite TABLES ===")
for t in tables:
    print(t[0])
for table in tables:
    tname = table[0]
    try:
        cursor.execute(f'SELECT * FROM {tname} LIMIT 5')
        rows = cursor.fetchall()
        if rows:
            print(f"\n--- {tname} ---")
            cols = [desc[0] for desc in cursor.description]
            print(cols)
            for row in rows:
                print(row)
    except Exception as e:
        print(f"Error reading {tname}: {e}")
conn.close()

# Check queue_1.sqlite
conn = sqlite3.connect(r'C:\Users\Nedal\.codex\queue_1.sqlite')
cursor = conn.cursor()
cursor.execute('SELECT name FROM sqlite_master WHERE type="table"')
tables = cursor.fetchall()
print("\n=== queue_1.sqlite TABLES ===")
for t in tables:
    print(t[0])
for table in tables:
    tname = table[0]
    try:
        cursor.execute(f'SELECT * FROM {tname} LIMIT 5')
        rows = cursor.fetchall()
        if rows:
            print(f"\n--- {tname} ---")
            cols = [desc[0] for desc in cursor.description]
            print(cols)
            for row in rows:
                print(row)
    except Exception as e:
        print(f"Error reading {tname}: {e}")
conn.close()

# Check state_5.sqlite for external_agent_config_imports
conn = sqlite3.connect(r'C:\Users\Nedal\.codex\state_5.sqlite')
cursor = conn.cursor()
cursor.execute('SELECT * FROM external_agent_config_imports LIMIT 20')
rows = cursor.fetchall()
if rows:
    print("\n=== external_agent_config_imports ===")
    cols = [desc[0] for desc in cursor.description]
    print(cols)
    for row in rows:
        print(row)
conn.close()