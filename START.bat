@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  我的工時 — 救生員個人返工計時
echo.
where node >nul 2>&1 && (
  start "" http://127.0.0.1:8765/
  node server.js
  goto :eof
)
where npx >nul 2>&1 && (
  start "" http://127.0.0.1:8765/
  npx --yes serve -l 8765 .
  goto :eof
)
echo 未找到 Node，直接開檔案...
start "" "%~dp0index.html"
pause
