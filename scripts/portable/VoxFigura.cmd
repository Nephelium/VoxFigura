@echo off
setlocal
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE_EXTRA_CA_CERTS="
set "NODE_V8_COVERAGE="
"%~dp0runtime\node\node.exe" "%~dp0server\portable.mjs" %*
if errorlevel 1 pause
