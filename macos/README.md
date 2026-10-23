# iAI Meter (macOS 메뉴바 앱)

로컬 백엔드 상태를 보여주는 네이티브 macOS 메뉴바 앱 및 플로팅 패널입니다.

## 요구 사항

- macOS 13 이상
- Xcode Command Line Tools (`xcode-select --install`)

## 빌드

```bash
bash macos/build.sh
```

결과물: `macos/build/IAIMeterBar.app` (ad-hoc 서명). 빌드 스크립트는 앱을 실행·설치하거나 로그인 항목에 등록하지 않습니다.

## 설치 및 실행

1. `macos/build/IAIMeterBar.app`을 `~/Applications`로 복사합니다.
2. 앱을 실행합니다. 패널이 보이지 않으면 앱을 다시 실행(reopen)하세요.
3. 패널은 드래그로 이동할 수 있습니다.
4. 패널은 펼치기/숨기기가 가능합니다.
5. 로그인 시 실행은 메뉴바 메뉴의 옵션으로만 직접 켜고 끕니다.

## 백엔드

앱은 `http://127.0.0.1:8877/api/v1/status`만 읽습니다. 기존 백엔드가 먼저 실행 중이어야 합니다. 저장소의 실제 CLI를 확인하세요. 예:

```bash
node src/cli.js serve --demo --port 8877
```

## 동작

- 60초마다 갱신, 180초 이상 갱신되지 않으면 오래된(stale) 상태로 표시
- 값은 USD 금액이며 실제 토큰 수가 아닙니다
- 자격 증명을 앱에 포함하지 않습니다
- ChatGPT와 연동된 PiP가 아닌 독립 네이티브 오버레이입니다

## 보안 및 배포

- 자동 업데이트 기능 없음
- 공증(notarization) 없음 (ad-hoc 서명만)
- Gatekeeper를 비활성화하지 마세요

## 테스트

```bash
mkdir -p macos/build
xcrun swiftc macos/Sources/StatusModel.swift macos/Tests/main.swift -o macos/build/model-tests && macos/build/model-tests
```
