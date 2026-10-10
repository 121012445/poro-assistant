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
  # 部分系统登记的 OCR 语言标签是 zh-CN / zh-Hans-CN 等, 不一定能按 'zh-Hans' 直接创建: 逐个匹配已安装的简体中文
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
  # 强化名称是简体中文, 其他语言的 OCR 引擎识别不出来, 所以不退回其他语言。
  # 本文件没有 BOM, Windows PowerShell 5.1 会按系统 ANSI 代码页读它: 报错只用 ASCII, 中文提示由 main/ocr-worker.js 翻译。
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
