# Fastcamp Downloader

패스트캠퍼스 KDT 강의 영상을 자동으로 수집하고 다운로드하는 도구입니다.

## 빠른 시작

```bash
# 1. 의존성 설치
npm install

# 2. Playwright 브라우저 설치
npx playwright install chromium

# 3. 설정 파일 생성
cp config.example.json config.json
# config.json에서 강의 URL 수정

# 4. 서버 실행
npm start

# 5. 브라우저에서 접속
open http://localhost:3000
```

## 주요 기능

### 웹 UI
- 브라우저에서 편리하게 설정 및 관리
- 실시간 진행 상황 확인 (WebSocket)
- 다크 테마 인터페이스

### 자동화
- **자동 로그인** - 아이디/비밀번호 입력 후 자동으로 로그인
- **Headless 모드** - 브라우저 창 없이 백그라운드 실행
- **이어받기** - 프로그램 재실행 시 미완료 항목부터 자동 재개

### 병렬 처리
- **병렬 목록 수집** - 3개 워커가 동시에 Part를 수집 (속도 3배)
- **병렬 다운로드** - 3개 파일 동시 다운로드
- **파이프라인 방식** - URL 수집과 다운로드를 동시에 진행

### 제어
- **실시간 목록 수집** - 강의 목록 수집 중 실시간으로 UI에 표시
- **수집 중지** - 목록 수집 중 언제든 중지 가능 (수집된 항목 유지)
- **다운로드 중지** - 다운로드 진행 중 중지 가능
- **선택적 다운로드** - 체크박스로 원하는 항목만 선택

### 저장
- **진행 상태 저장** - 완료/미완료 상태를 파일로 저장
- **외장 드라이브 지원** - 외장 SSD 등 원하는 경로에 저장 가능
- **실시간 진행률** - 각 파일별 다운로드 % 표시

## 파일 구조

```
├── server.js                 # 웹 서버 (Express + WebSocket)
├── downloader.js             # 다운로드 로직 모듈 (병렬 처리)
├── public/
│   └── index.html            # 웹 UI 페이지
├── config.json               # 설정 파일 (Git 제외)
├── config.example.json       # 설정 파일 예시
├── download-status.json      # 다운로드 진행 상태 (자동 생성)
├── collect-and-download.js   # CLI 버전 (수동 로그인)
├── download_ex.js            # CLI 버전 (실험용)
├── retry-failed.js           # 실패 재시도
└── package.json
```

## 요구사항

- **Node.js** v18 이상
- **ffmpeg** (시스템에 설치 필요)
- **Playwright** (Chromium 브라우저)

## 설치

### 1. 의존성 설치

```bash
npm install
```

### 2. ffmpeg 설치

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows (Chocolatey)
choco install ffmpeg
```

### 3. Playwright 브라우저 설치

```bash
npx playwright install chromium
```

## 설정

### config.json 설정

```bash
# 예시 파일 복사
cp config.example.json config.json
```

`config.json` 파일을 열어 강의 URL과 저장 경로를 설정합니다:

```json
{
  "courseUrl": "https://kdt.fastcampus.co.kr/classroom/YOUR_COURSE_ID?organizationProductId=YOUR_ORG_ID",
  "outputDir": "./videos"
}
```

### 저장 경로 예시

```json
// 로컬 폴더
"outputDir": "./videos"

// 외장 SSD (macOS)
"outputDir": "/Volumes/MySSD/fastcampus_download"

// 절대 경로
"outputDir": "/Users/username/Downloads/fastcampus"
```

> **참고**: `config.json`은 `.gitignore`에 포함되어 Git에 업로드되지 않습니다.

## 사용법

### 방법 1: 웹 UI (권장)

```bash
npm start
# 또는
node server.js
```

1. 브라우저에서 `http://localhost:3000` 접속
2. 이전에 수집한 목록이 있으면 자동으로 표시됨
3. 강의 URL, 아이디, 비밀번호, 저장 폴더 입력
4. **목록 가져오기** 클릭
   - 수집 중 버튼이 빨간색 **⏹ 중지**로 변경
   - 클릭하면 수집 중지 (수집된 항목은 유지됨)
5. 다운로드할 항목 체크박스로 선택
6. **선택 항목 다운로드** 클릭 (로그인 후에만 활성화)
7. 실시간 진행 상황 확인

### 상태 아이콘

| 아이콘 | 상태 |
|--------|------|
| ⬜ | 대기 (미다운로드) |
| ⏳ | 다운로드 중 |
| ✅ | 완료 |
| ❌ | 실패 |

### 방법 2: CLI (수동 로그인)

```bash
npm run cli
# 또는
node collect-and-download.js
```

1. 브라우저가 열리면 패스트캠퍼스에 **직접 로그인**합니다
2. 로그인 후 강의실 페이지로 이동하면 자동 수집 및 다운로드 시작

### 실패한 영상 재시도

```bash
node retry-failed.js
```

## 출력 파일

| 파일 | 설명 |
|------|------|
| `download-status.json` | 다운로드 진행 상태 (이어받기용) |
| `video-urls.json` | 수집된 모든 클립 URL 목록 (CLI 모드) |
| `failed-downloads.json` | 다운로드 실패한 클립 목록 |
| `videos/` | 다운로드된 영상 (Part별 폴더) |

### 폴더 구조

```
videos/
├── Part 1 - 강의제목/
│   ├── PART1-Ch1-클립제목.mp4
│   ├── PART1-Ch2-클립제목.mp4
│   └── ...
├── Part 2 - 강의제목/
│   └── ...
└── ...
```

## 아키텍처

### 웹 UI 모드

```
┌─────────────┐     WebSocket     ┌─────────────┐
│  브라우저    │ ◄──────────────► │  server.js  │
│ (index.html)│                   │   (3000)    │
└─────────────┘                   └──────┬──────┘
                                         │
                                         ▼
                                  ┌─────────────┐
                                  │ downloader  │
                                  │    .js      │
                                  └──────┬──────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
        ▼                                ▼                                ▼
  ┌───────────┐                   ┌───────────┐                   ┌───────────┐
  │  Worker 1 │                   │  Worker 2 │                   │  Worker 3 │
  │ Part 수집  │                   │ Part 수집  │                   │ Part 수집  │
  └───────────┘                   └───────────┘                   └───────────┘
```

### 다운로드 파이프라인

```
[URL 수집] ──► [다운로드 큐] ──► [Worker 1] ──► [완료]
                    │
                    ├──────────► [Worker 2] ──► [완료]
                    │
                    └──────────► [Worker 3] ──► [완료]
```

## 성능

### 목록 수집 속도

| 방식 | Part 147개 기준 |
|------|-----------------|
| 순차 수집 | ~5분 |
| 병렬 수집 (3 워커) | ~1.5분 |

### 설정 가능 옵션

| 설정 | 파일 | 기본값 |
|------|------|--------|
| 병렬 워커 수 | `downloader.js` | `PARALLEL_WORKERS = 3` |
| 동시 다운로드 수 | `downloader.js` | `MAX_CONCURRENT_DOWNLOADS = 3` |
| 다운로드 타임아웃 | `downloader.js` | `DOWNLOAD_TIMEOUT = 5분` |
| 재시도 횟수 | `downloader.js` | `MAX_RETRIES = 3` |

## 기술 스택

- **Express** - 웹 서버
- **WebSocket (ws)** - 실시간 통신
- **Playwright** - 브라우저 자동화
- **ffmpeg** - 영상 다운로드 및 변환

## 주의사항

- 다운로드 타임아웃: 5분 (영상당)
- 실패 시 자동 재시도: 최대 3회
- 이미 다운로드된 파일은 자동 스킵
- 강의 수강권이 있는 계정으로 로그인해야 합니다

## 문제 해결

### ffmpeg을 찾을 수 없음
```bash
which ffmpeg  # 경로 확인
```
PATH에 ffmpeg이 등록되어 있는지 확인하세요.

### Playwright 브라우저 오류
```bash
npx playwright install chromium --force
```

### 다운로드 속도가 느림
`downloader.js`의 `MAX_CONCURRENT_DOWNLOADS` 값을 조정하세요 (기본값: 3).

### 외장 드라이브에 저장 안됨
- macOS: `/Volumes/드라이브명/폴더` 형식으로 입력
- 드라이브 포맷이 NTFS면 읽기 전용이므로 exFAT 또는 APFS로 포맷 필요

### 목록 수집이 중간에 멈춤
- 네트워크 상태 확인
- 웹 UI의 **목록 삭제** 버튼으로 초기화 후 재시도

### 로그인 실패
- 이메일/비밀번호 확인
- 캡차가 있는 경우 CLI 모드(`npm run cli`)로 수동 로그인 사용

## 라이선스

ISC
