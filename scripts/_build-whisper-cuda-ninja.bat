@echo off
REM ---------------------------------------------------------------------------
REM susurroLive - CUDA 12.9 build via NINJA.
REM
REM Why Ninja instead of the Visual Studio generator:
REM   With the "Visual Studio 17 2022" generator, CUDA is compiled through MSBuild's
REM   CUDA build-customization targets, and CMake's CUDA compiler detection goes via
REM   CUDA 13.0.targets regardless of -DCMAKE_CUDA_COMPILER / CUDACXX. Those targets
REM   are what emit the split-brain include list (12.9 headers + 13.0 nvcc) that
REM   produces "error C4002: too many arguments for ... '__cudaLaunch'".
REM   With Ninja, CMake invokes nvcc directly using the compiler we name, so pinning
REM   actually works.
REM ---------------------------------------------------------------------------
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "CUDAROOT=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9"
set "CUDAROOT_FWD=C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.9"
REM Ninja may come from any install; adjust or rely on PATH after vcvars.
if not defined NINJA set "NINJA=C:/Users/Gusta/anaconda3/Scripts/ninja.exe"

call "%VCVARS%"
if errorlevel 1 exit /b %errorlevel%

set "CUDA_PATH=%CUDAROOT%"
set "CUDACXX=%CUDAROOT%\bin\nvcc.exe"
set "PATH=%CUDAROOT%\bin;%PATH%"

echo === nvcc that will be used ===
nvcc --version | findstr /i release

REM relative to the repo root; %~dp0 is <repo>\scripts
cd /d "%~dp0..\native\src\whisper.cpp"
if errorlevel 1 exit /b %errorlevel%
if exist build-cuda-ninja rmdir /s /q build-cuda-ninja

echo === configuring (Ninja + CUDA 12.9) ===
cmake -G Ninja -B build-cuda-ninja -DCMAKE_BUILD_TYPE=Release ^
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 ^
  -DCMAKE_MAKE_PROGRAM="%NINJA%" ^
  -DCMAKE_CUDA_COMPILER:FILEPATH="%CUDAROOT_FWD%/bin/nvcc.exe" ^
  -DCUDAToolkit_ROOT:FILEPATH="%CUDAROOT_FWD%" ^
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
if errorlevel 1 exit /b %errorlevel%

echo === compiler CMake settled on ===
findstr /i "CMAKE_CUDA_COMPILER:FILEPATH" build-cuda-ninja\CMakeCache.txt

echo === building ===
cmake --build build-cuda-ninja --parallel 8
if errorlevel 1 exit /b %errorlevel%

echo === BUILD OK ===
exit /b 0
