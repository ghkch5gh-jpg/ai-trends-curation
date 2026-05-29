@echo off
chcp 65001 >nul
setlocal
rem AI Trends 매일 생성기 — Windows 작업 스케줄러가 08:00에 호출.
rem 스케줄 작업은 PATH가 최소라 node/git/claude(npm) 경로를 명시한다.
set "PATH=C:\Program Files\nodejs;C:\Program Files\Git\cmd;C:\Users\myh43\AppData\Roaming\npm;%PATH%"
cd /d "%OneDrive%\바탕 화면\work\12_AItrends"

echo ============================================ >> daily.log
echo [%date% %time%] 시작 >> daily.log

git pull --quiet origin main >> daily.log 2>&1

node scripts\build-local.mjs >> daily.log 2>&1
if errorlevel 1 (
  echo [%date% %time%] 생성기 실패 — 종료 >> daily.log
  endlocal & exit /b 1
)

git add -A >> daily.log 2>&1
git diff --cached --quiet
if errorlevel 1 (
  git commit -m "daily: %date%" >> daily.log 2>&1
  git push origin main >> daily.log 2>&1
  echo [%date% %time%] push 완료 >> daily.log
) else (
  echo [%date% %time%] 변경 없음 (오늘 회차 이미 존재) >> daily.log
)

endlocal
