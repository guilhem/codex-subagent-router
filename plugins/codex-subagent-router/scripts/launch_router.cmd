@echo off
setlocal DisableDelayedExpansion
set "ROUTER=%~dp0..\dist\jev_router.mjs"

rem Prefer the relocated runtime when WindowsApps executables cannot run directly.
if defined LOCALAPPDATA for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do if exist "%%~fD\bin\node.exe" ("%%~fD\bin\node.exe" "%ROUTER%" %* & exit /b)
if defined XDG_CACHE_HOME if exist "%XDG_CACHE_HOME%\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" ("%XDG_CACHE_HOME%\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%ROUTER%" %* & exit /b)
if defined USERPROFILE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" ("%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" "%ROUTER%" %* & exit /b)
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" ("%CODEX_MCP_NODE_PATH%" "%ROUTER%" %* & exit /b)
if defined CODEX_BROWSER_USE_NODE_PATH if exist "%CODEX_BROWSER_USE_NODE_PATH%" ("%CODEX_BROWSER_USE_NODE_PATH%" "%ROUTER%" %* & exit /b)
if defined CODEX_ELECTRON_RESOURCES_PATH if exist "%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe" ("%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe" "%ROUTER%" %* & exit /b)
if defined CODEX_CLI_PATH for %%I in ("%CODEX_CLI_PATH%") do if exist "%%~dpIcua_node\bin\node.exe" ("%%~dpIcua_node\bin\node.exe" "%ROUTER%" %* & exit /b)
for %%N in (node.exe) do if not "%%~$PATH:N"=="" ("%%~$PATH:N" "%ROUTER%" %* & exit /b)

echo Jev routing unavailable: Node.js 20+ not found. Update Codex Desktop or install Node.js 20+ for the CLI; using native spawn defaults. 1>&2
exit /b 0
