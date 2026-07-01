$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  멀티테넌트 SaaS 버전 배포" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

try {
    Remove-Item ".git\index.lock" -ErrorAction SilentlyContinue

    git add saas/ sw.js
    if ($LASTEXITCODE -ne 0) { throw "git add 실패" }

    $gitStatus = git status --porcelain
    if ($gitStatus -match "saas/" -or $gitStatus -match "sw.js") {
        git commit -m "feat: 멀티테넌트 SaaS 버전 추가 (login/app/superadmin)"
        if ($LASTEXITCODE -ne 0) { throw "git commit 실패" }
    } else {
        Write-Host "커밋할 변경사항이 없습니다 (이미 커밋됨)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "GitHub에 push 중..." -ForegroundColor Green
    git push origin main 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git push 실패" }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  배포 완료!" -ForegroundColor Green
    Write-Host "  https://as9817.github.io/hat-delivery/saas/login.html" -ForegroundColor Gray
    Write-Host "  1~2분 후 반영됩니다." -ForegroundColor Gray
    Write-Host "========================================" -ForegroundColor Green

} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  오류 발생!" -ForegroundColor Red
    Write-Host "  $_" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
}

Write-Host ""
Write-Host "아무 키나 누르면 창이 닫힙니다..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
