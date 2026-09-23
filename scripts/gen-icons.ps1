# Generates the tray state icons (16px + @2x) and the app icon into resources/.
# Run with: npm run icons
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$trayDir = Join-Path $root 'resources\tray'
New-Item -ItemType Directory -Force $trayDir | Out-Null

$states = [ordered]@{
  idle      = '#7C5CFF'
  listening = '#22C55E'
  thinking  = '#F59E0B'
  speaking  = '#3B82F6'
  muted     = '#6B7280'
  offline   = '#EF4444'
}

function New-Icon([int]$size, [string]$hex, [bool]$slash, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear([System.Drawing.Color]::Transparent)

  $inset = [Math]::Max(1, [int]($size * 0.04))
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $g.FillEllipse($brush, $inset, $inset, $size - 2 * $inset, $size - 2 * $inset)

  $font = New-Object System.Drawing.Font 'Segoe UI', ([single]($size * 0.52)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'
  $fmt.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF 0, ([single]($size * 0.03)), $size, $size
  $g.DrawString('A', $font, [System.Drawing.Brushes]::White, $rect, $fmt)

  if ($slash) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ([single][Math]::Max(1.5, $size * 0.1))
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $g.DrawLine($pen, [single]($size * 0.22), [single]($size * 0.22), [single]($size * 0.78), [single]($size * 0.78))
  }

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

foreach ($name in $states.Keys) {
  $slash = $name -eq 'muted'
  New-Icon 16 $states[$name] $slash (Join-Path $trayDir "$name.png")
  New-Icon 32 $states[$name] $slash (Join-Path $trayDir "$name@2x.png")
}

New-Icon 256 $states['idle'] $false (Join-Path $root 'resources\icon.png')
New-Icon 512 $states['idle'] $false (Join-Path $root 'build\icon.png')
Write-Output "Icons written to $trayDir"
