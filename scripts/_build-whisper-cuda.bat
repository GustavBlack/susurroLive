@echo off
REM ---------------------------------------------------------------------------
REM susurroLive - build whisper.cpp with CUDA 12.9 (Blackwell sm_120)
REM
REM Three things must all agree on ONE toolkit, or the generated *.cudafe1.stub.c
REM files fail with:
REM   error C4002: too many arguments for function-like macro invocation '__cudaLaunch'
REM
REM   1. CUDAToolkit_ROOT  - headers + libs
REM   2. CUDACXX + PATH    - which nvcc CMake invokes
REM   3. :FILEPATH type    - without an explicit CMake type the -D lands in the cache
REM                          as UNINITIALIZED and CMake silently re-derives the
REM                          newest toolkit (13.0), giving split-brain headers.
REM
REM CUDA 13.0 cannot build this tree at all. Pin 12.9.
REM ---------------------------------------------------------------------------
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "CUDAROOT=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9"
set "CUDAROOT_FWD=C:/Program Files/NVIDIA GPU Computing Toolkit/CUDA/v12.9"

call "%VCVARS%"
if errorlevel 1 exit /b %errorlevel%

REM --- override whatever vcvars chose; these MUST come after the vcvars call ---
set "CUDA_PATH=%CUDAROOT%"
set "CUDA_HOME=%CUDAROOT%"
set "CUDACXX=%CUDAROOT%\bin\nvcc.exe"
set "PATH=%CUDAROOT%\bin;%PATH%"

echo === nvcc that will be used ===
nvcc --version | findstr /i release

cd /d "%~dp0..\native\src\whisper.cpp"
if errorlevel 1 exit /b %errorlevel%

if exist build-cuda (
  echo === wiping previous build ===
  rmdir /s /q build-cuda
)

echo === configuring ===
cmake -B build-cuda -DCMAKE_BUILD_TYPE=Release ^
  -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=120 ^
  -DCUDAToolkit_ROOT:FILEPATH="%CUDAROOT_FWD%" ^
  -DCMAKE_CUDA_COMPILER:FILEPATH="%CUDAROOT_FWD%/bin/nvcc.exe" ^
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
if errorlevel 1 exit /b %errorlevel%

echo === which CUDA did CMake settle on? ===
findstr /i "CMAKE_CUDA_COMPILER" build-cuda\CMakeCache.txt

echo === building ===
cmake --build build-cuda --config Release --parallel 8
if errorlevel 1 exit /b %errorlevel%

echo === BUILD OK ===
exit /b 0
