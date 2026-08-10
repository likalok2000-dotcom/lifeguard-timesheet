@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  我的工時 — 啟動雲端伺服器 + 公開網址
echo  （部電腦要開住，先有帳號資料庫）
echo.
start "lifeguard-server" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
where cloudflared >nul 2>&1 && (
  echo  正在建立公開網址...
  cloudflared tunnel --url http://127.0.0.1:8765
  goto :eof
)
echo  未安裝 cloudflared，本機網址：http://127.0.0.1:8765
start "" http://127.0.0.1:8765/
pause
