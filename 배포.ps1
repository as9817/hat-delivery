# 웰빙마트 hat-delivery 자동 배포 스크립트
Set-Location $PSScriptRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  햇배달 자동 배포 시작" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

try {
    # git 상태 확인
    $gitStatus = git status --porcelain 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Git 오류: $gitStatus" }

    if ($gitStatus) {
        Write-Host "변경된 파일 감지됨, 커밋 중..." -ForegroundColor Yellow
        git add -u
        if ($LASTEXITCODE -ne 0) { throw "git add 실패" }

        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
        git commit -m "자동 배포: $timestamp"
        if ($LASTEXITCODE -ne 0) { throw "git commit 실패" }
    } else {
        Write-Host "변경사항 없음" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "GitHub에 push 중..." -ForegroundColor Green
    git push origin main --force 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git push 실패" }

    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  배포 완료!" -ForegroundColor Green
    Write-Host "  https://as9817.github.io/hat-delivery/" -ForegroundColor Gray
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
