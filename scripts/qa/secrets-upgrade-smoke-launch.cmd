@echo off
rem Windows shim for the secrets upgrade smoke launch wrapper: Playwright runs the
rem executable through the shell there, so a .cmd can hand every argument to Node.
"%COWORK_SMOKE_NODE%" "%~dp0secrets-upgrade-smoke-launch.mjs" %*
