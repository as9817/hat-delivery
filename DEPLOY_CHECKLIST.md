# 햇배달 배포 전 체크리스트

> **모든 배포 전 이 단계를 반드시 거칠 것.**  
> 특히 함수/API 변경이 아닌 프론트엔드(html) 변경 시 더 중요.

---

## 1. 코드 변경 사항 정적 검증

### 변경 파일별 검증 포인트

| 파일 | 검증 항목 |
|------|-----------|
| `functions/index.js` | regex 엣지케이스, 오탐(false positive) 확인. Gemini 프롬프트 예시 일관성 |
| `saas/driver.html` | 로컬/Firebase 필드 동기화 여부 (`addedAt`/`createdAt` 등), null 체크 |
| `saas/app.html` | Firebase Auth 순서 (login.html 선행), 함수 중복 정의 여부 |
| `saas/login.html` | Firebase 프로젝트 config 일치, 인증 도메인 등록 여부 |

### 필수 확인 항목 (매 배포)
- [ ] 변경한 함수에서 null/undefined 접근 없는지 확인
- [ ] 로컬 저장(`localStorage`)과 Firebase 저장 필드 일치 여부
- [ ] 새로 추가된 필드가 Firebase 보안 규칙에서 허용되는 경로인지 확인
- [ ] CDN 라이브러리 의존성 있으면 `<head>`에 로드 여부 확인

---

## 2. git 상태 확인

```powershell
cd C:\Users\ujuj6\Desktop\hat-delivery

# index.lock 있으면 먼저 제거
Remove-Item .git\index.lock -Force -ErrorAction SilentlyContinue

# 변경 파일 목록 확인
git status

# 변경 내용 확인
git diff
```

- [ ] 의도한 파일만 변경됐는지 확인 (불필요한 파일 스테이징 금지)
- [ ] 배포 전 커밋 (배포 후 롤백 기준점 생성)

---

## 3. 배포 영향 범위 확인

### functions 변경 시
- OMS(`app.html`) 영향: OCR 결과 형식 변경 여부, API 응답 구조 변경 여부
- TMS(`driver.html`) 영향: 동일

### saas/driver.html 변경 시
- TMS 로그인 플로우 정상 여부
- Firebase 주문 저장/읽기 영향 여부
- 로컬스토리지 필드 변경 시 기존 데이터 호환성

### saas/app.html 변경 시
- OMS 로그인 → 주문 조회 → 배차 플로우 영향 여부
- TMS와 공유하는 Firebase 경로(`orders/`, `settings/`) 변경 여부

---

## 4. 배포 실행

### Functions 배포
```powershell
cd C:\Users\ujuj6\Desktop\hat-delivery
firebase deploy --only functions --project hatdelivery-saas
```

### 프론트엔드 배포 (wellbingmart-d5ee1)
```powershell
cd C:\Users\ujuj6\Desktop\hat-delivery
firebase deploy --only hosting --project wellbingmart-d5ee1
```

### 전체 배포 (주의: 프로덕션 전체 영향)
```powershell
firebase deploy --project hatdelivery-saas
```

---

## 5. 배포 후 검증

### Functions 변경 시
- [ ] Firebase Console → Functions 로그에서 오류 없는지 확인
- [ ] 실제 영수증으로 OCR 테스트 (성명/주소/금액 파싱 정확도)
- [ ] 새로 추가된 정규식 케이스 실제 영수증으로 재현 확인

### 프론트엔드 변경 시
- [ ] 브라우저 캐시 강제 새로고침 (`Ctrl+Shift+R`)
- [ ] OMS 로그인 → 주문 조회 동작 확인
- [ ] TMS 로그인 → 배달 목록 → 완료 체크 → 취소 동작 확인
- [ ] Firebase RTDB에서 `orders/` 경로에 데이터 정상 저장 확인

---

## 6. 롤백 방법

```powershell
# 직전 커밋으로 파일 복원
git checkout HEAD~1 -- saas/app.html
git checkout HEAD~1 -- saas/driver.html
git checkout HEAD~1 -- functions/index.js

# 복원 후 재배포
firebase deploy --project hatdelivery-saas
```

---

## 알려진 주의사항

| 항목 | 주의 |
|------|------|
| `git index.lock` | 오류 발생 시 `Remove-Item .git\index.lock -Force` 후 재시도 |
| Firebase Auth 도메인 | 신규 테넌트 도메인은 hatdelivery-saas Auth → 승인된 도메인에 추가 필요 |
| Vision API Key | Browser key (`functions/.env`의 `GOOGLE_VISION_KEY` 참고, 값은 여기 기록하지 않음) — Cloud Vision API 제한 포함 확인 |
| `addedAt` vs `createdAt` | TMS 로컬 = `addedAt`, Firebase = `createdAt`. loadDeliveries 필터는 양쪽 다 처리 |
