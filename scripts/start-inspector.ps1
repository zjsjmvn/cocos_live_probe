$ErrorActionPreference = 'Stop'
$inspectorToolRoot = Split-Path -Parent $PSScriptRoot
$inspectorProjectRoot = [IO.Path]::GetFullPath((Join-Path $inspectorToolRoot '../..')).TrimEnd('\', '/')

# Associate this project shortcut with its Creator process before trusting a
# saved port. Another open project may currently own the usual port 7456.
$inspectorCreators = @(Get-CimInstance Win32_Process -Filter "Name = 'CocosCreator.exe'" | Where-Object {
    if ($_.CommandLine -match '(?:^|\s)--project(?:\s+|=)(?:"([^"]+)"|([^\s]+))') {
        $inspectorProcessProject = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        [IO.Path]::GetFullPath($inspectorProcessProject).TrimEnd('\', '/') -eq $inspectorProjectRoot
    }
})
if (!$inspectorCreators.Count) {
    throw "Open this project in Cocos Creator first: $inspectorProjectRoot"
}
$inspectorProfilePath = Join-Path $inspectorProjectRoot 'profiles/v2/packages/server.json'
$inspectorPort = 7456
if (Test-Path -LiteralPath $inspectorProfilePath) {
    $inspectorProfile = Get-Content -LiteralPath $inspectorProfilePath -Raw | ConvertFrom-Json
    if ($null -ne $inspectorProfile.server_port) { $inspectorPort = [int]$inspectorProfile.server_port }
}
if ($inspectorPort -lt 1 -or $inspectorPort -gt 65535) { throw 'Invalid Creator preview port.' }
$inspectorListeners = @(Get-NetTCPConnection -State Listen -LocalPort $inspectorPort -ErrorAction SilentlyContinue)
if (!($inspectorListeners | Where-Object { $_.OwningProcess -in $inspectorCreators.ProcessId })) {
    throw "Port $inspectorPort does not belong to this project's Creator. Use Shift+Enter in its editor to query the actual preview URL."
}
$env:COCOS_RUNTIME_PROBE_WORKSPACE_ROOT = $inspectorProjectRoot
$env:COCOS_RUNTIME_PROBE_PREVIEW_URL = "http://127.0.0.1:$inspectorPort/"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Set-Location -LiteralPath $inspectorToolRoot
$inspectorExecutable = & (Join-Path $PSScriptRoot 'find-inspector-package.ps1')
if ($inspectorExecutable) {
    # This is the interactive inspector the user requested, so show its window.
    Start-Process -FilePath $inspectorExecutable -WorkingDirectory $inspectorToolRoot -WindowStyle Normal
} else {
    & npm.cmd run runtime:probe:inspector
    if ($LASTEXITCODE -ne 0) { throw 'Inspector failed to start.' }
}
