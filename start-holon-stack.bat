@echo off
title Holon Stack Launcher
echo Starting Holon services...
echo Changing to holon-brdge
cd "C:\ProgramData\holon-bridge"

:: 1. Start Fuseki
echo [1/5] Starting Fuseki...
start "Fuseki" cmd /k "c:\ProgramData\holon-bridge\start-fuseki.bat"
timeout /t 8 /nobreak >nul

:: 4. Start ngrok tunnel for HolonBridge (port 3031)
echo [4/5] Starting ngrok tunnel -> kurtcagle.ngrok.io:3031...
start "ngrok-holonbridge" cmd /k "ngrok http --url=kurtcagle.ngrok.io 3031"

:: 5. Start ngrok tunnel for MCP Remote (port 3032)
echo [5/5] Starting ngrok tunnel -> kurtcagle-mcp.ngrok.io:3032...
start "ngrok-mcp-remote" cmd /k "ngrok http --url=kurtcagle-mcp.ngrok.io 3032"

:: 2. Start HolonBridge
echo [2/5] Starting HolonBridge...
start "HolonBridge" cmd /k "cd /d c:\ProgramData\holon-bridge && npm start"
timeout /t 5 /nobreak >nul

:: 3. Start HolonBridge MCP Remote
echo [3/5] Starting HolonBridge MCP Remote...
start "HolonBridge-MCP-Remote" cmd /k "cd /d c:\ProgramData\holon-bridge\mcp-remote && node holonbridge-mcp-remote.js"
timeout /t 3 /nobreak >nul


echo.
echo All services launched. Check individual windows for status.
pause