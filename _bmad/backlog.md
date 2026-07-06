# 백로그 (햇배달 SaaS)

> 보안 핫픽스(SEC-001/SEC-002) 및 이후 정리 라운드에서 나온 후속 작업을 추적합니다.
> 상세 보안 이슈는 `SECURITY_ISSUES.md` 참고, 여기는 전체 작업 백로그용입니다.

---

## 완료

### P2: Fix @ Apartment Abbreviation Normalization
- **Status**: ✅ Deployed / Verified
- **Commit**: `ad97c1c`
- **Result**: `@` apartment abbreviation now normalizes correctly when used as a standalone abbreviation (previously never matched due to `\b` not forming a boundary after a non-word character).
- **Tests**: Synthetic regression tests added (`functions/test/receipt-utils.test.js`); related tests passing.
- **Remaining unrelated failures**: Existing stale smoke tests only at the time — since fixed, see below.
- **Deploy**: See "Functions 배포: OCR/주소 파싱 리팩터 + @ 약어 수정 + 의존성 선언" entry below — code-complete and confirmed live in production.

### Functions 배포: OCR/주소 파싱 리팩터 + @ 약어 수정 + 의존성 선언
- **Status**: ✅ Deployed / Verified
- **Scope**:
  - `e2fda83` OCR/address parsing refactor
  - `ad97c1c` @ apartment abbreviation fix
  - `6675cc2` functions dependency declaration
- **Deploy target**: Firebase Functions only, project `hatdelivery-saas`. Hosting/DB rules not touched.
- **Evidence**:
  - git status clean before deploy
  - full functions test suite 63/63 pass
  - `firebase deploy --only functions` success
  - authenticated testmart `geocodeAddress` call: 200
  - synthetic `@` apartment abbreviation and `A` abbreviation return identical result
  - server log confirms query normalized to apartment wording
  - `processReceipt` unauthenticated: 401
  - `processReceipt` tenant mismatch: 403
  - `processReceipt` own tenant reaches Vision stage
  - error-level function logs: 0
- **Result**: Production Functions now match committed OCR/address parsing changes — no remaining deploy gap.
- **Sensitive data policy**: No real customer addresses, phone numbers, tokens, or receipt logs recorded. Details in `_bmad/tea/evidence-log.md`.

### `functions/test/smoke.test.js` stale 테스트 수정 + `DEPLOY_CHECKLIST.md` API 키 마스킹
- **Status**: ✅ Completed
- **Commit**: `1f8fa37`

### TMS: saveToFirebase() detailAddress 필드 누락 버그 수정
- **Status**: ✅ Deployed / Verified
- **Commit**: `92576e2`
- **Root cause**: `saas/driver.html`의 `saveToFirebase()`가 Firebase에 쓰는 필드를 명시적으로 화이트리스트 처리하는데, 그 목록에 `detailAddress`가 빠져 있었음. TMS 배송목록 카드 표시 로직(`renderHome()`)은 이전 라운드에서 이미 수정했지만, 정작 저장 단계에서 값이 누락되어 실시간 동기화(재접속/새로고침) 후 상세주소가 사라지는 문제였음.
- **Fix**: `saveToFirebase()`의 저장 객체에 `detailAddress: item.detailAddress || ''` 추가. `renderHome()`에는 `d.detailAddress || d.detail_address || d.location?.detail_address` 폴백 체인도 추가.
- **검증 경위**: 최초 검증 시 합성 데이터를 `firebase database:set`으로 직접 주입해 렌더링만 확인했었는데, 이는 실제 저장 경로(`confirmAdd()` → `saveToFirebase()`)를 통과하지 않아 버그를 놓치는 원인이 됨. 이번 라운드에서는 실제 프로덕션 함수 `confirmAdd()`를 호출하는 방식으로 재검증.
- **배포 후 라이브 검증** (합성 테스트 주문만 사용):
  - Hosting 배포 (`firebase deploy --only hosting --project hatdelivery-saas`) 완료 확인 (Last-Modified 헤더로 배포 시각 확인)
  - 최초 검증 시도에서 배포 이전에 열려 있던 브라우저 탭이 구버전 JS를 메모리에 유지하고 있어 `detailAddress`가 여전히 누락되는 것을 발견 → 페이지 하드 리로드 후 재시도로 원인 규명 (배포 자체는 정상이었음, 탭 재사용이 원인)
  - 하드 리로드 후 testmart 기사 계정(`test1`)으로 로그인, 실제 `confirmAdd()` 함수를 호출해 합성 주문(테스트고객5, "3105동 502호 (공동현관 비번 미기재)") 추가
  - 배송목록 카드에 큰 주소(가상로 5) 아래 상세주소 라인이 정상 표시됨을 스냅샷으로 확인
  - Firebase RTDB 직접 조회로 `detailAddress` 필드 저장 확인
  - 페이지 새로고침 + 재로그인 후에도 상세주소가 카드에 그대로 유지됨을 재확인
  - 테스트 주문 2건(테스트고객4, 테스트고객5) 모두 Firebase에서 삭제, 잔존 테스트 데이터 없음 확인
- **Sensitive data policy**: 실제 고객 이름/주소/전화번호 미사용, 합성 데이터만 사용.

---

## 진행 대기 (P1)

- **P1-001: 기사앱 비밀번호 찾기 기능 복구** — `saas/driver.html`의 `doFindPw()`가 로그인 전 클라이언트에서 직접 RTDB 접근을 시도해 SEC-001 이후 permission_denied로 100% 실패 중. `issueDriverToken`과 동일하게 Cloud Function으로 이전 필요. 상세는 `SECURITY_ISSUES.md`의 P1-001 참고.
- **ORDER_AUTH_TOKEN 로테이션** — 현재 값은 기존 하드코딩 값과 동일하게 유지 중(운영 중단 회피 목적). 더 강력한 값으로 교체 시 MacroDroid 쪽 헤더 값도 동시에 변경 필요. 운영 준비 후 별도 진행.

## 진행 대기 (정리/품질)

- ~~**`.agents/`, `.claude/skills/` 커밋 여부 판단**~~ → **결정 완료**: `node_modules`와 동일하게 취급, `.gitignore`에 추가하고 저장소에는 포함하지 않음(각 12MB, `playwright-cli` 스킬 1개 차이만 있고 사실상 완전 중복). 필요 시 아래 명령어로 재생성:
  ```powershell
  npx bmad-method install --directory . --modules bmm --tools claude-code,codex --yes
  npx bmad-method install --directory . --custom-source https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise --tools claude-code,codex --action update --yes
  ```
- **`standardizeAddress` 오케스트레이션 통합 테스트** — 1~4차 폴백 순서 전체와 Gemini 프롬프트 동작(복수주소 선택 등)은 아직 통합 테스트 없음. 순수 함수 단위(문자열 파싱, 후보 선택)는 커버됨.
- **git 저장소 정리** — `orders.json`, `functions.zip`, `functions/node_modules` 히스토리 내 잔존 여부 및 재작성(BFG 등) 필요성 별도 논의.

## 백로그 (P2, 장기)

- **테넌트 내부 역할 분리** — 기사 계정이 `settings`/`driverAccounts` 등 민감 경로를 직접 쓰지 못하게 제한 (SEC-001은 테넌트 *간* 격리만 다룸, 테넌트 *내부* 역할 분리는 범위 밖).
- **평문 비밀번호 레거시 폴백 제거** — `functions/index.js`의 `issueDriverToken`에 남아있는 `driver.password === password` 폴백.
