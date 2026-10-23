# SSH 터널 예시 (선택)

`ssh-tunnel.plist`는 백엔드를 **이미 본인이 쓰고 있는 서버**에서 돌릴 때만 쓰는 선택용 launchd 템플릿입니다. 서버의 `127.0.0.1:8877`을 Mac의 `127.0.0.1:8877`로만 전달하며, 그 밖의 포트는 열지 않습니다.

- 이 템플릿은 새 원격 권한, 계정, 키를 만들지 않습니다. 이미 승인된 호스트, 키, `known_hosts`만 사용합니다.
- 템플릿이 있다고 SSH 접속이 된다고 가정하지 마세요. 직접 확인해야 합니다.
- `__KEY_PATH__`, `__USER_AT_HOST__`는 본인 Mac에서만 바꾸세요. 실제 호스트·키 경로가 들어간 파일은 배포하거나 커밋하지 마세요.
- `StrictHostKeyChecking=yes`를 유지하세요.
- 시작 전 기존 터널을 종료하세요. 포트가 이미 쓰이면 `ExitOnForwardFailure`로 실패합니다.
- `bootout`으로 내리면 자동 재연결도 멈춥니다.
- 앱 자체의 "로그인 시 실행"은 이 터널과 별개이며 기본값은 꺼짐입니다.

## 명령

```sh
# 템플릿을 사용자 LaunchAgents로 복사 (복사본에서 자리표시자 교체)
cp macos/examples/ssh-tunnel.plist ~/Library/LaunchAgents/com.moneystack.iai-meter-tunnel.plist

# plist 문법 검사
plutil -lint ~/Library/LaunchAgents/com.moneystack.iai-meter-tunnel.plist

# 8877 포트를 쓰는 기존 터널 확인 (있으면 먼저 종료)
lsof -nP -iTCP:8877 -sTCP:LISTEN

# 이전에 등록한 에이전트 내리기 (재연결도 중지)
launchctl bootout gui/$(id -u)/com.moneystack.iai-meter-tunnel

# 에이전트 등록 및 시작
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.moneystack.iai-meter-tunnel.plist

# 상태 확인
launchctl print gui/$(id -u)/com.moneystack.iai-meter-tunnel
```
