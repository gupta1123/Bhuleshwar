@echo off
cd /d "%~dp0\..\.."
node scripts\build-tally-connector-installer.mjs
