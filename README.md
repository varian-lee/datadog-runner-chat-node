# datadog-runner-chat-node

**Datadog Runner** 프로젝트의 **chat-node** 마이크로서비스입니다.

## 🔗 Multi-root Workspace
이 저장소는 Multi-root Workspace의 일부입니다:
- **🏠 워크스페이스**: /Users/kihyun.lee/workspace/datadog-runner-multiroot
- **🧠 개발 환경**: Cursor Multi-root로 통합 관리
- **🔄 Git 관리**: 각 서비스 독립적 버전 관리

## 🚀 개발 환경
```bash
# Multi-root Workspace에서 개발
cd /Users/kihyun.lee/workspace/datadog-runner-multiroot
cursor datadog-runner.code-workspace

# 또는 이 서비스만 단독 개발
cursor .
```

## 📁 기술 스택
- **Node.js**: 비동기 I/O 최적화
- **WebSocket**: 실시간 양방향 통신
- **RabbitMQ**: 메시지 브로커
- **Keep-alive**: 연결 안정성

## 💬 주요 기능
- 실시간 메시지 브로드캐스트
- 30초 Keep-alive 메커니즘
- ALB 타임아웃 대응
- 사용자별 메시지 구분

## 🔄 배포
```bash
# 개발 이미지 빌드 및 배포
../infra/scripts/update-dev-image.sh chat-node

# 또는 통합 배포
../infra/scripts/deploy-eks-complete.sh
```

## 📊 모니터링
- **Datadog APM**: 분산 트레이싱
- **JSON 로깅**: 구조화된 로그 분석
- **Dynamic Instrumentation**: 런타임 계측
- **Exception Replay**: 예외 상태 캡처

*마지막 업데이트: 2025-09-17*
