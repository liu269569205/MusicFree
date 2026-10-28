@echo off
setlocal
set JAVA_HOME=D:\android_sdk\android_build\jdk_raw\jdk-17.0.20+8
set ANDROID_HOME=D:\android_sdk
set GRADLE_USER_HOME=D:\gradle_home_dev
set PATH=C:\Users\lj\.workbuddy\binaries\node\versions\22.22.2;D:\android_sdk\android_build\jdk_raw\jdk-17.0.20+8\bin;D:\android_sdk\platform-tools;D:\android_sdk\build-tools\35.0.0;C:\Windows\system32;C:\Windows;%PATH%
call "D:\gradle_home_dev\wrapper\dists\gradle-8.10.2-all\ezxzryhqdbf6stsda8vkgso9x\gradle-8.10.2\bin\gradle.bat" %*
endlocal
