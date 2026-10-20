; Inno Setup script for dist\PaperTrader-Setup-<version>.exe. build.ps1 passes /DVersion=...
; Installs for the current user only, so no admin prompt. Uninstalling leaves the data in %LOCALAPPDATA%\PaperTrader.

#ifndef Version
  #define Version "0.0.0"
#endif

[Setup]
AppId={{5EB562DF-7600-4D33-A2FB-D6385994855B}
AppName=Paper Trader
AppVersion={#Version}
AppVerName=Paper Trader {#Version}
AppPublisher=Georgy Esik
DefaultDirName={localappdata}\Programs\Paper Trader
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=PaperTrader-Setup-{#Version}
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\PaperTrader.exe
UninstallDisplayName=Paper Trader
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\PaperTrader\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; files from an older version that this one no longer ships
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\Paper Trader"; Filename: "{app}\PaperTrader.exe"
Name: "{autodesktop}\Paper Trader"; Filename: "{app}\PaperTrader.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\PaperTrader.exe"; Description: "{cm:LaunchProgram,Paper Trader}"; Flags: nowait postinstall skipifsilent
