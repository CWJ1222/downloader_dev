# Fastcamp Downloader

패스트캠퍼스 KDT 강의 영상을 자동으로 수집하고 다운로드하는 도구입니다.

## 주요 기능

| 기능 | 설명 |
|------|------|
| **웹 UI** | 브라우저에서 간편하게 관리, 다크 테마 |
| **자동 로그인** | Headless 브라우저로 백그라운드 실행 |
| **병렬 수집** | 3개 워커로 목록 동시 수집 (3배 빠름) |
| **병렬 다운로드** | 3개 파일 동시 다운로드 |
| **이어받기** | 중단 후 재실행 시 자동 재개 |
| **실시간 진행률** | WebSocket으로 실시간 상태 확인 |

---

## 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. Playwright 브라우저 설치
npx playwright install chromium

# 3. 설정 파일 생성
cp config.example.json config.json

# 4. 서버 실행
npm start

# 5. 브라우저에서 접속
open http://localhost:3000
```

---

## 요구사항

| 항목 | 버전/설명 |
|------|-----------|
| Node.js | v18 이상 |
| ffmpeg | 시스템에 설치 필요 |
| Playwright | Chromium 브라우저 |

### ffmpeg 설치

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows (Chocolatey)
choco install ffmpeg
```

---

## 설정

### config.json

```bash
cp config.example.json config.json
```

```json
{
  "courseUrl": "https://kdt.fastcampus.co.kr/classroom/YOUR_COURSE_ID?organizationProductId=YOUR_ORG_ID",
  "outputDir": "./videos"
}
```

### 저장 경로 예시

| 환경 | 경로 |
|------|------|
| 로컬 폴더 | `./videos` |
| macOS 외장 SSD | `/Volumes/MySSD/fastcampus` |
| 절대 경로 | `/Users/username/Downloads/fastcampus` |

> `config.json`은 `.gitignore`에 포함되어 Git에 업로드되지 않습니다.

---

## 사용법

### 웹 UI (권장)

```bash
npm start
```

1. `http://localhost:3000` 접속
2. 강의 URL, 아이디, 비밀번호, 저장 폴더 입력
3. **목록 가져오기** 클릭
4. 다운로드할 항목 선택
5. **선택 항목 다운로드** 클릭

### 상태 아이콘

| 아이콘 | 상태 |
|--------|------|
| ⬜ | 대기 |
| ⏳ | 다운로드 중 |
| ✅ | 완료 |
| ❌ | 실패 |

### CLI 모드 (수동 로그인)

```bash
npm run cli
```

브라우저가 열리면 직접 로그인 후 자동 수집 시작

---

## 프로젝트 구조

```
fastcamp-downloader/
├── server.js              # Express + WebSocket 서버
├── downloader.js          # 다운로드 로직 (병렬 처리)
├── public/
│   └── index.html         # 웹 UI
├── config.json            # 설정 파일 (Git 제외)
├── config.example.json    # 설정 파일 예시
├── download-status.json   # 진행 상태 (자동 생성)
├── collect-and-download.js # CLI 버전
└── package.json
```

### 출력 폴더 구조

```
videos/
├── Part 1 - 강의제목/
│   ├── PART1-Ch1-클립제목.mp4
│   └── PART1-Ch2-클립제목.mp4
├── Part 2 - 강의제목/
│   └── ...
└── ...
```

---

## 아키텍처

```
┌─────────────┐     WebSocket     ┌─────────────┐
│   Browser   │ ◄───────────────► │  server.js  │
│ (index.html)│                   │   :3000     │
└─────────────┘                   └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │ downloader  │
                                  └──────┬──────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
   [Worker 1]                       [Worker 2]                       [Worker 3]
```

### 다운로드 파이프라인

```
[URL 수집] ──► [Queue] ──┬──► [Worker 1] ──► [완료]
                         ├──► [Worker 2] ──► [완료]
                         └──► [Worker 3] ──► [완료]
```

---

## 설정 옵션

`downloader.js`에서 수정 가능:

| 설정 | 기본값 | 설명 |
|------|--------|------|
| `PARALLEL_WORKERS` | 3 | 목록 수집 워커 수 |
| `MAX_CONCURRENT_DOWNLOADS` | 3 | 동시 다운로드 수 |
| `DOWNLOAD_TIMEOUT` | 5분 | 다운로드 타임아웃 |
| `MAX_RETRIES` | 3 | 재시도 횟수 |

---

## 문제 해결

### ffmpeg을 찾을 수 없음

```bash
which ffmpeg  # 경로 확인
```

### Playwright 브라우저 오류

```bash
npx playwright install chromium --force
```

### 외장 드라이브에 저장 안됨

- macOS: `/Volumes/드라이브명/폴더` 형식
- NTFS 포맷은 읽기 전용 → exFAT 또는 APFS로 포맷

### 로그인 실패

- 이메일/비밀번호 확인
- 캡차가 있으면 CLI 모드(`npm run cli`)로 수동 로그인

### 다운로드 속도 조절

`downloader.js`의 `MAX_CONCURRENT_DOWNLOADS` 값 조정

---

## 기술 스택

- **Express** - 웹 서버
- **WebSocket (ws)** - 실시간 통신
- **Playwright** - 브라우저 자동화
- **ffmpeg** - 영상 다운로드

---

## 라이선스

ISC
