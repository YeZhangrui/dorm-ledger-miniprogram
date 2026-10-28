@echo off
rem Double-click helper: copy cloudfunctions\_shared into each function as shared\
rem (WeChat uploads only the function's own folder, so shared code must live inside it)
setlocal
cd /d "%~dp0..\miniprogram\cloudfunctions"
echo.
echo [1/2] Copying shared modules into each cloud function ...
if not exist "_shared\db.js" (
  echo   ERROR: cannot find _shared\db.js
  echo   Make sure you are running this inside the project: tools\prepare-cloudfunctions.cmd
  pause
  exit /b 1
)
for %%D in (login room expense ai backup) do (
  if exist "%%D" (
    if exist "%%D\shared" rmdir /s /q "%%D\shared"
    xcopy "_shared" "%%D\shared\" /E /I /Y >nul
    echo   [OK] %%D\shared
  ) else (
    echo   [SKIP] %%D not found
  )
)
echo.
echo [2/2] Done. Next: in WeChat DevTools, right-click each cloud function
echo       login / room / expense / ai / backup
echo       and choose "Upload and deploy: install dependencies in cloud".
echo.
pause
