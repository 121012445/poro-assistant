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
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans'))
if ($null -eq $engine) {
  # Some systems register the OCR language as zh-CN / zh-Hans-CN; try every installed Simplified Chinese recognizer.
  foreach ($candidate in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    if ($candidate.LanguageTag -match '^zh-(Hans|CN|SG)') {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($candidate)
      if ($null -ne $engine) { break }
    }
  }
}
if ($null -eq $engine) {
  $installed = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join ', '
  if (-not $installed) { $installed = 'none' }
  # Augment names are Simplified Chinese, so never fall back to another OCR language.
  # KEEP THIS FILE PURE ASCII (comments included). It has no BOM, so Windows PowerShell 5.1 decodes it with the
  # system ANSI code page (GBK on Chinese Windows). UTF-8 Chinese text then swallows line breaks and turns the
  # next line into a comment: 1.5.7 lost a 'foreach' line this way and the whole script failed to parse.
  # The user-facing Chinese message is produced by main/ocr-worker.js. Guarded by test_ps1_ascii.js.
  throw "OCR_LANG_MISSING installed=$installed"
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
      [Console]::Out.WriteLine('OK' + "`t" + [Convert]::ToBase64String($utf8.GetBytes($result.Text)))
      [Console]::Out.Flush()
    } finally { $stream.Dispose() }
  } catch {
    [Console]::Out.WriteLine('ERR' + "`t" + [Convert]::ToBase64String($utf8.GetBytes($_.Exception.Message)))
    [Console]::Out.Flush()
  }
}
