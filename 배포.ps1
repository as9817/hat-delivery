# 웰빙마트 hat-delivery 자동 배포 스크립트
Set-Location $PSScriptRoot

Write-Host "🔄 최신 코드 가져오는 중..." -ForegroundColor Cyan
git fetch origin main

# 로컬에 커밋되지 않은 변경사항 확인
$status = git status --porcelain
if ($status) {
    # 변경사항 있으면 먼저 커밋
    git add .
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    git commit -m "자동 배포: $timestamp"
}

# 원격과 충돌 없이 병합 (로컬 우선)
$behind = git rev-list HEAD..origin/main --count
if ([int]$behind -gt 0) {
    Write-Host "⚠️  원격에 새 커밋이 있습니다. 병합 중..." -ForegroundColor Yellow
    git merge origin/main -X ours --no-edit
}

# 로컬 코드가 항상 최신 기준 → force push로 원격 덮어쓰기
Write-Host "🚀 GitHub에 배포 중..." -ForegroundColor Green
git push origin main --force

Write-Host ""
Write-Host "✅ 배포 완료! 1~2분 후 사이트에 반영됩니다." -ForegroundColor Green
Write-Host "   https://as9817.github.io/hat-delivery/oms.html" -ForegroundColor Gray
Write-Host ""
Write-Host "아무 키나 누르면 창이 닫힙니다..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
