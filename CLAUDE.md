# 햇배달 SaaS - Claude Code 컨텍스트

> 이 파일은 Claude Code가 프로젝트를 이어서 작업할 때 읽는 가이드입니다.
> Cowork(Claude 데스크탑) 에서 진행한 작업 내용이 정리되어 있습니다.

---

## 프로젝트 개요

**햇배달 SaaS**: 마트 → 배달 기사 간 배송 관리 시스템
- Firebase Hosting + Cloud Functions (Node.js 20) + Realtime Database
- 멀티테넌트 구조 (테넌트별 데이터 분리)
- OCR 영수증 인식 → Gemini 파싱 → Kakao 주소 표준화 파이프라인

---

## Firebase 프로젝트 (중요!)

| 목적 | 프로젝트 ID | URL |
|------|-------------|-----|
| **운영 (신)** | `hatdelivery-saas` | `hatdelivery-saas.web.app` |
| 구버전 (구) | `wellbingmart-d5ee1` | `wellbingmart-d5ee1.web.app` |

**⚠️ 항상 신규 프로젝트에 배포할 것:**
```powershell
# Hosting 배포
firebase deploy --only hosting --project hatdelivery-saas

# Functions 배포
firebase deploy --only functions --project hatdelivery-saas

# DB 규칙 배포
firebase deploy --only database --project hatdelivery-saas
```

`.firebaserc` 파일이 없으므로 반드시 `--project hatdelivery-saas` 명시.

---

## 파일 구조

```
hat-delivery/
├── firebase.json              # Hosting + Functions + DB 설정
├── database.rules.json        # Firebase RTDB 보안 규칙
├── DEPLOY_CHECKLIST.md        # 배포 전 체크리스트 (필수 확인)
├── saas/
│   ├── login.html             # 로그인 (Firebase Auth)
│   ├── app.html               # OMS - 마트 담당자용 주문 관리
│   ├── driver.html            # TMS - 배달 기사용 배송 앱
│   └── superadmin.html        # 슈퍼어드민 (테넌트 관리)
├── oms.html                   # 구버전 OMS (사용하지 않음)
├── functions/
│   ├── index.js               # Cloud Functions 전체
│   ├── lib/
│   │   └── utils.js           # 순수 유틸 함수 (haversineKm, scoreKeywordMatch)
│   └── test/                  # 테스트 파일 (미완성, 배포 무관)
└── dashboard.html             # 슈퍼어드민 대시보드
```

---

## Cloud Functions (functions/index.js)

| 함수 | 역할 |
|------|------|
| `processReceipt` | 영수증 이미지 → OCR(Vision) → Gemini 파싱 → Kakao 주소 표준화 |
| `receiveOrder` | 문자/카톡 주문 텍스트 → Gemini 파싱 → DB 저장 |
| `geocodeAddress` | 주소 → 좌표 변환 프록시 |
| `reverseGeocode` | 좌표 → 주소 변환 (배치 처리) |
| `kakaoWaypoints` | 카카오 다중경유지 경로 최적화 |
| `issueDriverToken` | 배달 기사 인증 토큰 발급 |

### 환경변수 (functions/.env)
```
GOOGLE_VISION_KEY=...
GEMINI_KEY=...
KAKAO_KEY=...
```

---

## Firebase RTDB 구조

```
/settings/                    # 전역 설정 (.read: true, .write: false)
  appVersion                  # 앱 버전 (현재: "3") - 업데이트 배너용
/tenants/{tenantId}/
  settings/
    martLocation              # 마트 위치 정보
      lat, lng, name, address
      collectRadius           # 주변 동 자동 수집 반경 (km)
      nearbyRadius            # OCR 주소 검색 반경 (배달 커버 반경, km)
      nearbyDongs             # 주변 동 목록 (자동 수집)
  deliveries/                 # 배송 주문
  orders/                     # 접수 주문
  learnedLocations/           # 학습된 주소-좌표 매핑
/superadmins/                 # 슈퍼어드민 계정
/users/                       # 사용자 정보
/tenant_meta/                 # 테넌트 메타 정보
/system_logs/                 # 시스템 로그
```

### DB 보안 규칙 원칙
- `settings/` 만 인증 없이 읽기 가능 (앱 버전 확인용)
- 나머지 모든 경로: `auth != null` 필수

---

## 최근 주요 변경 이력

### 2026-07-06 작업 완료 내역 (driver.html)

| 항목 | 내용 | 커밋 |
|------|------|------|
| 배송중/완료 탭 | 배송 목록 상단에 탭 추가, `_deliveryTab` 상태로 필터링 | - |
| 상세주소 input 전환 | `<span id="res-detail-badge">` → `<input>` 필드로 변환, `.textContent` → `.value` | fc5b73b |
| 탭 카운트 버그 수정 | `renderHome()` early return 이전에 탭 카운트 업데이트하도록 이동 | fc5b73b |
| 학습 주소 저장하기 버튼 | git restore로 사라진 버튼 복원, `saveLearnedAddress()` 함수 추가 | fc5b73b |
| 도로명 주소 변환 비교 UI | 변환 전/후 주소 비교 카드 표시 후 "이 주소 적용" 선택 방식으로 변경 | f92b976 |
| 버튼 2열 정렬 | "도로명 주소 변환" + "학습 주소 저장" 나란히 배치 (row-btns) | f92b976 |
| 상세주소 항상 표시 | OCR 결과 없어도, 주소 변환 후에도 상세주소 필드 항상 표시 | f92b976 |

### 2026-07 이전 작업 완료 내역

| 항목 | 내용 |
|------|------|
| 업데이트 배너 | `APP_VERSION` 상수 vs Firebase `settings/appVersion` 비교, 불일치 시 배너 표시 |
| DB 보안 규칙 | 전체공개 → `auth != null` 강화 |
| 착불매출 OCR | Gemini 프롬프트에 `착불매출`, `착불금액` 키워드 추가 |
| OCR 반경 기본값 | 마트 반경 미설정 시 기본값 2km → 5km |
| 마트 위치 리스너 순서 | `onAuthStateChanged` 이후 `startMartLocationListener()` 호출 (인증 전 Firebase 읽기 방지) |
| 수집/배달 반경 분리 | `collectRadius`(수집용) / `nearbyRadius`(OCR 검색용) 별도 UI 필드 분리 |
| 복수 주소 처리 | 번호 매겨진 여러 주소 중 마지막 번호 선택 (앞 번호 = 취소된 주소) |
| Kakao 키워드 선택 개선 | `size=5`로 후보 복수 수신 후 쿼리 토큰 일치 점수로 최적 결과 선택 (`scoreKeywordMatch`) |

---

## 핵심 설계 결정사항

### APP_VERSION (driver.html)
```javascript
const APP_VERSION = '3';  // 배포 시마다 +1
// showApp() 안에서 Firebase settings/appVersion 리스너 등록
// 불일치 시 #update-banner 표시
```

### 멀티테넌트 경로 패턴
```javascript
const dbBase = tenantId ? `tenants/${tenantId}` : '';
// 모든 DB 접근: `${dbBase}/deliveries/...`
```

### Kakao 주소 표준화 흐름 (standardizeAddress)
1. 원본 주소 → Kakao 주소 검색 (거리순 정렬)
2. 실패 시 → 지번이면 주변 동 병렬 검색
3. 실패 시 → 건물명 키워드 검색 (size=5, 토큰 점수 기반 선택)
4. 실패 시 → 고객명 키워드 검색
5. 모두 실패 → 원본 반환

### 수집 반경 vs 배달 커버 반경
- `collectRadius`: 주변 동(nearbyDongs) 자동 수집 반경 (OMS 설정)
- `nearbyRadius`: OCR 영수증 주소 검색 허용 반경 = 배달 커버 반경 (Cloud Function에서 사용)

---

## 알려진 이슈 / 주의사항

1. **구버전 테넌트 `nearbyRadius` 없음**: `wellbingmart-d5ee1`에서 저장한 테넌트는 Firebase에 `nearbyRadius` 필드가 없을 수 있음. `hatdelivery-saas.web.app`에서 마트 위치 재저장하면 자동 반영.

2. **함수 배포 프로젝트 혼동**: `.firebaserc` 없음. `firebase deploy --only functions`만 하면 구버전(`wellbingmart-d5ee1`)에 배포됨. 반드시 `--project hatdelivery-saas` 추가.

3. **functions/lib/, functions/test/ 폴더**: 테스트 코드 준비 중 생성됨. `index.js`에서 `require` 하지 않으므로 무관. 삭제해도 무방.

4. **Hosting public 경로**: `firebase.json`에서 `"public": "."` → 프로젝트 루트가 통째로 배포. 민감 파일은 `ignore` 목록에 있는지 확인.

5. **git index.lock 오류**: git 명령이 `index.lock: File exists` 오류 시 → git 프로세스 확인 후 (`Get-Process | Where-Object { $_.Name -like "*git*" }`) 없으면 삭제:
   ```powershell
   Remove-Item C:\Users\ujuj6\Desktop\hat-delivery\.git\index.lock -Force
   ```

6. **배포 시 반드시 git 커밋**: 배포본과 git이 다르면 파일 손상 시 복구 불가. 항상 순서 준수:
   ```powershell
   git add saas/driver.html  # (또는 변경 파일)
   git commit -m "feat/fix: 설명"
   firebase deploy --only hosting --project hatdelivery-saas
   ```

7. **다른 기사 주문 보임 문제**: `assignedDriverId` 필터링은 정상이나 두 기사가 같은 기사 ID를 쓰면 주문이 공유됨. 기사 계정 ID 고유성 확인 필요.

---

## 개발 환경

- Node.js 20 (Functions 런타임)
- Firebase CLI (`firebase deploy`)
- 주요 의존성: `firebase-admin`, `firebase-functions`, `@google/genai`, `bcryptjs`
- Playwright MCP 설정 있음 (`.mcp.json`) - E2E 테스트 가능

---

## 배포 명령 요약

```powershell
cd C:\Users\ujuj6\Desktop\hat-delivery

# Functions만
firebase deploy --only functions --project hatdelivery-saas

# Hosting만
firebase deploy --only hosting --project hatdelivery-saas

# DB 규칙만
firebase deploy --only database --project hatdelivery-saas

# 전체
firebase deploy --project hatdelivery-saas
```
