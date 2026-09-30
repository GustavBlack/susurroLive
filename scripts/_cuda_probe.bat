@echo off
REM Configure-only probe: verify CMake settles on CUDA 12.9 nvcc before committing
REM to a 15-minute build.
set "VCVARS=C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
set "CUDAROOT=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9"

call "%VCVARS%"
if errorlevel 1 exit /b %errorlevel%

REM vcvars (and the CUDA installer) export CUDA_PATH_V<major>_<minor>. CMake enumerates
REM those and picks the NEWEST, which is why it kept choosing 13.0 no matter what we
REM passed via -D. Mask the ones newer than 12.9 so 12.9 wins the search.
set "CUDA_PATH_V13_0="
set "CUDA_PATH_V12_8="
set "CUDA_PATH=%CUDAROOT%"
set "CUDACXX=%CUDAROOT%\bin\nvcc.exe"
set "PATH=%CUDAROOT%\bin;%PATH%"

cd /d "%~dp0..\native\src\whisper.cpp"
if exist build-probe rmdir /s /q build-probe

cmake -B build-probe -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON ^
  -DCMAKE_CUDA_ARCHITECTURES=120 ^
  -DCMAKE_TOOLCHAIN_FILE="%~dp0cuda129-toolchain.cmake" ^
  -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF
if errorlevel 1 exit /b %errorlevel%

echo === RESULT ===
type build-probe\CMakeFiles\*\CMakeCUDACompiler.cmake | findstr /i "CMAKE_CUDA_COMPILER \""
exit /b 0
