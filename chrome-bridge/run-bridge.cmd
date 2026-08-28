@echo off
cd /d C:\VectorHQ\worktree-proof-workflow\chrome-bridge
set CHROME_BRIDGE_PIPE=chrome-bridge
node server.mjs > C:\Users\Nedal\AppData\Local\Temp\bridge.log 2>&1
