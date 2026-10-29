@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
set "PYTHONPATH=%CD%\.venv\Lib\site-packages;%CD%\src"
set "PYTHONIOENCODING=utf-8"
".venv\Scripts\python.exe" -c "import sys; sys.executable = sys._base_executable; from steward.cli import main; sys.exit(main())" up %*
set "STEWARD_EXIT_CODE=%ERRORLEVEL%"
popd
if not "%STEWARD_EXIT_CODE%"=="0" (
    echo.
    echo Steward failed to start. See the error above.
    pause
)
exit /b %STEWARD_EXIT_CODE%
