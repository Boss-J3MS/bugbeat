@echo off

echo Starting Backend...
start cmd /k "cd C:\Users\USER\Desktop\codebeat\backend && node server.js"

timeout /t 2 >nul

echo Starting ML Service...
start cmd /k "cd C:\Users\USER\Desktop\codebeat\ml-service && python main.py"

echo.
echo All services started!
pause