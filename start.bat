@echo off
REM ============================================================
REM  WildRift Mentor - 一鍵啟動（Windows）
REM  功能：
REM   1) 檢查 Node / npm
REM   2) 初始化 npm（若無 package.json）
REM   3) 安裝依賴（若缺少 node_modules）
REM   4) 執行 index.js
REM   5) 可選：傳入搜尋關鍵字，啟用 Douyin/TikTok 搜索
REM  用法：
REM   - 直接雙擊：只更新版本/載入映射
REM   - start.bat 激斗峡谷 裝備 符文   （含社群搜尋）
REM ============================================================

setlocal enabledelayedexpansion
chcp 65001 >nul

echo.
echo [WR] Working dir: %cd%

REM --- 1) 檢查 Node 與 npm ---
where node >nul 2>nul
if errorlevel 1 (
  echo [WR][ERR] 未找到 Node.js，請先到 https://nodejs.org 安裝 (建議 18+).
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [WR][ERR] 未找到 npm，請確認 Node.js 安裝完整。
  pause
  exit /b 1
)

REM --- 2) 若無 package.json，初始化 ---
if not exist package.json (
  echo [WR] 初始化 npm 專案...
  call npm init -y
)

REM --- 3) 安裝依賴（若無 node_modules 或缺包）---
if not exist node_modules (
  echo [WR] 安裝依賴 node-fetch@3 與 cheerio ...
  call npm install node-fetch@3 cheerio
) else (
  REM 嘗試確認依賴是否存在；若缺失則補裝
  node -e "require.resolve('node-fetch');require.resolve('cheerio')" 2>nul
  if errorlevel 1 (
    echo [WR] 補齊依賴...
    call npm install node-fetch@3 cheerio
  )
)

REM --- 4) 是否有社群搜尋參數？若有則設置環境變數 ---
set "SEARCH_KEYWORDS="
if not "%~1"=="" (
  set "SEARCH_KEYWORDS=%*"
  echo [WR] 啟用社群搜尋（Douyin/TikTok）：%SEARCH_KEYWORDS%
  set "WR_COMMUNITY_SEARCH=%SEARCH_KEYWORDS%"
)

REM --- 5) 執行主程式 ---
echo [WR] 啟動 index.js ...
node index.js

echo.
echo [WR] 任務結束。按任意鍵關閉視窗。
pause >nul
endlocal
