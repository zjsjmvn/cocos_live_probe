$inspectorRoot = Split-Path -Parent $PSScriptRoot
$inspectorCandidates = Get-ChildItem -LiteralPath $inspectorRoot -Directory -Filter 'releases*' | ForEach-Object {
    $inspectorPackage = Join-Path $_.FullName 'Cocos Live Probe Inspector-win32-x64'
    $inspectorExecutable = Join-Path $inspectorPackage 'Cocos Live Probe Inspector.exe'
    $inspectorArchive = Join-Path $inspectorPackage 'resources/app.asar'
    if ((Test-Path -LiteralPath $inspectorExecutable) -and (Test-Path -LiteralPath $inspectorArchive)) {
        [PSCustomObject]@{ Executable = $inspectorExecutable; BuiltAt = (Get-Item -LiteralPath $inspectorArchive).LastWriteTimeUtc }
    }
}
$inspectorCandidates | Sort-Object BuiltAt -Descending | Select-Object -First 1 -ExpandProperty Executable
