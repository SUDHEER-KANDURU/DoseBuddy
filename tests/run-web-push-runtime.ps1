$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$stdout = Join-Path $env:TEMP "dosebuddy-workerd-out.log"
$stderr = Join-Path $env:TEMP "dosebuddy-workerd-err.log"
$wrangler = Join-Path $root "node_modules\wrangler\bin\wrangler.js"
if (-not (Test-Path $wrangler)) { throw "Wrangler is not installed; run npm ci before the local workerd check" }
Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
# Launch Wrangler's Node entry point directly. Starting npx.cmd only observes the
# short-lived wrapper, not the process that owns the local workerd runtime.
$arguments = '"{0}" dev --config "tests/wrangler.web-push.jsonc" --port 8791 --ip 127.0.0.1' -f $wrangler
$process = Start-Process -FilePath "node.exe" -ArgumentList $arguments -WorkingDirectory $root -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
try {
  $response = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) {
      $logs = @((Get-Content $stdout -Raw -ErrorAction SilentlyContinue), (Get-Content $stderr -Raw -ErrorAction SilentlyContinue)) -join [Environment]::NewLine
      throw "Wrangler exited before the runtime check completed (exit $($process.ExitCode)): $logs"
    }
    try {
      $response = Invoke-RestMethod -Uri "http://127.0.0.1:8791" -TimeoutSec 2 -ErrorAction Stop
      if ($response) { break }
    } catch {}
  }
  if (-not $response -or -not $response.ok -or $response.encoding -ne "aes128gcm") { throw "Local workerd Web Push check failed" }
  if ($response.schedulerRows -ne 10000 -or $response.schedulerDue -ne 7 -or $response.schedulerMs -ge 1000) { throw "Local workerd scheduler volume check failed" }
  Write-Output "Local workerd Web Crypto Web Push check passed"
  Write-Output ("Local workerd scheduler volume check passed: {0} rows in {1:N1}ms" -f $response.schedulerRows, $response.schedulerMs)
} finally {
  if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
  Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
}
