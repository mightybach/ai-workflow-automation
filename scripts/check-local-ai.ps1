param(
  [string]$BaseUrl = 'http://127.0.0.1:11434',
  [switch]$PreflightOnly,
  [ValidateRange(10, 300)][int]$TimeoutSeconds = 120
)
$ErrorActionPreference = 'Stop'
$model = 'qwen3:4b-instruct-2507-q4_K_M'
$target = [uri]$BaseUrl
if ($target.Scheme -ne 'http' -or $target.Host -notin @('127.0.0.1', 'localhost', '[::1]') -or $target.UserInfo -or $target.Query -or $target.Fragment -or $target.AbsolutePath -ne '/') {
  throw 'Use a plain loopback HTTP Ollama URL, without credentials, query or path.'
}
$endpoint = $target.GetLeftPart([System.UriPartial]::Authority)
function Get-LocalJson([string]$Path) {
  Invoke-RestMethod -Uri ($endpoint + $Path) -TimeoutSec 5 -MaximumRedirection 0
}
function Send-LocalJson([string]$Path, $Body) {
  Invoke-RestMethod -Method Post -Uri ($endpoint + $Path) -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 12 -Compress) -TimeoutSec $TimeoutSeconds -MaximumRedirection 0
}
try { $version = Get-LocalJson '/api/version' }
catch { throw 'Ollama is not reachable. Install/start the local runtime, then rerun this script. See scripts/LOCAL_AI_SETUP.md.' }
if (!$version.version) { throw 'The local service did not return an Ollama version.' }
$tags = Get-LocalJson '/api/tags'
$installed = @($tags.models | Where-Object { $_.name -ceq $model })
if ($installed.Count -ne 1 -or $installed[0].digest -notmatch '^[a-f0-9]{64}$' -or $installed[0].size -le 0) {
  throw "Exact local model missing. Run: ollama pull $model"
}
Write-Output "Runtime: Ollama $($version.version)"
Write-Output "Model: $model"
Write-Output "Digest: $($installed[0].digest)"
Write-Output ('Model disk size: {0:N2} GiB (not total inference RAM).' -f ($installed[0].size / 1GB))
if ($PreflightOnly) { Write-Output 'PASS: local API/model preflight. Inference and extraction quality have not been tested.'; return }

# Synthetic, fixed capability check only. Never reads application/DB/customer data.
$schema = @{
  type = 'object'; additionalProperties = $false
  properties = @{
    serviceName = @{ type = 'string' }; staffName = @{ type = 'string' }
    durationMinutes = @{ type = 'integer' }; date = @{ type = 'string' }
  }
  required = @('serviceName', 'staffName', 'durationMinutes', 'date')
}
$watch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $result = Send-LocalJson '/api/chat' @{
    model = $model; stream = $false; keep_alive = '30s'; format = $schema
    options = @{ temperature = 0; num_ctx = 2048; num_predict = 200 }
    messages = @(
      @{ role = 'system'; content = 'Extract appointment preferences only. Return JSON with serviceName, staffName, durationMinutes and date (yyyy-mm-dd). Do not book, claim availability, call tools or add fields. Available services: Haircut, Consultation. Staff: Alex, Jamie.' },
      @{ role = 'user'; content = 'Haircut with Alex on 19-11-2026 for 60 minutes.' }
    )
  }
  $watch.Stop()
  if ($result.model -cne $model -or $result.done -ne $true -or $result.message.role -ne 'assistant' -or $result.message.tool_calls) { throw 'Unexpected model/incomplete/tool response.' }
  $parsed = $result.message.content | ConvertFrom-Json
  $fields = @($parsed.PSObject.Properties.Name | Sort-Object)
  if (($fields -join ',') -cne 'date,durationMinutes,serviceName,staffName') { throw 'Unexpected JSON fields.' }
  if ($parsed.serviceName -cne 'Haircut' -or $parsed.staffName -cne 'Alex' -or $parsed.date -cne '2026-11-19' -or $parsed.durationMinutes -is [string] -or $parsed.durationMinutes -ne 60) {
    throw 'Synthetic extraction did not match the expected typed values.'
  }
  Write-Output ('PASS: synthetic structured-output smoke in {0:N2} seconds.' -f $watch.Elapsed.TotalSeconds)
  Write-Output 'Expected preferences matched. This is not a quality evaluation or booking integration.'
  try {
    $running = Get-LocalJson '/api/ps'
    $loaded = @($running.models | Where-Object { $_.name -ceq $model })
    if ($loaded.Count) {
      Write-Output ('Runtime allocated: {0:N2} GiB; reported VRAM allocation: {1:N2} GiB.' -f ($loaded[0].size / 1GB), ($loaded[0].size_vram / 1GB))
    }
  } catch { Write-Output 'Runtime allocation was not reported; no GPU acceleration is asserted.' }
} catch {
  throw 'Local model smoke failed (timeout, runtime/memory error, or invalid structured output). The booking app remains on mock. Close unused apps, check Ollama, and rerun; do not treat this as validated extraction.'
} finally {
  # Unload only the smoke-test model, not another application/model.
  try { Send-LocalJson '/api/generate' @{ model = $model; stream = $false; keep_alive = 0 } | Out-Null }
  catch { Write-Output "If still loaded, unload manually: ollama stop $model" }
}
