@echo off
rem Restarts Discord PTB with a DevTools port that only this PC (127.0.0.1) can reach,
rem so the DSH discord-autoreply plugin can read and send messages.
taskkill /IM DiscordPTB.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
start "" "%LOCALAPPDATA%\DiscordPTB\Update.exe" --processStart DiscordPTB.exe --process-start-args "--remote-debugging-port=9230 --remote-debugging-address=127.0.0.1"
