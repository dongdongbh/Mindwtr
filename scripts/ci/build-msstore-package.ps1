param(
  [Parameter(Mandatory)][string]$BinaryDirectory,
  [Parameter(Mandatory)][string]$IconDirectory,
  [Parameter(Mandatory)][string]$MsixVersion,
  [Parameter(Mandatory)][string]$OutputPath,
  [string]$IdentityName = 'DongdaLi.Mindwtr',
  [string]$Publisher = 'CN=76AC9B15-7A1B-49FF-9342-2BE80735A1E6',
  [string]$PublisherDisplayName = 'Dongda Li'
)
$ErrorActionPreference = 'Stop'
if ($MsixVersion -notmatch '^[1-9][0-9]*\.[0-9]+\.[0-9]+\.0$') { throw 'Invalid Store package version' }
$buildDir = $BinaryDirectory
$iconDir = $IconDirectory
$outDir = "msix-staging"
Remove-Item -Recurse -Force $outDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path "$outDir\Assets" | Out-Null
Copy-Item "$buildDir/mindwtr.exe" -Destination "$outDir\mindwtr.exe"
if (Test-Path "$buildDir/WebView2Loader.dll") {
  Copy-Item "$buildDir/WebView2Loader.dll" -Destination "$outDir"
}
Copy-Item "$iconDir/Square44x44Logo.png" "$outDir\Assets\StoreLogo.png"
Copy-Item "$iconDir/Square150x150Logo.png" "$outDir\Assets\Square150x150Logo.png"
Copy-Item "$iconDir/Square44x44Logo.png" "$outDir\Assets\Square44x44Logo.png"
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities">
  <Identity Name="$IdentityName" 
            Publisher="$Publisher" 
            Version="$MsixVersion" />
  <Properties>
    <DisplayName>Mindwtr</DisplayName>
    <PublisherDisplayName>$PublisherDisplayName</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.19041.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="App" Executable="mindwtr.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Mindwtr"
                          Description="Local-first GTD application"
                          BackgroundColor="transparent"
                          Square150x150Logo="Assets\Square150x150Logo.png"
                          Square44x44Logo="Assets\Square44x44Logo.png">
      </uap:VisualElements>
      <Extensions>
        <!-- TaskId must match STORE_STARTUP_TASK_ID in src-tauri/src/autostart.rs -->
        <uap5:Extension Category="windows.startupTask" Executable="mindwtr.exe" EntryPoint="Windows.FullTrustApplication">
          <uap5:StartupTask TaskId="MindwtrStartup" Enabled="false" DisplayName="Mindwtr" />
        </uap5:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
$manifest | Out-File -FilePath "msix-staging\AppxManifest.xml" -Encoding UTF8
$msixPath = $OutputPath
$makeappx = Get-ChildItem -Path "C:\Program Files (x86)\Windows Kits" -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match "\\x64\\makeappx.exe$" } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $makeappx) {
  throw "makeappx.exe not found for x64"
}
& $makeappx pack /d msix-staging /p $msixPath /o
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed" }
if (Test-Path "$outDir/portable.txt") { throw 'Portable marker must not be present in a Store package' }
