#define AppName "LC2 DOGE2 Solo Miner"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppPublisher "LC2 DOGE2 Solo Miner"
#define AppExeName "lc2-solo-proxy-windows.exe"
#define AppIcon "..\..\installer\windows\assets\robot-icon.ico"
#define SplashBuildPng "..\..\build\BitsPleaseYT_Installer_Splash_Screen.png"
#define SplashRootPng "..\..\BitsPleaseYT_Installer_Splash_Screen.png"
#define SplashBmp "..\..\installer\windows\assets\splash.bmp"
#define SplashPng "..\..\installer\windows\assets\splash.png"
#define SplashJpg "..\..\installer\windows\assets\splash.jpg"
#define SplashJpeg "..\..\installer\windows\assets\splash.jpeg"

[Setup]
AppId={{3F193032-8A67-4AF8-B8B4-0F8F427D7C92}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\LC2 DOGE2 Solo Miner
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=LC2-DOGE2-Solo-Miner-Setup-{#AppVersion}
Compression=lzma
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
PrivilegesRequired=admin
UninstallDisplayIcon={app}\dist\{#AppExeName}
SetupIconFile={#AppIcon}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop icon"; GroupDescription: "Additional icons:"; Flags: unchecked

[Files]
Source: "..\..\dist\{#AppExeName}"; DestDir: "{app}\dist"; Flags: ignoreversion
Source: "..\..\watchdog.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\watchdog.ps1"; DestDir: "{app}"; DestName: "watchdog-{#AppVersion}.ps1"; Flags: ignoreversion
Source: "..\..\bin\windows\start-miner-stack.ps1"; DestDir: "{app}\bin\windows"; Flags: ignoreversion
Source: "..\..\bin\windows\start-miner-stack.ps1"; DestDir: "{app}\bin\windows"; DestName: "start-miner-stack-{#AppVersion}.ps1"; Flags: ignoreversion
Source: "..\..\TESTER-MINING-SETUP.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\data\doge2-bootstrap-nodes.txt"; DestDir: "{app}\data"; Flags: ignoreversion
Source: "..\..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\bin\*"; DestDir: "{app}\bin"; Excludes: "gen-address.js,windows\create-desktop-icon.ps1"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#AppIcon}"; DestDir: "{app}\bin\windows"; DestName: "robot-icon.ico"; Flags: ignoreversion
#ifexist "..\..\build\BitsPleaseYT_Installer_Splash_Screen.png"
Source: "..\..\build\BitsPleaseYT_Installer_Splash_Screen.png"; DestDir: "{app}\bin\windows"; DestName: "splash.png"; Flags: ignoreversion
#endif
#ifexist "..\..\BitsPleaseYT_Installer_Splash_Screen.png"
Source: "..\..\BitsPleaseYT_Installer_Splash_Screen.png"; DestDir: "{app}\bin\windows"; DestName: "splash.png"; Flags: ignoreversion
#endif
#ifexist "{#SplashPng}"
Source: "{#SplashPng}"; DestDir: "{app}\bin\windows"; DestName: "splash.png"; Flags: ignoreversion
#endif
Source: "{#SplashBmp}"; DestDir: "{app}\bin\windows"; DestName: "splash.bmp"; Flags: ignoreversion
#ifexist "{#SplashJpg}"
Source: "{#SplashJpg}"; DestDir: "{app}\bin\windows"; DestName: "splash.jpg"; Flags: ignoreversion
#endif
#ifexist "{#SplashJpeg}"
Source: "{#SplashJpeg}"; DestDir: "{app}\bin\windows"; DestName: "splash.jpeg"; Flags: ignoreversion
#endif

[Dirs]
Name: "{app}\data"

[InstallDelete]
Type: files; Name: "{app}\watchdog-*.ps1"
Type: files; Name: "{app}\bin\windows\start-miner-stack-*.ps1"
Type: files; Name: "{app}\bin\windows\splash.png"
Type: files; Name: "{app}\bin\windows\splash.jpg"
Type: files; Name: "{app}\bin\windows\splash.jpeg"

[Icons]
Name: "{group}\Start Miner Stack"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\windows\start-miner-stack-{#AppVersion}.ps1"" -OpenDashboard -OpenInfoFile"; WorkingDir: "{app}"; IconFilename: "{app}\bin\windows\robot-icon.ico"
Name: "{group}\Open Dashboard"; Filename: "{cmd}"; Parameters: "/c start http://127.0.0.1:8081/"; WorkingDir: "{app}"
Name: "{group}\Open Runtime Status"; Filename: "{localappdata}\LC2 DOGE2 Solo Miner\RUNTIME-STATUS.txt"
Name: "{group}\Tester Setup Guide"; Filename: "{app}\TESTER-MINING-SETUP.txt"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\windows\start-miner-stack-{#AppVersion}.ps1"" -OpenDashboard -OpenInfoFile"; WorkingDir: "{app}"; Tasks: desktopicon; IconFilename: "{app}\bin\windows\robot-icon.ico"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\bin\windows\start-miner-stack-{#AppVersion}.ps1"" -OpenDashboard -OpenInfoFile"; Description: "Start miner stack now"; Flags: nowait postinstall skipifsilent runhidden
