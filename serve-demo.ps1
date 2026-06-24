param(
  [int]$Port = 5173
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
$server.Start()
Write-Host "TCL雏鹰成长Agent 演示服务已启动：http://localhost:$Port/"

function Get-ContentType($path) {
  switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    ".svg" { "image/svg+xml" }
    default { "application/octet-stream" }
  }
}

function Send-Response($stream, $status, $contentType, [byte[]]$body) {
  $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  $stream.Write($body, 0, $body.Length)
}

try {
  while ($true) {
    $client = $server.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $buffer = New-Object byte[] 8192
      $read = $stream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) {
        continue
      }

      $request = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
      $firstLine = ($request -split "`r`n")[0]
      $parts = $firstLine -split " "
      $urlPath = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
      $urlPath = ($urlPath -split "\?")[0]
      $requestPath = [Uri]::UnescapeDataString($urlPath.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($requestPath)) {
        $requestPath = "demo.html"
      }

      $safePath = $requestPath -replace "/", [System.IO.Path]::DirectorySeparatorChar
      $filePath = Join-Path $root $safePath
      $resolvedRoot = [System.IO.Path]::GetFullPath($root)
      $resolvedFile = [System.IO.Path]::GetFullPath($filePath)

      if (-not $resolvedFile.StartsWith($resolvedRoot) -or -not (Test-Path -LiteralPath $resolvedFile -PathType Leaf)) {
        $body = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
        Send-Response $stream "404 Not Found" "text/plain; charset=utf-8" $body
      } else {
        $body = [System.IO.File]::ReadAllBytes($resolvedFile)
        Send-Response $stream "200 OK" (Get-ContentType $resolvedFile) $body
      }
    } catch {
      $body = [System.Text.Encoding]::UTF8.GetBytes("Server Error")
      Send-Response $stream "500 Internal Server Error" "text/plain; charset=utf-8" $body
    } finally {
      $client.Close()
    }
  }
} finally {
  $server.Stop()
}
