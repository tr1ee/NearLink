param([Parameter(Mandatory=$true)][string]$Request,[Parameter(Mandatory=$true)][string]$RequestSha256,[switch]$Elevated)
$ErrorActionPreference='Stop'
if($RequestSha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Request -Algorithm SHA256).Hash.ToLowerInvariant() -ne $RequestSha256){throw 'Installation request changed.'}
if(-not $Elevated){
  $shell=Join-Path ([Environment]::GetFolderPath('System')) 'WindowsPowerShell\v1.0\powershell.exe'
  $arguments=@('-NoProfile','-File',('"'+$PSCommandPath+'"'),'-Request',('"'+$Request+'"'),'-RequestSha256',$RequestSha256,'-Elevated')
  $installer=Start-Process -FilePath $shell -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $installer.ExitCode
}
$plan=Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
if($plan.version -ne 1 -or $plan.host -notmatch '^[a-f0-9]{64}$' -or @($plan.peers).Count -lt 1 -or @($plan.peers).Count -gt 16){throw 'Invalid service policy.'}
foreach($peer in $plan.peers){if($peer -notmatch '^[a-f0-9]{64}$'){throw 'Invalid approved device.'}}
$sid=New-Object Security.Principal.SecurityIdentifier($plan.userSid)
if($sid.Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Install must use the same Windows account; another administrator account is not accepted.'}
$profile=[IO.Path]::GetFullPath($plan.profile)
if($profile.Contains('"') -or $profile.Contains("`n")){throw 'Invalid profile.'}
Add-Type -AssemblyName System.Windows.Forms
$base=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'NearLinkDesktop'
$needsGrant=$true
$previous=Get-CimInstance Win32_Service -Filter "Name='NearLinkDesktopService'" -ErrorAction SilentlyContinue
if($previous){
  $oldImage=$previous.PathName.Trim('"')
  if($oldImage.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase) -and $oldImage.EndsWith('\NearLinkService.exe',[StringComparison]::OrdinalIgnoreCase)){
    $oldPolicy=Join-Path (Split-Path -Parent $oldImage) 'service-policy.txt'
    if(Test-Path -LiteralPath $oldPolicy){
      $old=@(Get-Content -LiteralPath $oldPolicy -Encoding UTF8)
      if($old.Count -ge 5 -and $old[0] -eq $sid.Value -and $old[1] -eq $plan.host -and $old[4] -eq $profile -and (($old[3].Split(',') | Sort-Object) -join ',') -eq (($plan.peers | Sort-Object) -join ',')){$needsGrant=$false}
    }
  }
}
$question="首次安装 NearLink 无人值守服务？`n`n将允许以下已配对设备在本 Windows 用户的活动登录会话中查看和操作普通桌面、管理员应用及 UAC／锁屏安全桌面。断线仍释放键鼠，重新连接不再要求本机确认。`n`n批准的设备指纹：`n"+($plan.peers -join "`n")+"`n`n可在 Windows 服务管理器停止或禁用 NearLinkDesktopService。"
if($needsGrant -and [Windows.Forms.MessageBox]::Show($question,'NearLink · 安装无人值守服务','YesNo','Warning','Button2') -ne 'Yes'){exit 2}
$serviceFile=@($plan.files | Where-Object target -eq 'NearLinkService.exe')
if($serviceFile.Count -ne 1 -or $serviceFile[0].sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Missing service image.'}
$target=Join-Path $base $RequestSha256
function Protect-Folder([string]$folder){
  if(Test-Path -LiteralPath $folder){if((Get-Item -LiteralPath $folder).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Reparse point refused.'}}
  else{New-Item -ItemType Directory -Path $folder | Out-Null}
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  foreach($rule in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-32-545','ReadAndExecute'))){
    $principal=New-Object Security.Principal.SecurityIdentifier($rule[0])
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($principal,$rule[1],'ContainerInherit,ObjectInherit','None','Allow')))
  }
  Set-Acl -LiteralPath $folder -AclObject $acl
}
Protect-Folder $base
Protect-Folder $target
$prefix=[IO.Path]::GetFullPath($target).TrimEnd('\')+'\'
foreach($file in $plan.files){
  if($file.sha256 -notmatch '^[a-f0-9]{64}$' -or [IO.Path]::IsPathRooted($file.target) -or $file.target.Contains(':')){throw 'Invalid file entry.'}
  $destination=[IO.Path]::GetFullPath((Join-Path $target $file.target))
  if(-not $destination.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Installation path escaped target.'}
  if((Get-FileHash -LiteralPath $file.source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Source changed after approval.'}
  $parent=Split-Path -Parent $destination
  # Only administrator-created descendants of this checked protected root.
  if(-not(Test-Path -LiteralPath $parent)){New-Item -ItemType Directory -Path $parent -Force | Out-Null}
  $walk=$parent
  while($walk.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){
    if((Get-Item -LiteralPath $walk).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Destination reparse point refused.'}
    $walk=Split-Path -Parent $walk
  }
  if(Test-Path -LiteralPath $destination){
    if((Get-Item -LiteralPath $destination).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Destination reparse point refused.'}
    if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.sha256){continue}
    throw 'Existing protected build differs; use a new build directory.'
  }
  Copy-Item -LiteralPath $file.source -Destination $destination
  if((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256){throw 'Copied file digest mismatch.'}
}
$client=Join-Path $target 'Client\electron.exe'
& icacls.exe $target /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect installed file ownership.'}
$clientHash=(Get-FileHash -LiteralPath $client -Algorithm SHA256).Hash.ToLowerInvariant()
$policy=@($sid.Value,$plan.host,$clientHash,($plan.peers -join ','),$profile) -join "`n"
[IO.File]::WriteAllText((Join-Path $target 'service-policy.txt'),$policy,(New-Object Text.UTF8Encoding($false)))
$existing=Get-Service -Name NearLinkDesktopService -ErrorAction SilentlyContinue
if($existing){
  $oldPid=(Get-CimInstance Win32_Service -Filter "Name='NearLinkDesktopService'").ProcessId
  $clients=@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $oldPid -and $_.ExecutablePath -like ($base+'\*\Client\electron.exe') })
  Stop-Service -Name NearLinkDesktopService -Force;$existing.WaitForStatus('Stopped',[TimeSpan]::FromSeconds(15))
  foreach($client in $clients){
    $current=Get-CimInstance Win32_Process -Filter "ProcessId=$($client.ProcessId)" -ErrorAction SilentlyContinue
    if($current -and $current.CreationDate -eq $client.CreationDate -and $current.ExecutablePath -eq $client.ExecutablePath){Stop-Process -Id $client.ProcessId -ErrorAction SilentlyContinue}
  }
}
$image='"'+(Join-Path $target 'NearLinkService.exe')+'"'
# Use Unicode SCM APIs: Windows PowerShell's native-argument quoting otherwise
# removes the quotes around an executable under Program Files.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NearLinkServiceSetup {
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenSCManagerW(string machine,string database,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenServiceW(IntPtr manager,string name,uint access);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateServiceW(IntPtr manager,string name,string display,uint access,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,string password);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ChangeServiceConfigW(IntPtr service,uint type,uint start,uint error,string binary,string group,IntPtr tag,string dependencies,string account,string password,string display);
 [DllImport("advapi32.dll")] static extern bool CloseServiceHandle(IntPtr handle);
 public static void Install(string binary) {
  IntPtr manager=OpenSCManagerW(null,null,3),service=IntPtr.Zero;
  if(manager==IntPtr.Zero)throw new Win32Exception();
  try {
   service=OpenServiceW(manager,"NearLinkDesktopService",2);
   if(service!=IntPtr.Zero){if(!ChangeServiceConfigW(service,0xffffffff,2,0xffffffff,binary,null,IntPtr.Zero,null,"LocalSystem",null,"NearLink Desktop Service"))throw new Win32Exception();}
   else {if(Marshal.GetLastWin32Error()!=1060)throw new Win32Exception();service=CreateServiceW(manager,"NearLinkDesktopService","NearLink Desktop Service",2,16,2,1,binary,null,IntPtr.Zero,null,"LocalSystem",null);if(service==IntPtr.Zero)throw new Win32Exception();}
  }finally{if(service!=IntPtr.Zero)CloseServiceHandle(service);CloseServiceHandle(manager);}
 }
}
'@
[NearLinkServiceSetup]::Install($image)
& sc.exe description NearLinkDesktopService 'NearLink authenticated remote desktop broker and active-session desktop workers.' | Out-Null
& sc.exe failure NearLinkDesktopService reset= 86400 actions= restart/5000/restart/10000/none/0 | Out-Null
& sc.exe sdset NearLinkDesktopService 'D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;BU)' | Out-Null
Start-Service -Name NearLinkDesktopService
(Get-Service -Name NearLinkDesktopService).WaitForStatus('Running',[TimeSpan]::FromSeconds(15))
Write-Output 'NearLink desktop service installed and running. No private identity keys were copied to the service.'
