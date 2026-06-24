param(
  [int]$Port = 5173
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
$server.Start()
Write-Host "TCL Plan Agent AI demo server started: http://127.0.0.1:$Port/"

function Get-ContentType($path) {
  switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
    ".html" { "text/html; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    default { "application/octet-stream" }
  }
}

function Send-Response($stream, $status, $contentType, [byte[]]$body) {
  $header = "HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: content-type`r`nAccess-Control-Allow-Methods: GET,POST,OPTIONS`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  $stream.Write($body, 0, $body.Length)
}

function Send-Json($stream, $status, $obj) {
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  Send-Response $stream $status "application/json; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes($json))
}

function Read-HttpRequest($stream) {
  $buffer = New-Object byte[] 65536
  $read = $stream.Read($buffer, 0, $buffer.Length)
  if ($read -le 0) { return $null }
  $text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  $parts = $text -split "`r`n`r`n", 2
  $headerText = $parts[0]
  $body = if ($parts.Length -gt 1) { $parts[1] } else { "" }
  $lines = $headerText -split "`r`n"
  $requestLine = $lines[0] -split " "
  $headers = @{}
  foreach ($line in $lines[1..($lines.Length - 1)]) {
    $idx = $line.IndexOf(":")
    if ($idx -gt 0) {
      $headers[$line.Substring(0, $idx).Trim().ToLowerInvariant()] = $line.Substring($idx + 1).Trim()
    }
  }
  $contentLength = 0
  if ($headers.ContainsKey("content-length")) { [int]::TryParse($headers["content-length"], [ref]$contentLength) | Out-Null }
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  while ($bodyBytes.Length -lt $contentLength) {
    $next = New-Object byte[] ($contentLength - $bodyBytes.Length)
    $nextRead = $stream.Read($next, 0, $next.Length)
    if ($nextRead -le 0) { break }
    $bodyBytes = $bodyBytes + $next[0..($nextRead - 1)]
  }
  return @{ Method = $requestLine[0]; Path = $requestLine[1]; Body = [System.Text.Encoding]::UTF8.GetString($bodyBytes) }
}

function Invoke-AI($config, $messages, [bool]$JsonMode) {
  if (-not $config.apiKey -or -not $config.baseUrl -or -not $config.model) {
    throw "AI service is not configured"
  }
  $endpoint = $config.baseUrl.TrimEnd("/") + "/chat/completions"
  $payload = @{
    model = $config.model
    messages = $messages
    temperature = 0.2
  }
  if ($JsonMode) { $payload.response_format = @{ type = "json_object" } }
  $bodyJson = $payload | ConvertTo-Json -Depth 12
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($bodyJson)
  try {
    $request = [System.Net.HttpWebRequest]::Create($endpoint)
    $request.Method = "POST"
    $request.ContentType = "application/json; charset=utf-8"
    $request.Headers.Add("Authorization", "Bearer $($config.apiKey)")
    $request.ContentLength = $bodyBytes.Length
    $requestStream = $request.GetRequestStream()
    $requestStream.Write($bodyBytes, 0, $bodyBytes.Length)
    $requestStream.Close()

    $response = $request.GetResponse()
    $responseStream = $response.GetResponseStream()
    $memoryStream = New-Object System.IO.MemoryStream
    $responseStream.CopyTo($memoryStream)
    $responseBytes = $memoryStream.ToArray()
    $responseStream.Close()
    $response.Close()

    $responseText = [System.Text.Encoding]::UTF8.GetString($responseBytes)
    $responseText | ConvertFrom-Json
  } catch {
    throw "Cannot connect to AI service: $endpoint. Check network, proxy, firewall, Base URL, Model, or API Key. Raw error: $($_.Exception.Message)"
  }
}

try {
  while ($true) {
    $client = $server.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $request = Read-HttpRequest $stream
      if ($null -eq $request) { continue }
      $pathOnly = ($request.Path -split "\?")[0]

      if ($request.Method -eq "OPTIONS") {
        Send-Response $stream "204 No Content" "text/plain" ([byte[]]::new(0))
      } elseif ($request.Method -eq "POST" -and $pathOnly -eq "/api/decompose") {
        $data = $request.Body | ConvertFrom-Json
        $task = $data.task
        $messages = @(
          @{ role = "system"; content = "You are a task decomposition assistant. Based on the user's task name and description, split the task into 5-8 executable steps. Do not split by date. Do not create a schedule. Steps must be checkable. Return JSON only in this exact shape: {`"steps`":[`"step 1`",`"step 2`",`"step 3`"]}. Use the same language as the user's task." },
          @{ role = "user"; content = "Task name: $($task.name)`nTask description: $($task.description)`nTask type: $($task.type)`nDeadline: $($task.deadline)" }
        )
        $ai = Invoke-AI $data.demoConfig $messages $true
        $content = $ai.choices[0].message.content -replace '^```json\s*', '' -replace '```$', ''
        $parsed = $content | ConvertFrom-Json
        Send-Json $stream "200 OK" @{ steps = @($parsed.steps) }
      } elseif ($request.Method -eq "POST" -and $pathOnly -eq "/api/ask") {
        $data = $request.Body | ConvertFrom-Json
        $task = $data.task
        $steps = ($task.steps | ForEach-Object { $_.title }) -join "`n"
        $messages = @()
        $messages += @{ role = "system"; content = "You are a personal task planning agent. Answer based on the current task and previous conversation. Avoid making things up. If information is insufficient, ask the user for more details. Use the same language as the user." }
        $messages += @{ role = "user"; content = "Current task: $($task.name)`nTask description: $($task.description)`nExisting steps: $steps" }
        if ($data.messages) {
          foreach ($message in $data.messages) {
            if (($message.role -eq "user" -or $message.role -eq "assistant") -and $message.content) {
              $messages += @{ role = $message.role; content = $message.content }
            }
          }
        } else {
          $messages += @{ role = "user"; content = "$($data.question)" }
        }
        $ai = Invoke-AI $data.demoConfig $messages $false
        Send-Json $stream "200 OK" @{ answer = $ai.choices[0].message.content }
      } else {
        $requestPath = [Uri]::UnescapeDataString($pathOnly.TrimStart("/"))
        if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = "demo.html" }
        $safePath = $requestPath -replace "/", [System.IO.Path]::DirectorySeparatorChar
        $filePath = Join-Path $root $safePath
        $resolvedRoot = [System.IO.Path]::GetFullPath($root)
        $resolvedFile = [System.IO.Path]::GetFullPath($filePath)
        if (-not $resolvedFile.StartsWith($resolvedRoot) -or -not (Test-Path -LiteralPath $resolvedFile -PathType Leaf)) {
          Send-Response $stream "404 Not Found" "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes("Not Found"))
        } else {
          Send-Response $stream "200 OK" (Get-ContentType $resolvedFile) ([System.IO.File]::ReadAllBytes($resolvedFile))
        }
      }
    } catch {
      Send-Json $stream "500 Internal Server Error" @{ error = "$($_.Exception.Message)" }
    } finally {
      $client.Close()
    }
  }
} finally {
  $server.Stop()
}
