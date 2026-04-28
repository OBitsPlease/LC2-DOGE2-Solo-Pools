#define AppName "LC2 DOGE2 Solo Miner"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPublisher "LC2 DOGE2 Solo Miner"
#define AppExeName "lc2-solo-proxy-windows.exe"

[Setup]
AppId={{3F193032-8A67-4AF8-B8B4-0F8F427D7C92}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\LC2 DOGE2 Solo Miner
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=LC2-DOGE2-Solo-Miner-Setup
Compression=lzma
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\dist\{#AppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\..\dist\{#AppExeName}"; DestDir: "{app}\dist"; Flags: ignoreversion
Source: "..\..\watchdog.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\bin\windows\start-miner-stack.ps1"; DestDir: "{app}\bin\windows"; Flags: ignoreversion
Source: "..\..\TESTER-MINING-SETUP.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\bin\*"; DestDir: "{app}\bin"; Excludes: "gen-address.js,windows\create-desktop-icon.ps1"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{app}\data"

[Icons]
Name: "{group}\Start Miner Stack"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\windows\start-miner-stack.ps1"" -OpenDashboard -OpenInfoFile"; WorkingDir: "{app}"
Name: "{group}\Open Dashboard"; Filename: "{cmd}"; Parameters: "/c start http://127.0.0.1:8081/"; WorkingDir: "{app}"
Name: "{group}\Open Runtime Status"; Filename: "{localappdata}\LC2 DOGE2 Solo Miner\RUNTIME-STATUS.txt"
Name: "{group}\Tester Setup Guide"; Filename: "{app}\TESTER-MINING-SETUP.txt"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\windows\start-miner-stack.ps1"" -OpenDashboard -OpenInfoFile"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\windows\start-miner-stack.ps1"" -OpenDashboard -OpenInfoFile"; Description: "Start miner stack now"; Flags: nowait postinstall skipifsilent runhidden
