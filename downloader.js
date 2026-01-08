const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 상태 파일
const STATUS_FILE = './download-status.json';

// 다운로드 설정
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000; // 5분
const MAX_RETRIES = 3;
const MAX_CONCURRENT_DOWNLOADS = 3;

// URL 수집 설정 (개선)
const URL_COLLECT_TIMEOUT = 30 * 1000;    // URL 수집 전체 타임아웃: 30초
const URL_CAPTURE_MAX_WAIT = 10 * 1000;   // m3u8 캡처 최대 대기: 10초
const URL_COLLECT_RETRIES = 3;            // URL 수집 재시도 횟수

// 현재 강의 URL (페이지 복구용)
let currentCourseUrl = null;

// 브라우저 인스턴스
let browser = null;
let browserContext = null;
let page = null;

// 병렬 수집 설정
const PARALLEL_WORKERS = 3;

// 실시간 수집 결과 (워커들이 공유)
let sharedCollectedResults = [];
let completedPartsCount = 0;
let totalPartsCount = 0;

// 이벤트 콜백
let onLog = () => {};
let onProgress = () => {};
let onStatusChange = () => {};
let onListUpdate = () => {};  // 목록 실시간 업데이트

// 상태
let isRunning = false;
let isFetching = false;
let isLoggedIn = false;
let downloadQueue = [];
let activeDownloads = 0;

/**
 * 콜백 설정
 */
function setCallbacks({ log, progress, statusChange, listUpdate }) {
    if (log) onLog = log;
    if (progress) onProgress = progress;
    if (statusChange) onStatusChange = statusChange;
    if (listUpdate) onListUpdate = listUpdate;
}

/**
 * 파일명 정리
 */
function sanitizeFilename(name) {
    return name
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);
}

/**
 * 상태 저장
 */
function saveStatus(clips) {
    const status = clips.map(c => ({
        index: c.index,
        title: c.title,
        partNum: c.partNum,
        partTitle: c.partTitle,
        chapterNum: c.chapterNum,
        chapterTitle: c.chapterTitle,
        status: c.status || 'pending',
        m3u8_url: c.m3u8_url
    }));
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

/**
 * 상태 로드
 */
function loadStatus() {
    if (fs.existsSync(STATUS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
        } catch (e) {
            return [];
        }
    }
    return [];
}

/**
 * 브라우저 초기화
 */
async function initBrowser() {
    if (browser) return;

    onLog('info', '브라우저 시작 중...');
    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext();
    page = await browserContext.newPage();
    onLog('info', '브라우저 준비 완료 (headless 모드)');
}

/**
 * 브라우저 종료
 */
async function closeBrowser() {
    if (browser) {
        await browser.close();
        browser = null;
        browserContext = null;
        page = null;
        onLog('info', '브라우저 종료됨');
    }
}

/**
 * 로그인
 */
async function login(email, password) {
    await initBrowser();

    onLog('info', '로그인 페이지 접속 중...');
    await page.goto('https://kdt.fastcampus.co.kr/account/sign-in', {
        waitUntil: 'networkidle',
        timeout: 60000
    });

    onLog('info', '로그인 정보 입력 중...');

    // 이메일 입력
    await page.fill('input[name="user-email"]', email);
    await page.waitForTimeout(300);

    // 비밀번호 입력
    await page.fill('input[name="user-password"]', password);
    await page.waitForTimeout(300);

    // 로그인 버튼이 활성화될 때까지 대기
    const loginBtn = page.locator('button[data-e2e="sign-in-btn"]');
    await loginBtn.waitFor({ state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);

    // 로그인 버튼 클릭
    await loginBtn.click();
    onLog('info', '로그인 버튼 클릭됨, 페이지 이동 대기...');

    // 네비게이션 완료 대기
    await page.waitForLoadState('networkidle', { timeout: 30000 });
    await page.waitForTimeout(2000);  // 추가 대기

    // 현재 URL 확인
    const currentUrl = page.url();
    onLog('info', `현재 URL: ${currentUrl}`);

    // 로그인 성공 여부 확인 (sign-in 페이지가 아니면 성공)
    if (!currentUrl.includes('sign-in')) {
        isLoggedIn = true;
        onLog('info', '로그인 성공!');
        return { success: true };
    } else {
        isLoggedIn = false;
        onLog('error', '로그인 실패: 여전히 로그인 페이지');
        await page.screenshot({ path: './login-debug.png' });
        return { success: false, error: '로그인 실패' };
    }
}

/**
 * 팝업 닫기
 */
async function closePopup() {
    for (let i = 0; i < 3; i++) {
        try {
            const btn = page.locator('[data-e2e="classroom-confirm-modal-close"]');
            if (await btn.isVisible({ timeout: 300 })) {
                await btn.click({ force: true });
                await page.waitForTimeout(300);
            }
        } catch (e) {}
        try {
            const btn = page.locator('button:has-text("처음부터 보기")');
            if (await btn.isVisible({ timeout: 300 })) {
                await btn.click({ force: true });
                await page.waitForTimeout(300);
            }
        } catch (e) {}
    }
}

/**
 * 클립 고유 키 생성 (상태 매칭용)
 */
function getClipKey(clip) {
    return `${clip.partNum}-${clip.chapterNum}-${clip.clipNum}-${clip.title}`;
}

/**
 * 실시간 수집 결과 브로드캐스트 (정렬 후 인덱스 재할당)
 */
function broadcastCollectedResults(statusMap) {
    // 정렬: Part → Chapter → Clip
    const sorted = [...sharedCollectedResults].sort((a, b) => {
        if (a.partNum !== b.partNum) return a.partNum - b.partNum;
        if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
        return a.clipNum - b.clipNum;
    });

    // 인덱스 재할당 및 상태 복원 (클립 키 기반 매칭)
    const indexed = sorted.map((clip, idx) => {
        const globalIndex = idx + 1;
        const clipKey = getClipKey(clip);
        const saved = statusMap[clipKey];
        const existingStatus = saved ? saved.status : 'pending';
        const existingUrl = saved ? saved.m3u8_url : null;
        return {
            ...clip,
            index: globalIndex,
            status: existingStatus,
            m3u8_url: existingUrl || clip.m3u8_url,
            selected: existingStatus !== 'completed'
        };
    });

    onListUpdate(indexed);
}

/**
 * 단일 워커가 특정 Part 범위를 수집
 */
async function fetchPartRange(workerPage, courseUrl, startIdx, endIdx, totalParts, statusMap, workerId) {
    const localResults = [];

    try {
        // 페이지 이동 (load로 변경 - networkidle보다 빠름)
        await workerPage.goto(courseUrl, { waitUntil: 'load', timeout: 60000 });
        await workerPage.waitForTimeout(3000);

    // 팝업 닫기
    for (let i = 0; i < 3; i++) {
        try {
            const btn = workerPage.locator('[data-e2e="classroom-confirm-modal-close"]');
            if (await btn.isVisible({ timeout: 300 })) {
                await btn.click({ force: true });
                await workerPage.waitForTimeout(300);
            }
        } catch (e) {}
        try {
            const btn = workerPage.locator('button:has-text("처음부터 보기")');
            if (await btn.isVisible({ timeout: 300 })) {
                await btn.click({ force: true });
                await workerPage.waitForTimeout(300);
            }
        } catch (e) {}
    }

    onLog('info', `[워커${workerId}] Part ${startIdx + 1}~${endIdx} 수집 시작`);

    for (let partIdx = startIdx; partIdx < endIdx; partIdx++) {
        if (!isFetching) {
            onLog('info', `[워커${workerId}] 중지됨`);
            break;
        }

        const currentPartToggles = await workerPage.locator('.classroom-sidebar-clip__chapter__title').all();
        if (partIdx >= currentPartToggles.length) break;

        const partToggle = currentPartToggles[partIdx];
        const partNum = partIdx + 1;

        // Part 이름 가져오기
        let partTitle = '';
        try {
            const titleEl = partToggle.locator('.classroom-sidebar-clip__chapter__title__text');
            partTitle = await titleEl.textContent();
            partTitle = partTitle.trim();
        } catch (e) {
            partTitle = `Part ${partNum}`;
        }

        onLog('info', `[워커${workerId}] 📂 PART ${partNum}: ${partTitle.slice(0, 30)}`);

        // Part 컨테이너
        let partContainer;
        try {
            partContainer = partToggle.locator('..').locator('..').locator('..');
            await partContainer.scrollIntoViewIfNeeded({ timeout: 3000 });
            const partHeader = partToggle.locator('..');
            await partHeader.click({ force: true });
            await workerPage.waitForTimeout(1000);
        } catch (e) {
            continue;
        }

        // 팝업 닫기
        try {
            const btn = workerPage.locator('[data-e2e="classroom-confirm-modal-close"]');
            if (await btn.isVisible({ timeout: 300 })) {
                await btn.click({ force: true });
            }
        } catch (e) {}

        // Chapter 토글들
        const chapterToggles = await partContainer.locator('.classroom-sidebar-clip__chapter__part__title').all();

        let chapterNum = 0;

        for (let chIdx = 0; chIdx < chapterToggles.length; chIdx++) {
            const currentChapterToggles = await partContainer.locator('.classroom-sidebar-clip__chapter__part__title').all();
            if (chIdx >= currentChapterToggles.length) break;

            const chapterToggle = currentChapterToggles[chIdx];

            // Chapter 이름
            let chapterTitle = '';
            let chapterPrefix = '';
            try {
                chapterTitle = await chapterToggle.textContent();
                chapterTitle = chapterTitle.trim();
                const prefixMatch = chapterTitle.match(/^(Ch\s*\d+|CH\s*\d+)/i);
                chapterPrefix = prefixMatch ? prefixMatch[1].replace(/\s+/g, '') : `Ch${chIdx + 1}`;
            } catch (e) {
                chapterTitle = `Ch ${chIdx + 1}`;
                chapterPrefix = `Ch${chIdx + 1}`;
            }

            chapterNum++;

            // Chapter 펼치기
            try {
                const parentToggle = chapterToggle.locator('..');
                await parentToggle.scrollIntoViewIfNeeded({ timeout: 3000 });
                const accordionMenu = parentToggle.locator('..');
                const isOpen = await accordionMenu.evaluate(el => el.classList.contains('common-accordion-menu--open'));
                if (!isOpen) {
                    await parentToggle.click({ force: true });
                    await workerPage.waitForTimeout(800);
                }
            } catch (e) {
                continue;
            }

            // 팝업 닫기
            try {
                const btn = workerPage.locator('[data-e2e="classroom-confirm-modal-close"]');
                if (await btn.isVisible({ timeout: 300 })) {
                    await btn.click({ force: true });
                }
            } catch (e) {}

            await workerPage.waitForTimeout(300);

            // 클립들
            let clipElements = [];
            try {
                const chapterContainer = chapterToggle.locator('..').locator('..');
                clipElements = await chapterContainer.locator('.classroom-sidebar-clip__chapter__clip__title').all();
            } catch (e) {
                continue;
            }

            for (let clipIdx = 0; clipIdx < clipElements.length; clipIdx++) {
                let title = '';
                try {
                    const currentChToggles = await partContainer.locator('.classroom-sidebar-clip__chapter__part__title').all();
                    const chapterContainer = currentChToggles[chIdx].locator('..').locator('..');
                    const clips = await chapterContainer.locator('.classroom-sidebar-clip__chapter__clip__title').all();
                    if (clipIdx >= clips.length) continue;
                    title = await clips[clipIdx].textContent();
                    title = title.trim();
                } catch (e) {
                    title = `Clip ${clipIdx + 1}`;
                }

                const newClip = {
                    partNum,
                    partTitle,
                    chapterNum,
                    chapterTitle,
                    chapterPrefix,
                    clipNum: clipIdx + 1,
                    title,
                    m3u8_url: null
                };
                localResults.push(newClip);

                // 공유 배열에 추가 및 실시간 브로드캐스트
                sharedCollectedResults.push(newClip);
                broadcastCollectedResults(statusMap);
            }
        }

        // Part 완료 시 진행률 업데이트
        completedPartsCount++;
        onProgress({
            type: 'fetch',
            current: completedPartsCount,
            total: totalPartsCount,
            percent: Math.round((completedPartsCount / totalPartsCount) * 100)
        });
    }

    onLog('info', `[워커${workerId}] 완료: ${localResults.length}개 클립`);

    } catch (error) {
        onLog('error', `[워커${workerId}] 오류 발생: ${error.message}`);
    }

    return localResults; // 수집된 것까지만 반환
}

/**
 * 목록 수집 중지
 */
function stopFetch() {
    if (isFetching) {
        isFetching = false;
        onLog('warn', '목록 수집 중지 요청됨');
    }
}

/**
 * 강의 목록 수집 (병렬)
 */
async function fetchList(courseUrl) {
    if (!browserContext) {
        return { success: false, error: '먼저 로그인하세요' };
    }

    if (isFetching) {
        return { success: false, error: '이미 목록 수집 중입니다' };
    }

    isFetching = true;

    // 공유 결과 배열 초기화
    sharedCollectedResults = [];

    // 기존 상태 로드 (클립 키 기반 매칭)
    const savedStatus = loadStatus();
    const statusMap = {};
    savedStatus.forEach(s => {
        const key = getClipKey(s);
        statusMap[key] = { status: s.status, m3u8_url: s.m3u8_url };
    });

    if (savedStatus.length > 0) {
        const completedCount = savedStatus.filter(s => s.status === 'completed').length;
        onLog('info', `저장된 상태 로드: ${savedStatus.length}개 (완료: ${completedCount}개)`);
    }

    onLog('info', '강의 페이지로 이동 중...');
    onProgress({ type: 'fetch', current: 0, total: 100, percent: 0 });

    // 페이지 복구용 URL 저장
    currentCourseUrl = courseUrl;

    await page.goto(courseUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    await closePopup();

    onLog('info', '강의 구조 분석 중...');

    // Part 토글들 개수 확인
    const partToggles = await page.locator('.classroom-sidebar-clip__chapter__title').all();
    const totalParts = partToggles.length;
    totalPartsCount = totalParts;
    completedPartsCount = 0;
    onLog('info', `${totalParts}개 Part 발견 → ${PARALLEL_WORKERS}개 워커로 병렬 수집`);
    onProgress({ type: 'fetch', current: 0, total: totalParts, percent: 0 });

    // 워커별 Part 범위 계산
    const partsPerWorker = Math.ceil(totalParts / PARALLEL_WORKERS);
    const workerRanges = [];
    for (let i = 0; i < PARALLEL_WORKERS; i++) {
        const start = i * partsPerWorker;
        const end = Math.min(start + partsPerWorker, totalParts);
        if (start < totalParts) {
            workerRanges.push({ start, end });
        }
    }

    // 워커 페이지들 생성 (같은 세션 공유)
    const workerPages = [];
    for (let i = 0; i < workerRanges.length; i++) {
        const newPage = await browserContext.newPage();
        workerPages.push(newPage);
    }

    // 병렬 수집 실행 (각 워커 1초 간격으로 시작)
    const workerPromises = workerRanges.map((range, idx) =>
        new Promise(resolve => {
            setTimeout(async () => {
                const result = await fetchPartRange(workerPages[idx], courseUrl, range.start, range.end, totalParts, statusMap, idx + 1);
                resolve(result);
            }, idx * 1000); // 워커마다 1초 딜레이
        })
    );

    // 워커 완료 대기
    await Promise.all(workerPromises);

    // 워커 페이지들 닫기
    for (const wp of workerPages) {
        await wp.close();
    }

    // 공유 배열에서 최종 결과 가져오기 (이미 실시간으로 브로드캐스트됨)
    const sorted = [...sharedCollectedResults].sort((a, b) => {
        if (a.partNum !== b.partNum) return a.partNum - b.partNum;
        if (a.chapterNum !== b.chapterNum) return a.chapterNum - b.chapterNum;
        return a.clipNum - b.clipNum;
    });

    // 클립 키 기반으로 이전 상태 병합
    const allResults = sorted.map((clip, idx) => {
        const globalIndex = idx + 1;
        const clipKey = getClipKey(clip);
        const saved = statusMap[clipKey];
        const existingStatus = saved ? saved.status : 'pending';
        const existingUrl = saved ? saved.m3u8_url : null;
        return {
            ...clip,
            index: globalIndex,
            status: existingStatus,
            m3u8_url: existingUrl || clip.m3u8_url,
            selected: existingStatus !== 'completed'
        };
    });

    const completedCount = allResults.filter(c => c.status === 'completed').length;
    if (completedCount > 0) {
        onLog('info', `이전 작업 복원: ${completedCount}개 완료됨`);
    }

    onLog('info', `총 ${allResults.length}개 클립 발견`);

    // 상태 저장
    saveStatus(allResults);

    // 최종 목록 업데이트
    onListUpdate(allResults);

    isFetching = false;

    onProgress({
        type: 'fetch',
        current: totalParts,
        total: totalParts,
        percent: 100
    });

    return { success: true, data: allResults, stopped: !isFetching && sharedCollectedResults.length < totalPartsCount };
}

/**
 * 페이지 복구 (강의 페이지로 새로고침)
 */
async function recoverPage() {
    if (!currentCourseUrl || !page) return false;

    try {
        onLog('warn', '🔄 페이지 복구 중...');
        await page.goto(currentCourseUrl, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(2000);
        await closePopup();
        onLog('info', '✅ 페이지 복구 완료');
        return true;
    } catch (e) {
        onLog('error', `❌ 페이지 복구 실패: ${e.message}`);
        return false;
    }
}

/**
 * 클립의 m3u8 URL 수집 (내부 구현)
 */
async function collectClipUrlInternal(clip) {
    let capturedUrl = null;

    // 네트워크 응답 감시
    const responseHandler = (response) => {
        const url = response.url();
        if (url.includes('.m3u8') && url.includes('kollus.com')) {
            capturedUrl = url.replace('zcdn.kollus.com', 'ycdn.kollus.com');
        }
    };

    page.on('response', responseHandler);

    try {
        // Part 펼치기
        const partToggles = await page.locator('.classroom-sidebar-clip__chapter__title').all();
        if (clip.partNum <= partToggles.length) {
            const partToggle = partToggles[clip.partNum - 1];
            const partContainer = partToggle.locator('..').locator('..').locator('..');
            const partHeader = partToggle.locator('..');
            await partHeader.click({ force: true, timeout: 5000 });
            await page.waitForTimeout(800);

            // Chapter 펼치기
            const chapterToggles = await partContainer.locator('.classroom-sidebar-clip__chapter__part__title').all();
            if (clip.chapterNum <= chapterToggles.length) {
                const chapterToggle = chapterToggles[clip.chapterNum - 1];
                const parentToggle = chapterToggle.locator('..');
                await parentToggle.click({ force: true, timeout: 5000 });
                await page.waitForTimeout(800);

                // 클립 클릭
                const chapterContainer = chapterToggle.locator('..').locator('..');
                const clips = await chapterContainer.locator('.classroom-sidebar-clip__chapter__clip__title').all();
                if (clip.clipNum <= clips.length) {
                    await closePopup();
                    await clips[clip.clipNum - 1].click({ force: true, timeout: 5000 });
                    await page.waitForTimeout(1000);
                    await closePopup();

                    // m3u8 URL 캡처 대기 (최대 10초, 100ms 간격 폴링)
                    const startTime = Date.now();
                    while (!capturedUrl && (Date.now() - startTime) < URL_CAPTURE_MAX_WAIT) {
                        await page.waitForTimeout(100);
                    }
                }
            }
        }
    } finally {
        page.off('response', responseHandler);
    }

    return capturedUrl;
}

/**
 * 클립의 m3u8 URL 수집 (타임아웃 + 재시도 래퍼)
 */
async function collectClipUrl(clip, retryCount = 0) {
    // 타임아웃과 함께 URL 수집 실행
    const collectWithTimeout = () => {
        return new Promise(async (resolve) => {
            const timeout = setTimeout(() => {
                onLog('warn', `⏱️ URL 수집 타임아웃 (${URL_COLLECT_TIMEOUT/1000}초): ${clip.title.slice(0, 30)}`);
                resolve(null);
            }, URL_COLLECT_TIMEOUT);

            try {
                const url = await collectClipUrlInternal(clip);
                clearTimeout(timeout);
                resolve(url);
            } catch (e) {
                clearTimeout(timeout);
                onLog('error', `URL 수집 오류: ${e.message.slice(0, 50)}`);
                resolve(null);
            }
        });
    };

    const url = await collectWithTimeout();

    // URL 수집 성공
    if (url) {
        return url;
    }

    // 재시도 (최대 URL_COLLECT_RETRIES회)
    if (retryCount < URL_COLLECT_RETRIES - 1) {
        onLog('warn', `🔄 URL 수집 재시도 (${retryCount + 2}/${URL_COLLECT_RETRIES}): ${clip.title.slice(0, 30)}`);

        // 페이지 복구 후 재시도
        const recovered = await recoverPage();
        if (recovered) {
            await page.waitForTimeout(1000);
            return collectClipUrl(clip, retryCount + 1);
        }
    }

    onLog('error', `❌ URL 수집 최종 실패: ${clip.title.slice(0, 30)}`);
    return null;
}

/**
 * 단일 다운로드 시도
 */
function downloadVideoOnce(m3u8Url, outputPath) {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', m3u8Url,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-max_muxing_queue_size', '2048',
            '-movflags', '+faststart',
            '-progress', 'pipe:1',
            '-loglevel', 'error',
            '-y',
            outputPath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let duration = 0;
        let currentTime = 0;

        ffmpeg.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            lines.forEach(line => {
                if (line.startsWith('duration=')) {
                    const val = parseFloat(line.split('=')[1]);
                    if (!isNaN(val) && val > 0) duration = val;
                }
                if (line.startsWith('out_time_ms=')) {
                    const val = parseInt(line.split('=')[1]) / 1000000;
                    if (!isNaN(val)) currentTime = val;
                }
            });

            // 진행률 계산
            if (duration > 0) {
                const percent = Math.min(100, Math.round((currentTime / duration) * 100));
                onProgress({
                    type: 'download',
                    file: path.basename(outputPath),
                    percent,
                    currentTime,
                    duration
                });
            }
        });

        ffmpeg.stderr.on('data', () => {});

        let finished = false;

        const timeout = setTimeout(() => {
            if (!finished) {
                ffmpeg.kill('SIGKILL');
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                resolve({ success: false, reason: 'timeout' });
            }
        }, DOWNLOAD_TIMEOUT);

        ffmpeg.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);

            if (code === 0) {
                resolve({ success: true });
            } else {
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                resolve({ success: false, reason: 'ffmpeg_error' });
            }
        });

        ffmpeg.on('error', () => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            resolve({ success: false, reason: 'spawn_error' });
        });
    });
}

/**
 * 클립 다운로드 (재시도 포함)
 */
async function downloadClip(clip, outputDir) {
    const hasChapterInTitle = /^CH?\d+/i.test(clip.title.trim());
    const titlePart = sanitizeFilename(clip.title);
    const chapterPart = clip.chapterPrefix || `Ch${clip.chapterNum}`;
    const filename = hasChapterInTitle
        ? `PART${clip.partNum}-${titlePart}.mp4`
        : `PART${clip.partNum}-${chapterPart}-${titlePart}.mp4`;

    const partDir = path.join(outputDir, sanitizeFilename(clip.partTitle));
    if (!fs.existsSync(partDir)) {
        fs.mkdirSync(partDir, { recursive: true });
    }

    const outputPath = path.join(partDir, filename);

    // 이미 존재하면 스킵
    if (fs.existsSync(outputPath)) {
        onLog('info', `📁 스킵: ${filename.slice(0, 50)}`);
        return { success: true, skipped: true };
    }

    // URL 수집 (없으면)
    if (!clip.m3u8_url) {
        onLog('info', `🔍 URL 수집: ${clip.title.slice(0, 40)}`);
        clip.m3u8_url = await collectClipUrl(clip);
        if (!clip.m3u8_url) {
            onLog('error', `URL 수집 실패: ${clip.title.slice(0, 40)}`);
            return { success: false, reason: 'no_url' };
        }
    }

    // 다운로드 (최대 3회 재시도)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (attempt === 1) {
            onLog('info', `⬇️ 다운로드: ${filename.slice(0, 45)}`);
        } else {
            onLog('warn', `🔄 재시도 ${attempt}/${MAX_RETRIES}: ${filename.slice(0, 35)}`);
        }

        onStatusChange(clip.index, 'downloading');

        const result = await downloadVideoOnce(clip.m3u8_url, outputPath);

        if (result.success) {
            onLog('info', `✅ 완료: ${filename.slice(0, 45)}`);
            onStatusChange(clip.index, 'completed');
            return { success: true };
        }

        if (attempt < MAX_RETRIES) {
            onLog('warn', `⚠️ 실패 (${result.reason}), 3초 후 재시도...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    onLog('error', `❌ 최종 실패: ${filename.slice(0, 45)}`);
    onStatusChange(clip.index, 'failed');
    return { success: false };
}

/**
 * 다운로드 - download_ex.js 방식 (워커가 큐 폴링) - 개선 버전
 */
async function downloadItems(items, outputDir) {
    if (isRunning) {
        return { success: false, error: '이미 다운로드가 진행 중입니다' };
    }

    isRunning = true;
    const total = items.length;

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    onLog('info', `📥 다운로드 시작: ${total}개 항목 (동시 최대 ${MAX_CONCURRENT_DOWNLOADS}개)`);

    // 다운로드 큐와 상태
    downloadQueue = [];
    activeDownloads = 0;
    let urlCollectedCount = 0;
    let downloadCompletedCount = 0;
    let downloadFailedCount = 0;
    let skippedCount = 0;
    let urlCollectionDone = false;       // URL 수집 완료 플래그
    let workersShouldStop = false;       // 워커 종료 플래그

    // 진행률 업데이트
    const updateProgress = () => {
        const processed = downloadCompletedCount + downloadFailedCount + skippedCount;
        onProgress({
            type: 'pipeline',
            urlCollected: urlCollectedCount,
            completed: downloadCompletedCount,
            failed: downloadFailedCount,
            skipped: skippedCount,
            downloading: activeDownloads,
            queued: downloadQueue.length,
            total,
            percent: Math.round((processed / total) * 100)
        });
    };

    // 상태 저장
    const saveClipStatus = (clip) => {
        const allClips = loadStatus();
        const idx = allClips.findIndex(c => c.index === clip.index);
        if (idx >= 0) {
            allClips[idx].status = clip.status;
            allClips[idx].m3u8_url = clip.m3u8_url;
        }
        saveStatus(allClips);
    };

    // 단일 클립 다운로드
    const downloadSingleClip = async (job) => {
        const { clip, outputPath } = job;
        let success = false;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            if (!isRunning) break;

            if (attempt === 1) {
                onLog('info', `⬇️ [진행:${activeDownloads} 대기:${downloadQueue.length}] ${clip.title.slice(0, 35)}`);
            } else {
                onLog('warn', `🔄 다운로드 재시도 ${attempt}/${MAX_RETRIES}: ${clip.title.slice(0, 30)}`);
            }

            onStatusChange(clip.index, 'downloading');
            const result = await downloadVideoOnce(clip.m3u8_url, outputPath);

            if (result.success) {
                success = true;
                break;
            }

            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        if (success) {
            onLog('info', `✅ 완료: ${clip.title.slice(0, 40)}`);
            clip.status = 'completed';
            onStatusChange(clip.index, 'completed');
            downloadCompletedCount++;
        } else {
            onLog('error', `❌ 다운로드 실패: ${clip.title.slice(0, 40)}`);
            clip.status = 'failed';
            onStatusChange(clip.index, 'failed');
            downloadFailedCount++;
        }

        saveClipStatus(clip);
        updateProgress();
    };

    // 다운로드 워커 (큐 폴링 방식) - 개선: 정상 종료 지원
    const downloadWorker = async (workerId) => {
        while (!workersShouldStop) {
            if (downloadQueue.length > 0) {
                const job = downloadQueue.shift();
                if (job) {
                    activeDownloads++;
                    await downloadSingleClip(job);
                    activeDownloads--;
                }
            } else if (urlCollectionDone && downloadQueue.length === 0) {
                // URL 수집 완료 + 큐 비어있음 → 종료
                break;
            } else {
                // 큐가 비어있지만 URL 수집 중 → 대기
                await new Promise(r => setTimeout(r, 100));
            }
        }
    };

    // 워커 3개 시작 (Promise 배열로 관리)
    const workerPromises = [];
    for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
        workerPromises.push(downloadWorker(i + 1));
    }

    // URL 수집하면서 큐에 추가
    let currentClipIndex = 0;
    for (const clip of items) {
        currentClipIndex++;
        if (!isRunning) {
            onLog('warn', `⚠️ 중지됨 (${currentClipIndex}/${total})`);
            break;
        }

        // 파일명 생성
        const hasChapterInTitle = /^CH?\d+/i.test(clip.title.trim());
        const titlePart = sanitizeFilename(clip.title);
        const chapterPart = clip.chapterPrefix || `Ch${clip.chapterNum}`;
        const filename = hasChapterInTitle
            ? `PART${clip.partNum}-${titlePart}.mp4`
            : `PART${clip.partNum}-${chapterPart}-${titlePart}.mp4`;

        const partDir = path.join(outputDir, sanitizeFilename(clip.partTitle));
        if (!fs.existsSync(partDir)) {
            fs.mkdirSync(partDir, { recursive: true });
        }
        const outputPath = path.join(partDir, filename);

        // 이미 존재하면 스킵
        if (fs.existsSync(outputPath)) {
            onLog('info', `📁 스킵 (${currentClipIndex}/${total}): ${filename.slice(0, 40)}`);
            clip.status = 'completed';
            skippedCount++;
            urlCollectedCount++;
            saveClipStatus(clip);
            updateProgress();
            continue;
        }

        // URL 수집
        if (!clip.m3u8_url) {
            onLog('info', `🔍 URL 수집 (${currentClipIndex}/${total}) [대기:${downloadQueue.length}]: ${clip.title.slice(0, 25)}`);
            clip.m3u8_url = await collectClipUrl(clip);

            if (!clip.m3u8_url) {
                // URL 수집 최종 실패 → 스킵하고 다음으로
                onLog('error', `⏭️ 스킵 (URL 수집 실패): ${clip.title.slice(0, 30)}`);
                clip.status = 'failed';
                onStatusChange(clip.index, 'failed');
                downloadFailedCount++;
                urlCollectedCount++;
                saveClipStatus(clip);
                updateProgress();
                continue;
            }
        }

        urlCollectedCount++;
        saveClipStatus(clip);  // URL 저장

        // 큐에 추가 (워커가 가져감)
        downloadQueue.push({ clip, outputPath });
        updateProgress();
    }

    // URL 수집 완료 표시
    urlCollectionDone = true;
    onLog('info', `📋 URL 수집 완료, 남은 다운로드 대기 중...`);

    // 워커들이 종료될 때까지 대기
    await Promise.all(workerPromises);

    // 완료 처리
    workersShouldStop = true;
    isRunning = false;

    const totalProcessed = downloadCompletedCount + skippedCount + downloadFailedCount;
    onLog('info', `\n${'='.repeat(50)}`);
    onLog('info', `📊 다운로드 완료 결과`);
    onLog('info', `   ✅ 성공: ${downloadCompletedCount}개`);
    onLog('info', `   📁 스킵: ${skippedCount}개`);
    onLog('info', `   ❌ 실패: ${downloadFailedCount}개`);
    onLog('info', `   📈 총: ${totalProcessed}/${total}개`);
    onLog('info', `${'='.repeat(50)}`);

    return {
        success: true,
        completed: downloadCompletedCount,
        skipped: skippedCount,
        failed: downloadFailedCount
    };
}

/**
 * 다운로드 중지
 */
function stopDownload() {
    isRunning = false;
    onLog('warn', '다운로드 중지 요청됨');
}

/**
 * 상태 초기화 (목록 삭제)
 */
function clearStatus() {
    if (fs.existsSync(STATUS_FILE)) {
        fs.unlinkSync(STATUS_FILE);
        onLog('info', '저장된 목록이 삭제되었습니다');
    }
    return { success: true };
}

/**
 * 상태 확인
 */
function getStatus() {
    return {
        isRunning,
        isFetching,
        isLoggedIn,
        queueLength: downloadQueue.length,
        activeDownloads
    };
}

module.exports = {
    setCallbacks,
    login,
    fetchList,
    stopFetch,
    downloadItems,
    stopDownload,
    closeBrowser,
    getStatus,
    loadStatus,
    saveStatus,
    clearStatus
};
