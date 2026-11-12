$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

function Await-WinRt($Operation, [Type]$ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
$available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
$selected = $available | Where-Object { $_.LanguageTag -match '^en(?:-|$)' } | Select-Object -First 1
if ($null -eq $selected) {
  $selected = $available | Where-Object { $_.LanguageTag -match '^zh-(Hans|CN|SG)' } | Select-Object -First 1
}
if ($null -eq $selected) {
  $installed = @($available | ForEach-Object { $_.LanguageTag }) -join ', '
  if (-not $installed) { $installed = 'none' }
  throw "CHAT_OCR_LANG_MISSING installed=$installed"
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($selected)
if ($null -eq $engine) {
  throw "CHAT_OCR_CREATE_FAILED language=$($selected.LanguageTag)"
}
[Console]::OutputEncoding = $utf8

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $imagePath = $utf8.GetString([Convert]::FromBase64String($line.Trim()))
    $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path -LiteralPath $imagePath).Path)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $lineTexts = @()
      foreach ($ocrLine in $result.Lines) { if ($ocrLine.Text) { $lineTexts += $ocrLine.Text } }
      if (-not $lineTexts.Count) { $lineTexts = @($result.Text) }
      $joined = $lineTexts -join "`n"
      [Console]::Out.WriteLine('OK' + "`t" + [Convert]::ToBase64String($utf8.GetBytes($joined)))
      [Console]::Out.Flush()
    } finally { $stream.Dispose() }
  } catch {
    [Console]::Out.WriteLine('ERR' + "`t" + [Convert]::ToBase64String($utf8.GetBytes($_.Exception.Message)))
    [Console]::Out.Flush()
  }
}
