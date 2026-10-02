$ErrorActionPreference = 'Stop'
$base = Join-Path $PSScriptRoot '..'
Set-Location $base
$db = Join-Path $base 'data\smoke.db'
$env:COOKIEJAR_DB = $db

$p = Start-Process node -ArgumentList 'dist/server.js','--port','8765' -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Seconds 2
  Write-Host '--- health ---'
  (Invoke-RestMethod http://127.0.0.1:8765/health | ConvertTo-Json -Compress)
  Write-Host "`n--- create jar ---"
  $jar = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"name":"smoke-jar"}' http://127.0.0.1:8765/jars
  ($jar | ConvertTo-Json -Compress)
  $id = $jar.jar.id
  Write-Host "`n--- import ---"
  $body = @'
{"sourceUrl":"https://shop.example.test/cart/checkout","setCookies":["sid=abc; Path=/cart; HttpOnly","ui=dark; Domain=example.test; Path=/","tok=x; Secure; Domain=example.test; Path=/"],"now":1790928000000}
'@
  $imp = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body "http://127.0.0.1:8765/jars/$id/import"
  ($imp.results | ForEach-Object { "$($_.action) $($_.reason)" })
  Write-Host "`n--- preview https://www.example.test/cart/pay ---"
  $pv = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{"requestUrl":"https://www.example.test/cart/pay","now":1790928000000}' "http://127.0.0.1:8765/jars/$id/preview"
  Write-Host "header: $($pv.cookieHeader)"
  Write-Host "excluded reasons: $(($pv.excluded | ForEach-Object { $_.reason }) -join ', ')"
  Write-Host "`n--- 404 check ---"
  try { Invoke-RestMethod http://127.0.0.1:8765/nope } catch {
    $r = $_.Exception.Response
    Write-Host "status=$($r.StatusCode.value__)"
    $sr = New-Object System.IO.StreamReader($r.GetResponseStream()); $sr.ReadToEnd()
  }
} finally {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Remove-Item "$db*" -Force -ErrorAction SilentlyContinue
}
