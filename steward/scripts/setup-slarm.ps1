$ErrorActionPreference = 'Stop'
$stewardRoot = Split-Path $PSScriptRoot -Parent
$previousDshHome = $env:DSH_HOME
Push-Location $stewardRoot
try {
    pnpm --dir dsh install
    if ($LASTEXITCODE -ne 0) { throw 'Steward DSH dependency installation failed.' }
    pnpm --dir dsh run build
    if ($LASTEXITCODE -ne 0) { throw 'Steward DSH plugin build failed.' }
    $env:DSH_HOME = Join-Path $stewardRoot 'var/dsh/world'
    $dshLauncher = Join-Path $stewardRoot 'dsh/node_modules/.bin/dsh.cmd'
    $slarmBundle = Join-Path $stewardRoot 'dsh/packages/dsh-bundle-slarm'
    $worldBundle = Join-Path $stewardRoot 'dsh/packages/dsh-bundle-world'
    foreach ($slarmProfile in @(@{Name='world'; Template='web'}, @{Name='world-task'; Template='headless'})) {
        $profileManifest = Join-Path $env:DSH_HOME "profiles/$($slarmProfile.Name)/package.json"
        if (-not (Test-Path -LiteralPath $profileManifest)) {
            & $dshLauncher --profile $slarmProfile.Name --from-default-profile $slarmProfile.Template --dump-default-config | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Unable to initialize profile $($slarmProfile.Name)." }
        }
        & $dshLauncher plugin --profile $slarmProfile.Name add $worldBundle
        if ($LASTEXITCODE -ne 0) { throw "Unable to add World tools to profile $($slarmProfile.Name)." }
        & $dshLauncher plugin --profile $slarmProfile.Name add $slarmBundle
        if ($LASTEXITCODE -ne 0) { throw "Unable to add SLARM to profile $($slarmProfile.Name)." }
    }
    Write-Output 'SLARM tools are installed in world and world-task. Input paths are relative to the Steward directory.'
} finally {
    $env:DSH_HOME = $previousDshHome
    Pop-Location
}
