@echo off
REM Hermes Harness Watcher - Restores CC bridge harness after Hermes updates
REM Schedule this via Windows Task Scheduler: run every 15 minutes
cd /d "%~dp0.."
node scripts\hermes-harness-watcher.mjs
