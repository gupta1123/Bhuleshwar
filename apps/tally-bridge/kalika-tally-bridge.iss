#define AppName "Kalika Tally Connector"
#define AppVersion "0.1.65"
#define AppPublisher "Kalika"
#define AppInstallDir "C:\Autodealer\tally-bridge"
#define AppExeName "Kalika Tally Connector.exe"
#define DebitNoteTdl "kalika-native-debit-note-export.tdl"
#define PurchaseDocumentTdl "kalika-purchase-document-attachment.tdl"

[Setup]
AppId={{7C2D55CC-4AF4-4E8D-8F7D-77DD3D41A45F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
UninstallDisplayName={#AppName}
DefaultDirName={#AppInstallDir}
DisableProgramGroupPage=yes
DisableWelcomePage=no
DisableReadyPage=no
OutputDir=output
UsePreviousAppDir=no
OutputBaseFilename=KalikaTallyConnectorSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[InstallDelete]
Type: filesandordirs; Name: "{app}\*"

[Files]
Source: "payload-clean\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\Classes\kalika-tally"; ValueType: string; ValueName: ""; ValueData: "URL:Kalika Tally Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\kalika-tally"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\kalika-tally\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"
Root: HKCU; Subkey: "Software\Classes\kalika-tally\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

[Code]
function TallyInstallDir(): String;
begin
  if IsWin64 and DirExists(ExpandConstant('{pf64}\TallyPrime')) then
    Result := ExpandConstant('{pf64}\TallyPrime')
  else if DirExists(ExpandConstant('{pf32}\TallyPrime')) then
    Result := ExpandConstant('{pf32}\TallyPrime')
  else
    Result := '';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM "Kalika Tally Connector.exe" >nul 2>&1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CopyTdlToTally(const FileName: String);
var
  TallyDir: String;
  SourceTdl: String;
  TargetTdl: String;
begin
  TallyDir := TallyInstallDir();
  SourceTdl := ExpandConstant('{app}\tdl\') + FileName;
  TargetTdl := TallyDir + '\' + FileName;
  if DirExists(TallyDir) and FileExists(SourceTdl) then
  begin
    if CopyFile(SourceTdl, TargetTdl, False) then
      Log('Copied TDL to ' + TargetTdl)
    else
      RaiseException('Could not update the required Tally TDL: ' + TargetTdl);
  end;
end;

procedure EnsureTdlConfigured(const FileName: String);
var
  TallyIni: String;
  TargetTdl: String;
  TdlLine: String;
  Lines: TArrayOfString;
  I: Integer;
  UserTdlFound: Boolean;
  TdlFound: Boolean;
begin
  if TallyInstallDir() = '' then
    Exit;
  TallyIni := TallyInstallDir() + '\tally.ini';
  TargetTdl := TallyInstallDir() + '\' + FileName;
  TdlLine := 'TDL=' + TargetTdl;
  if not FileExists(TallyIni) then
    Exit;
  if not LoadStringsFromFile(TallyIni, Lines) then
    RaiseException('Could not read Tally configuration: ' + TallyIni);

  UserTdlFound := False;
  TdlFound := False;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    if CompareText(Trim(Lines[I]), 'User TDL=Yes') = 0 then
      UserTdlFound := True
    else if CompareText(Trim(Lines[I]), 'User TDL=No') = 0 then
    begin
      Lines[I] := 'User TDL=Yes';
      UserTdlFound := True;
    end;

    if (Pos('tdl=', Lowercase(Trim(Lines[I]))) = 1) and
       (Pos(Lowercase(FileName), Lowercase(Lines[I])) > 0) then
    begin
      Lines[I] := TdlLine;
      TdlFound := True;
    end;
  end;

  if not UserTdlFound then
  begin
    SetArrayLength(Lines, GetArrayLength(Lines) + 1);
    Lines[GetArrayLength(Lines) - 1] := 'User TDL=Yes';
  end;
  if not TdlFound then
  begin
    SetArrayLength(Lines, GetArrayLength(Lines) + 1);
    Lines[GetArrayLength(Lines) - 1] := TdlLine;
  end;
  if not SaveStringsToFile(TallyIni, Lines, False) then
    RaiseException('Could not update Tally configuration: ' + TallyIni);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    CopyTdlToTally('{#DebitNoteTdl}');
    CopyTdlToTally('{#PurchaseDocumentTdl}');
    EnsureTdlConfigured('{#DebitNoteTdl}');
    EnsureTdlConfigured('{#PurchaseDocumentTdl}');
  end;
end;
