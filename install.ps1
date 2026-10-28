# Links every skill in this library into ~/.claude/skills with a directory junction, so edits here are
# live without copying. Junctions need no administrator rights. Safe to rerun.
$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'skills'
$target = Join-Path $HOME '.claude\skills'
New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($skill in Get-ChildItem -Path $source -Directory) {
    $link = Join-Path $target $skill.Name
    if (Test-Path -LiteralPath $link) {
        $item = Get-Item -LiteralPath $link -Force
        if ($item.LinkType -eq 'Junction' -and @($item.Target) -contains $skill.FullName) {
            Write-Output "ok      $($skill.Name)"
        }
        else {
            Write-Warning "skipped $($skill.Name): $link already exists and is not this library's junction"
        }
        continue
    }
    New-Item -ItemType Junction -Path $link -Target $skill.FullName | Out-Null
    Write-Output "linked  $($skill.Name)"
}

# Junctions into this library whose skill was renamed or removed. Deleting the DirectoryInfo removes only
# the link, never a target's files.
foreach ($item in Get-ChildItem -Path $target -Directory -Force | Where-Object LinkType -eq 'Junction') {
    $into = @(@($item.Target) | Where-Object { $_ -like "$source\*" })
    if ($into -and -not (Test-Path -LiteralPath $into[0])) {
        $item.Delete()
        Write-Output "removed $($item.Name) (no longer in this library)"
    }
}
