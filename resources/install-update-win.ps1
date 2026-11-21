param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$request = $null
$parentExited = $false
function Write-InstallLog([string]$Message) {
  $line = '{0:o} {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath $request.logFile -Value $line -Encoding UTF8
}
function Write-InstallStatus([string]$Stage, [string]$Message) {
  $state = @{token=$request.token; version=$request.version; stage=$Stage; message=$Message; at=(Get-Date).ToUniversalTime().ToString('o')}
  $json = $state | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($request.statusFile,$json,[Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($request.resultFile,$json,[Text.UTF8Encoding]::new($false))
}
function Read-InstallerSha256([string]$Filename) {
  # Avoid module autoload: apps launched from PowerShell 7 can inherit a
  # PSModulePath that does not expose Windows PowerShell's Get-FileHash.
  $stream = [IO.File]::OpenRead($Filename)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant()
  } finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Read-NearLinkVersion([string]$Directory) {
  $file = Join-Path $Directory 'resources/app.asar'
  $stream = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if($reader.ReadUInt32() -ne 4){throw 'Invalid ASAR size header.'}
    [long]$headerSize = $reader.ReadUInt32()
    [void]$reader.ReadUInt32()
    [long]$jsonSize = $reader.ReadUInt32()
    if($headerSize -lt 8 -or $headerSize -gt 4194304 -or $jsonSize -lt 2 -or $jsonSize -gt ($headerSize-8)){throw 'Invalid ASAR header bounds.'}
    $headerBytes = $reader.ReadBytes([int]$jsonSize)
    if($headerBytes.Length -ne $jsonSize){throw 'Truncated ASAR header.'}
    $header = [Text.Encoding]::UTF8.GetString($headerBytes) | ConvertFrom-Json
    $entry = $header.files.'package.json'
    [long]$size = $entry.size
    [long]$offset = 8 + $headerSize + [long]$entry.offset
    if($size -lt 2 -or $size -gt 65536 -or $offset -lt (8+$headerSize) -or ($offset+$size) -gt $stream.Length){throw 'Invalid application package bounds.'}
    $stream.Position = $offset
    $packageBytes = $reader.ReadBytes([int]$size)
    $package = [Text.Encoding]::UTF8.GetString($packageBytes) | ConvertFrom-Json
    if($package.name -ne 'nearlink'){throw 'Installed application identity mismatch.'}
    return [string]$package.version
  } finally { $reader.Dispose(); $stream.Dispose() }
}
function Remove-ConfirmedInstaller {
  # Only after the installed version and new process startup are confirmed.
  for($attempt=0; $attempt -lt 8; $attempt++){
    try {
      Remove-Item -LiteralPath $request.installer -Force -ErrorAction Stop
      Write-InstallLog 'Confirmed update installer cache removed.'
      return
    } catch {
      if(-not (Test-Path -LiteralPath $request.installer)){return}
      Start-Sleep -Milliseconds 250
    }
  }
  Write-InstallLog 'Installer cache still busy; application will retry cleanup at next startup.'
}
try {
  $request = Get-Content -LiteralPath $RequestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if($request.version -notmatch '^\d{1,6}\.\d{1,6}\.\d{1,6}$' -or $request.sha256 -notmatch '^[a-f0-9]{64}$' -or $request.parentPid -le 0){throw 'Invalid install request.'}
  Write-InstallLog ('Preparing update to '+$request.version)
  $installer = Get-Item -LiteralPath $request.installer
  if($installer.Length -ne $request.size -or (Read-InstallerSha256 $request.installer) -ne $request.sha256){throw 'Installer integrity verification failed.'}
  if(-not (Test-Path -LiteralPath (Join-Path $request.installDirectory 'NearLink.exe'))){throw 'Current application executable was not found.'}
  Write-InstallStatus 'ready' 'Installer verified; waiting for application exit.'
  $parent = Get-Process -Id $request.parentPid -ErrorAction SilentlyContinue
  $parentStarted = if($parent){$parent.StartTime}else{$null}
  $deadline = (Get-Date).AddSeconds(60)
  while($parent){
    if((Get-Date) -gt $deadline){throw 'Application did not quit; update cancelled.'}
    Start-Sleep -Milliseconds 200
    $parent = Get-Process -Id $request.parentPid -ErrorAction SilentlyContinue
    if($parent -and $parent.StartTime -ne $parentStarted){break}
  }
  $parentExited = $true
  Write-InstallLog 'Application exited; starting NSIS update.'
  Write-InstallStatus 'installing' 'Installing update.'
  # NSIS requires /D= as the LAST parameter, WITHOUT surrounding quotes,
  # including directories containing spaces. Never pass these via a shell.
  $arguments = '--updated /S /D=' + $request.installDirectory
  $result = Start-Process -FilePath $request.installer -ArgumentList $arguments -WorkingDirectory (Split-Path -Parent $request.installer) -Wait -PassThru
  Write-InstallLog ('Installer exit code: '+$result.ExitCode)
  if($result.ExitCode -ne 0){throw ('Installer exited with code '+$result.ExitCode)}
  $installed = Read-NearLinkVersion $request.installDirectory
  if($installed -ne $request.version){throw ('Installer finished but version was not replaced: expected '+$request.version+', found '+$installed)}
  Write-InstallStatus 'installed' ('Verified installed version '+$installed)
  Write-InstallLog ('Installed version verified: '+$installed+'; requesting launch.')
  Start-Process -FilePath (Join-Path $request.installDirectory 'NearLink.exe') -ArgumentList '--updated' -WorkingDirectory $request.installDirectory | Out-Null
  $deadline = (Get-Date).AddSeconds(30)
  while((Get-Date) -lt $deadline){
    if(Test-Path -LiteralPath $request.startupFile){
      $started = Get-Content -LiteralPath $request.startupFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if($started.token -eq $request.token -and $started.version -eq $request.version){
        Write-InstallLog 'Updated application confirmed ready.'
        Write-InstallStatus 'completed' 'Update installed and application confirmed ready.'
        Remove-ConfirmedInstaller
        exit 0
      }
    }
    Start-Sleep -Milliseconds 200
  }
  Write-InstallLog 'Updated version installed; application launch not confirmed yet.'
  Write-InstallStatus 'installed' 'Updated version installed; open NearLink if its window is not visible.'
} catch {
  $message = $_.Exception.Message
  if($null -ne $request){
    try {Write-InstallLog ('FAILED: '+$message); Write-InstallStatus 'failed' $message} catch {}
    # Restore access to the previous application when it is still present.
    if($parentExited -and (Test-Path -LiteralPath (Join-Path $request.installDirectory 'NearLink.exe'))){
      try {Start-Process -FilePath (Join-Path $request.installDirectory 'NearLink.exe') -WorkingDirectory $request.installDirectory | Out-Null} catch {}
    }
  }
  [Console]::Error.WriteLine($message)
  exit 1
}
