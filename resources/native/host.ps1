# AI-DA Windows helper host. Reads one JSON request per line on stdin and writes one JSON
# response per line on stdout. Only the commands in the switch below can run; arguments are
# parsed as JSON data and never evaluated as script.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -Path (Join-Path $PSScriptRoot 'AidaWin.cs')
[Aida.Win]::Init()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.TrimStart([char]0xFEFF)
  if ($line.Trim() -eq '') { continue }
  $result = $null
  $response = @{ id = $null; ok = $false }
  try {
    $request = $line | ConvertFrom-Json
    $response.id = $request.id
    $a = $request.args
    switch ($request.cmd) {
      'ping' { $result = 'pong' }
      'volume.get' { $result = @{ level = [Aida.Audio]::GetVolume(); muted = [Aida.Audio]::GetMute() } }
      'volume.set' { $result = @{ level = [Aida.Audio]::SetVolume([int]$a.level); muted = [Aida.Audio]::GetMute() } }
      'mute.set' { $result = @{ level = [Aida.Audio]::GetVolume(); muted = [Aida.Audio]::SetMute([bool]$a.muted) } }
      'media.key' { [Aida.Win]::MediaKey([string]$a.action); $result = $true }
      'windows.list' { $result = @([Aida.Win]::List()) }
      'windows.foreground' { $result = [Aida.Win]::Foreground() }
      'windows.act' { $result = [Aida.Win]::Act([long]$a.handle, [string]$a.action) }
      'apps.list' { $result = @(Get-StartApps | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } }) }
      default { throw "Unknown command: $($request.cmd)" }
    }
    $response.ok = $true
    $response.result = $result
  } catch {
    $response.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 6))
  [Console]::Out.Flush()
}

