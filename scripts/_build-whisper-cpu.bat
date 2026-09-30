@echo off
REM ---------------------------------------------------------------------------
REM susurroLive - CPU-only whisper.cpp build. Fast, always works, real (non-demo)
REM transcription. Used as the guaranteed baseline while the CUDA build is sorted.
REM ---------------------------------------------------------------------------
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"

call "%VCVARS%"
if errorlevel 1 exit /b %errorlevel%

cd /d "%~dp0..\native\src\whisper.cpp"
if errorlevel 1 exit /b %errorlevel%

if exist build-cpu rmdir /s /q build-cpu

echo === configuring (CPU) ===
cmake -B build-cpu -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=OFF ^
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
if errorlevel 1 exit /b %errorlevel%

echo === building ===
cmake --build build-cpu --config Release --parallel 8
if errorlevel 1 exit /b %errorlevel%

echo === BUILD OK ===
exit /b 0
