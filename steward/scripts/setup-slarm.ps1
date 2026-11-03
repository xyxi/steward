$ErrorActionPreference = 'Stop'
$stewardRoot = Split-Path $PSScriptRoot -Parent
$previousDshHome = $env:DSH_HOME
Push-Location $stewardRoot
try {
    pnpm --dir dsh install
    if ($LASTEXITCODE -ne 0) { throw 'Steward DSH dependency installation failed.' }
    pnpm --dir dsh run build
    if ($LASTEXITCODE -ne 0) { throw 'Steward DSH plugin build failed.' }
    $dshLauncher = Join-Path $stewardRoot 'dsh/node_modules/.bin/dsh.cmd'
    $slarmBundle = Join-Path $stewardRoot 'dsh/packages/dsh-bundle-slarm'
    foreach ($slarmProfile in @(
        @{Name='world'; Template='web'; Home='world'; Bundle='dsh-bundle-world'},
        @{Name='world-task'; Template='headless'; Home='world'; Bundle='dsh-bundle-world'},
        @{Name='ego'; Template='headless'; Home='robot-1'; Bundle='dsh-bundle-ego'}
    )) {
        $env:DSH_HOME = Join-Path $stewardRoot "var/dsh/$($slarmProfile.Home)"
        $profileManifest = Join-Path $env:DSH_HOME "profiles/$($slarmProfile.Name)/package.json"
        if (-not (Test-Path -LiteralPath $profileManifest)) {
            & $dshLauncher --profile $slarmProfile.Name --from-default-profile $slarmProfile.Template --dump-default-config | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Unable to initialize profile $($slarmProfile.Name)." }
        }
        & $dshLauncher plugin --profile $slarmProfile.Name add (Join-Path $stewardRoot "dsh/packages/$($slarmProfile.Bundle)")
        if ($LASTEXITCODE -ne 0) { throw "Unable to add harness tools to profile $($slarmProfile.Name)." }
        & $dshLauncher plugin --profile $slarmProfile.Name add $slarmBundle
        if ($LASTEXITCODE -ne 0) { throw "Unable to add SLARM to profile $($slarmProfile.Name)." }
    }
    Write-Output 'SLARM tools and skill are installed in world, world-task and ego. Model files stay in each harness home/workspace.'
} finally {
    $env:DSH_HOME = $previousDshHome
    Pop-Location
}
