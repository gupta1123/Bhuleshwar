; Kalika Local Agent installer hooks (electron-builder NSIS).

; Close running Kalika agents cleanly: ask the agent to quit (it finishes any
; Tally write and closes its database), wait up to 10 seconds, then force-close
; whatever is left, including its helper processes (same image name). The
; process path comes from CIM because this installer is 32-bit.
!macro kalikaCloseAgentsBody
  DetailPrint "Closing Kalika Local Agent..."
  nsExec::ExecToLog /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { $$names = @('Kalika Local Agent.exe','Kalika Tally Connector.exe'); $$running = @(Get-CimInstance Win32_Process | Where-Object { $$names -contains $$_.Name }); if ($$running.Count -gt 0) { $$agent = $$running | Where-Object { $$_.Name -eq 'Kalika Local Agent.exe' -and $$_.ExecutablePath } | Select-Object -First 1; if ($$agent) { Start-Process -FilePath $$agent.ExecutablePath -ArgumentList '--quit' }; $$deadline = (Get-Date).AddSeconds(10); while ((Get-Process -Name 'Kalika Local Agent','Kalika Tally Connector' -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $$deadline)) { Start-Sleep -Milliseconds 300 } }; Get-Process -Name 'Kalika Local Agent','Kalika Tally Connector' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0 }"`
  Pop $0
!macroend

!ifdef BUILD_UNINSTALLER
  Function un.kalikaCloseAgents
    !insertmacro kalikaCloseAgentsBody
  FunctionEnd
!else
  Var kalikaWasInstalled
  Var kalikaHadDesktopLink

  Function kalikaCloseAgents
    !insertmacro kalikaCloseAgentsBody
  FunctionEnd

  ; TallyPrime rewrites tally.ini when it closes, which can undo the add-on
  ; setup made while it was open. Ask the user to close it first.
  Function kalikaCheckTally
    check:
      nsExec::ExecToStack /TIMEOUT=15000 `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq tally.exe" /NH | "$SYSDIR\find.exe" /I "tally.exe"`
      Pop $0
      Pop $1
      StrCmp $0 "0" 0 done
      MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "TallyPrime is open.$\r$\n$\r$\nPlease save your work and close TallyPrime, then click Retry.$\r$\n$\r$\nKalika sets up its Tally add-ons during installation, and TallyPrime can undo that setup if it is left open.$\r$\n$\r$\nIgnore: continue anyway (restart TallyPrime after installing).$\r$\nAbort: cancel the installation." /SD IDIGNORE IDRETRY check IDIGNORE done
      Quit
    done:
  FunctionEnd
!endif

; Replaces electron-builder's own "app is running" check.
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    Call un.kalikaCloseAgents
  !else
    Call kalikaCheckTally
    Call kalikaCloseAgents
    DetailPrint "Removing the previous version..."
  !endif
!macroend

!macro customInit
  ; Remember whether this is an upgrade and whether the user kept the desktop
  ; shortcut, so an upgrade does not bring back a shortcut they deleted.
  StrCpy $kalikaWasInstalled "0"
  StrCpy $kalikaHadDesktopLink "0"
  ${If} ${FileExists} "$INSTDIR\Kalika Local Agent.exe"
    StrCpy $kalikaWasInstalled "1"
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\Kalika Local Agent.lnk"
    StrCpy $kalikaHadDesktopLink "1"
  ${EndIf}
!macroend

!macro customInstall
  ${If} $kalikaWasInstalled == "1"
  ${AndIf} $kalikaHadDesktopLink == "0"
    Delete "$DESKTOP\Kalika Local Agent.lnk"
  ${EndIf}

  DetailPrint "Removing older Kalika connectors..."
  ; 64-bit PowerShell: this installer is 32-bit, and the old connector's
  ; 64-bit uninstall entry is invisible to 32-bit PowerShell.
  StrCpy $1 "$WINDIR\sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$1"
    StrCpy $1 "powershell.exe"
  ${EndIf}
  nsExec::ExecToLog /TIMEOUT=180000 '"$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\remove-legacy-user-install.ps1" -AgentExecutable "$INSTDIR\Kalika Local Agent.exe"'
  Pop $0

  DetailPrint "Setting up Kalika add-ons in TallyPrime..."
  nsExec::ExecToStack /TIMEOUT=60000 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\powershell\install-managed-tdl.ps1" -AgentResourceDirectory "$INSTDIR\resources"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "Tally add-on setup failed ($0): $1"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Kalika Local Agent is installed, but its TallyPrime add-ons could not be set up.$\r$\n$\r$\nClose TallyPrime and run this installer again. If it keeps happening, use Send diagnostics to support in Kalika Local Agent." /SD IDOK
  ${Else}
    DetailPrint "Kalika add-ons are ready. Restart TallyPrime if it is open."
  ${EndIf}
!macroend

!macro customUnInstall
  ; Local Agent data is intentionally retained across uninstall and upgrade.
  ; Users can remove it deliberately through Factory reset inside the agent.
!macroend
