Set-Location $PSScriptRoot

# 잠금 파일 제거
Remove-Item ".git\index.lock" -ErrorAction SilentlyContinue

# oms.html, hongdae/oms.html만 커밋
git add oms.html hongdae/oms.html
git commit -m "fix: OMS 마커 전체 순번 표기, 신규 주문 접수순 정렬"
git push origin main

Write-Host "완료! 1~2분 후 https://as9817.github.io/hat-delivery/oms.html 반영됩니다." -ForegroundColor Green
Write-Host ""
Write-Host "아무 키나 누르면 닫힙니다..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
