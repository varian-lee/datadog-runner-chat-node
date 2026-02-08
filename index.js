/**
 * Chat Service (Node.js WebSocket) - Datadog Runner 프로젝트
 * 
 * 실시간 채팅 마이크로서비스
 * - WebSocket: 실시간 양방향 통신
 * - RabbitMQ: 메시지 브로드캐스트 (fanout exchange) + Pod간 사용자 동기화
 * - Keep-alive: 30초 간격 ping/pong으로 연결 안정성 보장
 * - Datadog APM: dd-trace/init로 자동 계측 (Dockerfile에서 설정)
 * - CORS: 분산 트레이싱 헤더 지원
 * 
 * 주요 기능:
 * - 실시간 메시지 송수신
 * - 사용자 ID 기반 메시지 구분
 * - ALB 타임아웃(300초) 대응 Keep-alive
 * - 무응답 연결 자동 정리
 * - 🆕 Pod 간 사용자 목록 동기화 (RabbitMQ)
 */
//require('dd-trace').init({ appsec: true, logInjection: true }); // Datadog APM 트레이싱 - Dockerfile에서 -r dd-trace/init 사용
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const amqp = require('amqplib');
const winston = require('winston');
const os = require('os');

// 간략한 JSON 로깅 설정
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const logEntry = {
        timestamp,
        level,
        service: 'chat-node',
        message,
        ...meta
      };
      return JSON.stringify(logEntry);
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

const app = express();

// 🆕 Pod 고유 ID - 사용자 동기화에 사용
const POD_ID = `pod_${os.hostname()}_${Date.now()}`;
logger.info('Pod 시작', { pod_id: POD_ID });

// CORS 설정 - RUM-APM 연결을 위한 tracing headers 허용
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', [
    'Content-Type',
    'Authorization',
    'x-datadog-trace-id',
    'x-datadog-parent-id',
    'x-datadog-origin',
    'x-datadog-sampling-priority',
    'traceparent',
    'tracestate',
    'b3'
  ].join(', '));
  res.header('Access-Control-Expose-Headers', [
    'x-datadog-trace-id',
    'x-datadog-parent-id',
    'traceparent',
    'tracestate'
  ].join(', '));

  // Preflight requests 처리
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/chat/ws' });

// 🆕 로컬 연결된 사용자 (이 Pod에 직접 연결된 WebSocket만)
const localUsers = new Map(); // connectionId -> { userId, connectionTime, ws }

// 🆕 전체 사용자 목록 (모든 Pod의 사용자 합산)
const allUsers = new Map(); // globalKey (podId:connectionId) -> { userId, connectionTime, podId }

// RabbitMQ 채널을 글로벌 변수로 선언
let globalChannel = null;

// 🆕 전체 사용자 목록을 클라이언트에게 전송
function sendUserListToClients() {
  const userList = Array.from(allUsers.values()).map(user => ({
    userId: user.userId,
    connectionTime: user.connectionTime
  }));

  const userListMessage = JSON.stringify({
    type: 'user_list_update',
    userList: userList,
    totalUsers: userList.length,
    ts: Date.now()
  });

  // 이 Pod에 연결된 클라이언트에게만 직접 전송
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(userListMessage);
    }
  });

  logger.info('사용자 목록 전송', {
    total_users: userList.length,
    local_connections: wss.clients.size,
    pod_id: POD_ID
  });
}

// 🆕 사용자 입장 이벤트를 RabbitMQ로 발행
function publishUserJoin(connectionId, userId) {
  if (!globalChannel) return;

  const event = JSON.stringify({
    type: 'user_sync',
    action: 'join',
    podId: POD_ID,
    connectionId: connectionId,
    userId: userId,
    connectionTime: new Date().toISOString(),
    ts: Date.now()
  });

  globalChannel.publish(EX, RK, Buffer.from(event));
}

// 🆕 사용자 퇴장 이벤트를 RabbitMQ로 발행
function publishUserLeave(connectionId) {
  if (!globalChannel) return;

  const event = JSON.stringify({
    type: 'user_sync',
    action: 'leave',
    podId: POD_ID,
    connectionId: connectionId,
    ts: Date.now()
  });

  globalChannel.publish(EX, RK, Buffer.from(event));
}

// RabbitMQ 설정 - 메시지 브로드캐스팅을 위한 Exchange/Queue
// 각 Pod가 고유한 Queue를 가져야 fanout exchange가 제대로 작동함
const EX = 'chat.exchange', RK = 'chat.msg';

async function connectWithRetry() {
  const maxRetries = 10;
  const retryDelay = 5000; // 5초

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`RabbitMQ 연결 시도 ${attempt}/${maxRetries}`, {
        attempt,
        maxRetries,
        rabbitmq_url: process.env.AMQP_URL || 'amqp://rabbitmq:5672'
      });

      const conn = await amqp.connect(process.env.AMQP_URL || 'amqp://rabbitmq:5672');
      const ch = await conn.createChannel();

      // 글로벌 채널 변수에 할당
      globalChannel = ch;

      await ch.assertExchange(EX, 'fanout', { durable: false });

      // 각 Pod가 고유한 익명 큐를 생성 (이름 없음, exclusive=true, auto-delete=true)
      // Fanout exchange는 연결된 모든 큐에 메시지를 브로드캐스트함
      const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
      await ch.bindQueue(q.queue, EX, '');

      logger.info('RabbitMQ 연결 성공!', {
        exchange: EX,
        queue: q.queue,  // 자동 생성된 고유한 큐 이름
        queue_type: 'exclusive_anonymous',
        routing_key: RK,
        pod_id: POD_ID
      });

      // 새로운 WebSocket 연결 처리 - 사용자별 ID 표시 및 안정성 개선
      wss.on('connection', (ws) => {
        const connectionId = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
        ws.connectionId = connectionId;

        logger.info('새로운 웹소켓 연결', {
          connection_id: connectionId,
          total_connections: wss.clients.size,
          client_ip: ws._socket?.remoteAddress,
          pod_id: POD_ID
        });

        // WebSocket Keep-alive 메커니즘 구현 - 연결 안정성 향상
        // ALB idle timeout(300초) 대응 및 네트워크 불안정성 해결
        ws.isAlive = true;  // 연결 활성 상태 플래그
        ws.on('pong', () => {
          ws.isAlive = true;  // pong 응답 수신 시 연결 활성 상태로 표시
        });

        // 메시지 수신 및 처리 - 기존 "user"에서 실제 사용자 ID로 개선
        ws.on('message', async (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            // 프론트엔드에서 전달된 사용자 ID 사용 (Chat.jsx에서 currentUser 전송)
            // 기존: 모든 메시지가 "user"로 표시 → 현재: 로그인한 사용자의 실제 ID 표시
            const userName = msg.user || '익명';

            // 새로운 사용자 입장 확인 및 사용자 목록 업데이트
            if (!localUsers.has(connectionId)) {
              // 로컬 사용자 등록
              localUsers.set(connectionId, {
                userId: userName,
                connectionTime: new Date(),
                ws: ws
              });

              // 🆕 RabbitMQ로 입장 이벤트 발행 (다른 Pod에 알림)
              publishUserJoin(connectionId, userName);

              logger.info('사용자 입장', {
                connection_id: connectionId,
                user_id: userName,
                local_users: localUsers.size,
                total_connections: wss.clients.size,
                message_type: msg.type || 'chat',
                pod_id: POD_ID
              });
            }

            // user_join 메시지는 사용자 등록만 하고 채팅 메시지로는 브로드캐스트하지 않음
            if (msg.type === 'user_join') {
              return; // 채팅 메시지 브로드캐스트 건너뛰기
            }

            // 일반 채팅 메시지 처리
            const payload = JSON.stringify({
              text: msg.text,
              user: userName,     // 실제 사용자 ID가 포함된 메시지
              type: 'chat',       // 일반 채팅 메시지 타입
              ts: Date.now()      // 서버 타임스탬프
            });

            // RabbitMQ를 통해 모든 연결된 클라이언트에게 브로드캐스트
            globalChannel.publish(EX, RK, Buffer.from(payload));
          } catch (e) {
            logger.error('메시지 발송 에러', {
              connection_id: connectionId,
              error: e.message,
              raw_message_preview: raw.toString().substring(0, 100)
            });
          }
        });

        // 연결 종료 이벤트 처리 - 디버깅을 위한 상세 로깅 추가
        ws.on('close', (code, reason) => {
          // 사용자 퇴장 처리
          if (localUsers.has(connectionId)) {
            const userInfo = localUsers.get(connectionId);

            // 로컬 사용자 목록에서 제거
            localUsers.delete(connectionId);

            // 🆕 RabbitMQ로 퇴장 이벤트 발행 (다른 Pod에 알림)
            publishUserLeave(connectionId);

            logger.info('사용자 퇴장', {
              connection_id: connectionId,
              user_id: userInfo.userId,
              session_duration_minutes: Math.round((Date.now() - userInfo.connectionTime.getTime()) / 60000),
              remaining_local_users: localUsers.size,
              remaining_connections: wss.clients.size - 1,
              pod_id: POD_ID
            });
          }

          logger.info('웹소켓 연결 종료', {
            connection_id: connectionId,
            close_code: code,
            close_reason: reason?.toString() || 'no reason',
            remaining_connections: wss.clients.size - 1
          });
        });

        // 연결 오류 이벤트 처리 - 네트워크 문제 디버깅 지원
        ws.on('error', (error) => {
          logger.error('웹소켓 에러', {
            connection_id: connectionId,
            error: error.message,
            error_code: error.code
          });
        });
      });

      // WebSocket Keep-alive 메커니즘 - 30초 간격으로 연결 상태 확인
      // 문제: ALB idle timeout, 네트워크 불안정으로 인한 연결 끊김 빈발
      // 해결: ping/pong을 통한 주기적 연결 상태 확인 및 무응답 연결 정리
      const pingInterval = setInterval(() => {
        let terminatedCount = 0;

        wss.clients.forEach((ws) => {
          if (!ws.isAlive) {
            // 무응답 연결 종료 전 사용자 퇴장 처리
            const connectionId = ws.connectionId;
            if (connectionId && localUsers.has(connectionId)) {
              const userInfo = localUsers.get(connectionId);

              // 로컬 사용자 목록에서 제거
              localUsers.delete(connectionId);

              // 🆕 RabbitMQ로 퇴장 이벤트 발행
              publishUserLeave(connectionId);

              logger.warn('Keep-alive 실패로 사용자 퇴장 처리', {
                connection_id: connectionId,
                user_id: userInfo.userId,
                session_duration_minutes: Math.round((Date.now() - userInfo.connectionTime.getTime()) / 60000),
                remaining_local_users: localUsers.size,
                pod_id: POD_ID
              });
            }

            // 이전 ping에 pong 응답이 없었다면 연결 종료
            logger.warn('응답 없는 연결 종료 - Keep-alive 실패', {
              connection_id: connectionId || 'unknown'
            });
            terminatedCount++;
            return ws.terminate();
          }
          // 연결 활성 상태를 false로 설정하고 ping 전송
          // pong 응답이 오면 다시 true로 설정됨
          ws.isAlive = false;
          ws.ping();
        });

        if (terminatedCount > 0) {
          logger.info('Keep-alive 체크 완료', {
            total_connections: wss.clients.size,
            terminated_connections: terminatedCount
          });
        }
      }, 30000);  // 30초 간격 - ALB idle timeout(300초)보다 충분히 짧게 설정

      // 🆕 RabbitMQ 메시지 수신 및 처리
      ch.consume(q.queue, (m) => {
        try {
          const data = JSON.parse(m.content.toString());

          // 🆕 사용자 동기화 이벤트 처리
          if (data.type === 'user_sync') {
            const globalKey = `${data.podId}:${data.connectionId}`;

            if (data.action === 'join') {
              // 사용자 입장 - 전체 목록에 추가
              allUsers.set(globalKey, {
                userId: data.userId,
                connectionTime: new Date(data.connectionTime),
                podId: data.podId
              });
              logger.info('사용자 동기화 (입장)', {
                global_key: globalKey,
                user_id: data.userId,
                total_all_users: allUsers.size,
                from_pod: data.podId,
                is_local: data.podId === POD_ID
              });
            } else if (data.action === 'leave') {
              // 사용자 퇴장 - 전체 목록에서 제거
              allUsers.delete(globalKey);
              logger.info('사용자 동기화 (퇴장)', {
                global_key: globalKey,
                total_all_users: allUsers.size,
                from_pod: data.podId,
                is_local: data.podId === POD_ID
              });
            }

            // 🆕 이 Pod의 클라이언트들에게 업데이트된 사용자 목록 전송
            sendUserListToClients();
            ch.ack(m);
            return;
          }

          // 채팅 메시지 처리
          const openConnections = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);
          openConnections.forEach(c => c.send(JSON.stringify(data)));
          ch.ack(m);

          // 채팅 메시지만 로그 기록
          if (data.type === 'chat') {
            logger.info('채팅 메시지 브로드캐스트!!', {
              user: data.user,
              clients: openConnections.length
            });
          }
        } catch (error) {
          logger.error('RabbitMQ 메시지 처리 에러', {
            error: error.message,
            raw_content_preview: m.content.toString().substring(0, 100)
          });
          ch.nack(m, false, false);
        }
      });

      return; // 성공하면 함수 종료

    } catch (error) {
      logger.error(`RabbitMQ 연결 실패 (시도 ${attempt}/${maxRetries})`, {
        attempt,
        maxRetries,
        error: error.message,
        error_code: error.code
      });

      if (attempt === maxRetries) {
        logger.error('RabbitMQ 연결 최대 재시도 초과 - 서비스 종료', {
          total_attempts: maxRetries
        });
        process.exit(1);
      }

      logger.info(`${retryDelay / 1000}초 후 재시도`, {
        next_attempt: attempt + 1,
        delay_seconds: retryDelay / 1000
      });
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

connectWithRetry();

// 헬스체크 엔드포인트 - ALB 헬스체크용
app.get('/', (_, res) => res.json({ status: 'healthy', service: 'chat-node', pod_id: POD_ID }));
app.get('/healthz', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  logger.info('Chat 서비스 시작 완료', {
    port: PORT,
    service: 'chat-node',
    websocket_path: '/chat/ws',
    environment: process.env.NODE_ENV || 'development',
    health_check: '/healthz',
    pod_id: POD_ID
  });
});
