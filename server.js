const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const downloader = require('./downloader');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = 3000;

// 설정 파일 로드
function loadConfig() {
    const configPath = './config.json';
    if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    return { courseUrl: '', outputDir: './videos' };
}

const config = loadConfig();

// 기본 설정
const DEFAULT_COURSE_URL = config.courseUrl;
const DEFAULT_OUTPUT_DIR = config.outputDir || './videos';

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket 연결 관리
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('WebSocket 클라이언트 연결됨');

    ws.on('close', () => {
        clients.delete(ws);
        console.log('WebSocket 클라이언트 연결 해제');
    });

    // 현재 상태 전송
    ws.send(JSON.stringify({
        type: 'status',
        data: downloader.getStatus()
    }));
});

// 모든 클라이언트에게 메시지 전송
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// 다운로더 콜백 설정
downloader.setCallbacks({
    log: (level, message) => {
        console.log(`[${level.toUpperCase()}] ${message}`);
        broadcast({
            type: 'log',
            level,
            message
        });
    },
    progress: (data) => {
        broadcast({
            type: 'progress',
            data
        });
    },
    statusChange: (clipIndex, status) => {
        broadcast({
            type: 'clipStatus',
            clipIndex,
            status
        });
    },
    listUpdate: (list) => {
        broadcast({
            type: 'listUpdate',
            data: list
        });
    }
});

// API: 설정 가져오기
app.get('/api/config', (req, res) => {
    res.json({
        defaultCourseUrl: DEFAULT_COURSE_URL,
        defaultOutputDir: DEFAULT_OUTPUT_DIR
    });
});

// API: 저장된 상태 가져오기
app.get('/api/saved-status', (req, res) => {
    const status = downloader.loadStatus();
    res.json({
        success: true,
        data: status
    });
});

// API: 목록 가져오기
app.post('/api/fetch-list', async (req, res) => {
    const { courseUrl, email, password } = req.body;

    if (!email || !password) {
        return res.json({
            success: false,
            message: '이메일과 비밀번호를 입력하세요'
        });
    }

    try {
        // 로그인
        const loginResult = await downloader.login(email, password);
        if (!loginResult.success) {
            return res.json({
                success: false,
                message: loginResult.error || '로그인 실패'
            });
        }

        // 목록 수집
        const listResult = await downloader.fetchList(courseUrl || DEFAULT_COURSE_URL);
        if (!listResult.success) {
            return res.json({
                success: false,
                message: listResult.error || '목록 수집 실패'
            });
        }

        res.json({
            success: true,
            message: `${listResult.data.length}개 클립 발견`,
            data: listResult.data
        });
    } catch (error) {
        console.error('목록 가져오기 오류:', error);
        res.json({
            success: false,
            message: '오류: ' + error.message
        });
    }
});

// API: 다운로드 시작
app.post('/api/download', async (req, res) => {
    const { items, outputDir } = req.body;

    // 실제 사용할 경로 결정
    const finalOutputDir = (outputDir && outputDir.trim()) ? outputDir.trim() : DEFAULT_OUTPUT_DIR;
    console.log(`[다운로드] 요청된 경로: "${outputDir}"`);
    console.log(`[다운로드] 최종 경로: "${finalOutputDir}"`);

    if (!items || items.length === 0) {
        return res.json({
            success: false,
            message: '다운로드할 항목을 선택하세요'
        });
    }

    // 비동기로 다운로드 시작
    res.json({
        success: true,
        message: `${items.length}개 항목 다운로드 시작 (경로: ${finalOutputDir})`
    });

    // 다운로드 실행 (백그라운드)
    downloader.downloadItems(items, finalOutputDir)
        .then(result => {
            broadcast({
                type: 'downloadComplete',
                data: result
            });
        })
        .catch(error => {
            broadcast({
                type: 'log',
                level: 'error',
                message: '다운로드 오류: ' + error.message
            });
        });
});

// API: 목록 수집 중지
app.post('/api/stop-fetch', (req, res) => {
    downloader.stopFetch();
    res.json({
        success: true,
        message: '목록 수집 중지 요청됨'
    });
});

// API: 다운로드 중지
app.post('/api/stop', (req, res) => {
    downloader.stopDownload();
    res.json({
        success: true,
        message: '다운로드 중지 요청됨'
    });
});

// API: 목록 초기화 (저장된 상태 삭제)
app.post('/api/clear-status', (req, res) => {
    const result = downloader.clearStatus();
    res.json({
        success: true,
        message: '목록이 초기화되었습니다'
    });
});

// API: 상태 조회
app.get('/api/status', (req, res) => {
    res.json(downloader.getStatus());
});

// 서버 종료 시 정리
process.on('SIGINT', async () => {
    console.log('\n서버 종료 중...');
    await downloader.closeBrowser();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await downloader.closeBrowser();
    process.exit(0);
});

// 서버 시작
server.listen(PORT, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  Fastcamp Downloader`);
    console.log(`${'='.repeat(50)}`);
    console.log(`  서버 실행 중: http://localhost:${PORT}`);
    console.log(`${'='.repeat(50)}\n`);
});
