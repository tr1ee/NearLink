param([switch]$Elevated, [string]$ExpectedSha256)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'native\prebuilds\win32-x64\NearLinkInput.exe'
$manifest = Join-Path $repo 'work\development-input-helper.json'
$digest = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $Elevated) {
  $arguments = @('-NoProfile', '-File', ('"' + $PSCommandPath + '"'), '-Elevated', '-ExpectedSha256', $digest)
  $powershell = Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $installer = Start-Process -FilePath $powershell -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw 'Protected helper installation failed.' }
  Get-Content -LiteralPath $manifest
  exit 0
}
if ($ExpectedSha256 -notmatch '^[a-f0-9]{64}$' -or $digest -ne $ExpectedSha256) {
  throw 'Build changed while local UAC approval was pending.'
}
$root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'NearLink-Input-Debug'
$directory = Join-Path $root $digest
$target = Join-Path $directory 'NearLinkInput.exe'
foreach ($folder in @($root, $directory)) {
  if (Test-Path -LiteralPath $folder) {
    if ((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint) {
      throw 'Refusing a reparse-point installation directory.'
    }
  } else { New-Item -ItemType Directory -Path $folder | Out-Null }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  foreach ($rule in @(@('S-1-5-18','FullControl'), @('S-1-5-32-544','FullControl'), @('S-1-5-32-545','ReadAndExecute'))) {
    $sid = New-Object Security.Principal.SecurityIdentifier($rule[0])
    $access = New-Object Security.AccessControl.FileSystemAccessRule($sid, $rule[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($access)
  }
  Set-Acl -LiteralPath $folder -AclObject $acl
}
if (Test-Path -LiteralPath $target) {
  if ((Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a reparse-point image.' }
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw 'Protected image mismatch.' }
} else { Copy-Item -LiteralPath $source -Destination $target }
$imageAcl = New-Object Security.AccessControl.FileSecurity
$imageAcl.SetAccessRuleProtection($true, $false)
$imageAcl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
foreach ($rule in @(@('S-1-5-18','FullControl'), @('S-1-5-32-544','FullControl'), @('S-1-5-32-545','ReadAndExecute'))) {
  $sid = New-Object Security.Principal.SecurityIdentifier($rule[0])
  $imageAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rule[1], 'Allow')))
}
Set-Acl -LiteralPath $target -AclObject $imageAcl
if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw 'Installed digest mismatch.' }
New-Item -ItemType Directory -Path (Split-Path -Parent $manifest) -Force | Out-Null
@{path=$target;sha256=$digest} | ConvertTo-Json -Compress | Set-Content -LiteralPath $manifest -Encoding Ascii
