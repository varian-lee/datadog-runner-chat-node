# 🚀 GitHub Actions 설정 가이드

Datadog Runner 프로젝트의 GitHub Actions CI/CD 파이프라인 설정 가이드입니다.

## 📋 목차

1. [필수 설정](#필수-설정)
2. [AWS OIDC 설정](#aws-oidc-설정)
3. [GitHub Secrets 설정](#github-secrets-설정)
4. [워크플로우 설명](#워크플로우-설명)
5. [사용 방법](#사용-방법)
6. [문제 해결](#문제-해결)

---

## 필수 설정

### 1️⃣ 사전 요구사항

- AWS 계정 (ECR, EKS 권한)
- GitHub 저장소
- Datadog 계정 (API 키)
- Slack 워크스페이스 (선택)

### 2️⃣ 파일 구조

```
.github/
├── workflows/
│   ├── deploy-service.yml        # 개별 서비스 배포
│   ├── ci.yml                    # PR 빌드/테스트
│   ├── rollback.yml              # 롤백
│   ├── deploy-infrastructure.yml # 인프라 서비스 배포
│   └── scheduled-deploy.yml      # 예약 배포
└── GITHUB_ACTIONS_SETUP.md       # 이 파일
```

---

## AWS OIDC 설정

GitHub Actions에서 AWS에 안전하게 인증하기 위해 OIDC(OpenID Connect)를 사용합니다.

### 1️⃣ AWS IAM Identity Provider 생성

AWS Console → IAM → Identity providers → Add provider

```
Provider type: OpenID Connect
Provider URL: https://token.actions.githubusercontent.com
Audience: sts.amazonaws.com
```

### 2️⃣ IAM Role 생성

**Trust Policy (신뢰 정책):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<AWS_ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:<GITHUB_ORG>/<REPO_NAME>:*"
        }
      }
    }
  ]
}
```

**Permission Policy (권한 정책):**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ECRPermissions",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeRepositories",
        "ecr:CreateRepository"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSPermissions",
      "Effect": "Allow",
      "Action": [
        "eks:DescribeCluster",
        "eks:ListClusters"
      ],
      "Resource": "*"
    }
  ]
}
```

### 3️⃣ EKS 클러스터에 Role 권한 부여

```bash
# aws-auth ConfigMap에 Role 추가
kubectl edit configmap aws-auth -n kube-system
```

```yaml
mapRoles: |
  - rolearn: arn:aws:iam::<AWS_ACCOUNT_ID>:role/GitHubActionsRole
    username: github-actions
    groups:
      - system:masters
```

---

## GitHub Secrets 설정

GitHub 저장소 → Settings → Secrets and variables → Actions

### 필수 Secrets

| Secret 이름 | 설명 | 예시 |
|------------|------|------|
| `AWS_ROLE_ARN` | AWS OIDC Role ARN | `arn:aws:iam::123456789012:role/GitHubActionsRole` |
| `DD_API_KEY` | Datadog API 키 | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |

### 선택 Secrets (Frontend RUM)

| Secret 이름 | 설명 |
|------------|------|
| `VITE_DD_RUM_APP_ID` | Datadog RUM Application ID |
| `VITE_DD_RUM_CLIENT_TOKEN` | Datadog RUM Client Token |

### 선택 Secrets (Slack 알림)

| Secret 이름 | 설명 |
|------------|------|
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL |

---

## 워크플로우 설명

### 1️⃣ deploy-service.yml (핵심)

**트리거:**
- `workflow_dispatch`: 수동 실행 (서비스 선택)
- `push`: main/develop 브랜치 푸시 시 자동 실행

**기능:**
1. 변경된 서비스 자동 감지
2. Kubernetes 매니페스트 자동 업데이트 (버전 증가, Git 환경변수)
3. 멀티아키텍처 Docker 빌드 (amd64 + arm64)
4. ECR 푸시
5. EKS 배포
6. Datadog DORA Metrics 전송
7. Slack 알림

### 2️⃣ ci.yml

**트리거:**
- Pull Request (main/develop 대상)

**기능:**
1. 언어별 린트/테스트 (Python, Node.js, Java)
2. Docker 이미지 빌드 테스트 (푸시 없이)
3. Kubernetes 매니페스트 검증
4. 보안 스캔 (Trivy)

### 3️⃣ rollback.yml

**트리거:**
- `workflow_dispatch`: 수동 실행만

**기능:**
1. 롤백 방식 선택 (직전 버전, 특정 태그, undo)
2. 롤백 실행
3. Datadog DORA Incident 전송
4. Slack 알림

### 4️⃣ deploy-infrastructure.yml

**트리거:**
- `workflow_dispatch`: 수동 실행만

**기능:**
1. PostgreSQL, Redis, RabbitMQ 배포
2. 데이터베이스 초기화 (선택)

### 5️⃣ scheduled-deploy.yml

**트리거:**
- `schedule`: 매일 오전 3시 (KST)
- `workflow_dispatch`: 수동 실행

**기능:**
1. 새 커밋이 있을 때만 배포
2. 전체 서비스 배포
3. 헬스체크

---

## 사용 방법

### 수동 배포

1. GitHub 저장소 → Actions 탭
2. "🚀 Deploy Service" 워크플로우 선택
3. "Run workflow" 클릭
4. 서비스 및 환경 선택
5. "Run workflow" 실행

### 자동 배포 (Push)

1. 서비스 코드 수정
2. `main` 또는 `develop` 브랜치에 푸시
3. 변경된 서비스만 자동 배포

### 롤백

1. Actions 탭 → "⏪ Rollback Service"
2. 서비스 및 롤백 방식 선택
3. 사유 입력
4. 실행

---

## 문제 해결

### ❌ AWS 인증 실패

```
Error: Could not assume role with OIDC
```

**해결방법:**
1. AWS OIDC Provider 설정 확인
2. IAM Role Trust Policy의 `sub` 조건 확인
3. Role ARN이 정확한지 확인

### ❌ EKS 접근 실패

```
error: You must be logged in to the server
```

**해결방법:**
1. aws-auth ConfigMap에 Role이 추가되었는지 확인
2. EKS 클러스터 이름이 정확한지 확인

### ❌ ECR 푸시 실패

```
denied: Your authorization token has expired
```

**해결방법:**
1. ECR 로그인 단계가 이미지 빌드 전에 실행되는지 확인
2. IAM Role에 ECR 권한이 있는지 확인

### ❌ Docker 빌드 실패 (멀티아키텍처)

```
error: multiple platforms feature is currently not supported
```

**해결방법:**
1. `docker/setup-buildx-action` 사용 확인
2. `push: true`로 설정 (로컬 로드 불가)

---

## 📚 참고 자료

- [GitHub Actions OIDC with AWS](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [Datadog DORA Metrics](https://docs.datadoghq.com/dora_metrics/)
- [Docker Buildx Multi-platform](https://docs.docker.com/build/building/multi-platform/)
- [EKS IAM Roles for Service Accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)

