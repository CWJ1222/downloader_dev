const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// 설정
const COURSE_URL =
  "https://kdt.fastcampus.co.kr/classroom/236004?organizationProductId=23601";
const OUTPUT_FILE = "./video-urls.json";
const OUTPUT_DIR = "./videos";

// 테스트 모드
const TEST_MODE = false; // false = 전체 다운로드
const TEST_LIMIT = 30;

// 동시 다운로드 수
const MAX_CONCURRENT_DOWNLOADS = 3;

// 다운로드 큐와 상태
const downloadQueue = [];
let activeDownloads = 0;
let downloadedCount = 0;
let downloadFailedCount = 0;

// 전체 결과
const results = [];

// 파일명 정리
function sanitizeFilename(name) {
  return name
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);
}

// 다운로드 설정
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000; // 5분
const MAX_RETRIES = 3;

// 실패한 다운로드 목록 (나중에 재시도용)
const failedDownloads = [];

// 단일 다운로드 시도
function downloadVideoOnce(clip, outputPath) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        clip.m3u8_url,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-max_muxing_queue_size",
        "2048",
        "-movflags",
        "+faststart",
        "-loglevel",
        "error", // 에러만 출력
        "-y",
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    ); // stdout도 ignore

    // stderr만 읽어서 버퍼 비우기 (block 방지)
    ffmpeg.stderr.on("data", () => {});

    let finished = false;

    const timeout = setTimeout(() => {
      if (!finished) {
        ffmpeg.kill("SIGKILL");
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        resolve({ success: false, reason: "timeout" });
      }
    }, DOWNLOAD_TIMEOUT);

    ffmpeg.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve({ success: true });
      } else {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        resolve({ success: false, reason: "ffmpeg_error" });
      }
    });

    ffmpeg.on("error", () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({ success: false, reason: "spawn_error" });
    });
  });
}

// 재시도 포함 다운로드
async function downloadVideo(clip) {
  // 원본 제목에 Chapter 정보(CH01, Ch1 등)가 있는지 확인
  const hasChapterInTitle = /^CH?\d+/i.test(clip.title.trim());
  const titlePart = sanitizeFilename(clip.title);

  // Chapter 정보 없으면 DOM에서 가져온 chapterPrefix 사용
  const chapterPart = clip.chapterPrefix || `Ch${clip.chapterNum}`;
  const filename = hasChapterInTitle
    ? `PART${clip.partNum}-${titlePart}.mp4`
    : `PART${clip.partNum}-${chapterPart}-${titlePart}.mp4`;
  const partDir = path.join(OUTPUT_DIR, sanitizeFilename(clip.partTitle));

  if (!fs.existsSync(partDir)) {
    fs.mkdirSync(partDir, { recursive: true });
  }

  const outputPath = path.join(partDir, filename);

  // 이미 존재하면 스킵
  if (fs.existsSync(outputPath)) {
    console.log(`    📁 스킵: ${filename.slice(0, 60)}`);
    return { success: true, skipped: true };
  }

  // 최대 3회 재시도
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt === 1) {
      console.log(`    ⬇️  다운로드: ${filename.slice(0, 50)}...`);
    } else {
      console.log(
        `    🔄 재시도 ${attempt}/${MAX_RETRIES}: ${filename.slice(0, 40)}...`
      );
    }

    const result = await downloadVideoOnce(clip, outputPath);

    if (result.success) {
      console.log(`    ✅ 완료: ${filename.slice(0, 50)}`);
      return { success: true };
    }

    if (attempt < MAX_RETRIES) {
      console.log(`    ⚠️ 실패 (${result.reason}), 3초 후 재시도...`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // 모든 재시도 실패
  console.log(`    ❌ 최종 실패: ${filename.slice(0, 50)}`);
  failedDownloads.push({ clip, filename, outputPath });
  return { success: false };
}

// 다운로드 워커
async function downloadWorker() {
  while (true) {
    if (
      downloadQueue.length > 0 &&
      activeDownloads < MAX_CONCURRENT_DOWNLOADS
    ) {
      const clip = downloadQueue.shift();
      activeDownloads++;
      const result = await downloadVideo(clip);
      activeDownloads--;
      if (result.success && !result.skipped) downloadedCount++;
      else if (!result.success) downloadFailedCount++;
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // 다운로드 워커 시작
  for (let i = 0; i < MAX_CONCURRENT_DOWNLOADS; i++) {
    downloadWorker();
  }

  console.log("브라우저 시작...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  let capturedUrl = null;
  let globalIndex = 0;

  page.on("response", (response) => {
    const url = response.url();
    if (url.includes(".m3u8") && url.includes("kollus.com")) {
      capturedUrl = url.replace("zcdn.kollus.com", "ycdn.kollus.com");
    }
  });

  console.log("로그인 페이지 접속...");
  await page.goto("https://kdt.fastcampus.co.kr/account/sign-in", {
    waitUntil: "networkidle",
    timeout: 60000,
  });

  console.log("\n========================================");
  console.log("🔐 브라우저에서 로그인해주세요!");
  console.log("========================================\n");

  await page.waitForURL(/classroom/, { timeout: 0 });
  console.log("✓ 로그인 완료!\n");

  console.log("강의실 페이지로 이동...");
  await page.goto(COURSE_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  // 팝업 닫기
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

  await closePopup();

  // Part 토글들 가져오기 (Part만, Chapter 제외)
  // Part는 classroom-sidebar-clip__chapter__title__text 클래스를 가진 p 태그의 부모
  const partToggles = await page
    .locator(".classroom-sidebar-clip__chapter__title")
    .all();
  console.log(`\n총 ${partToggles.length}개 Part 발견\n`);

  let partNum = 0;

  for (let partIdx = 0; partIdx < partToggles.length; partIdx++) {
    if (TEST_MODE && globalIndex >= TEST_LIMIT) {
      console.log(`\n테스트 모드: ${TEST_LIMIT}개 제한 도달`);
      break;
    }

    // Part 토글 다시 가져오기
    const currentPartToggles = await page
      .locator(".classroom-sidebar-clip__chapter__title")
      .all();
    if (partIdx >= currentPartToggles.length) break;

    const partToggle = currentPartToggles[partIdx];

    // Part 이름 가져오기
    let partTitle = "";
    try {
      const titleEl = partToggle.locator(
        ".classroom-sidebar-clip__chapter__title__text"
      );
      partTitle = await titleEl.textContent();
      partTitle = partTitle.trim();
    } catch (e) {
      partTitle = `Part ${partIdx + 1}`;
    }

    partNum++;

    console.log(`\n${"=".repeat(60)}`);
    console.log(`📂 PART ${partNum}: ${partTitle.slice(0, 50)}`);
    console.log(`${"=".repeat(60)}`);

    // Part 컨테이너 가져오기 (.classroom-sidebar-clip__chapter)
    // 구조: .classroom-sidebar-clip__chapter > .common-accordion-menu > .common-accordion-menu__header > .classroom-sidebar-clip__chapter__title
    let partContainer;
    try {
      partContainer = partToggle.locator("..").locator("..").locator("..");
      await partContainer.scrollIntoViewIfNeeded({ timeout: 3000 });

      // Part 펼치기 (header 클릭)
      const partHeader = partToggle.locator("..");
      await partHeader.click({ force: true });
      await page.waitForTimeout(1500);
    } catch (e) {
      console.log(`  ⚠️ Part 펼치기 실패: ${e.message}`);
      continue;
    }

    await closePopup();

    // 이 Part 컨테이너 내의 Chapter 토글들만 가져오기
    const chapterToggles = await partContainer
      .locator(".classroom-sidebar-clip__chapter__part__title")
      .all();
    console.log(`  📋 ${chapterToggles.length}개 Chapter 발견`);

    let chapterNum = 0;

    for (let chIdx = 0; chIdx < chapterToggles.length; chIdx++) {
      if (TEST_MODE && globalIndex >= TEST_LIMIT) break;

      // Chapter 토글 다시 가져오기 (Part 컨테이너 내에서만)
      const currentChapterToggles = await partContainer
        .locator(".classroom-sidebar-clip__chapter__part__title")
        .all();
      if (chIdx >= currentChapterToggles.length) break;

      const chapterToggle = currentChapterToggles[chIdx];

      // Chapter 이름 가져오기
      let chapterTitle = "";
      let chapterPrefix = "";
      try {
        chapterTitle = await chapterToggle.textContent();
        chapterTitle = chapterTitle.trim();
        // Chapter prefix 추출 (예: "Ch 1", "Ch02", "CH01" 등)
        const prefixMatch = chapterTitle.match(/^(Ch\s*\d+|CH\s*\d+)/i);
        chapterPrefix = prefixMatch
          ? prefixMatch[1].replace(/\s+/g, "")
          : `Ch${chIdx + 1}`;
      } catch (e) {
        chapterTitle = `Ch ${chIdx + 1}`;
        chapterPrefix = `Ch${chIdx + 1}`;
      }

      chapterNum++;

      console.log(`\n  ─── ${chapterPrefix}: ${chapterTitle.slice(0, 40)} ───`);

      // Chapter 펼치기 (부모 토글 클릭)
      try {
        const parentToggle = chapterToggle.locator(".."); // 부모 요소
        await parentToggle.scrollIntoViewIfNeeded({ timeout: 3000 });

        // 이미 펼쳐져 있는지 확인
        const accordionMenu = parentToggle.locator("..");
        const isOpen = await accordionMenu.evaluate((el) =>
          el.classList.contains("common-accordion-menu--open")
        );

        if (!isOpen) {
          await parentToggle.click({ force: true });
          await page.waitForTimeout(1000);
        }
      } catch (e) {
        console.log(`    ⚠️ Chapter 펼치기 실패: ${e.message}`);
        continue;
      }

      await closePopup();
      await page.waitForTimeout(500);

      // 이 Chapter 내의 클립들 가져오기
      // Chapter 토글의 다음 형제 요소(content)에서 클립 찾기
      let clipElements = [];
      try {
        // 현재 Chapter의 부모 accordion-menu에서 클립들 찾기
        const chapterContainer = chapterToggle.locator("..").locator("..");
        clipElements = await chapterContainer
          .locator(".classroom-sidebar-clip__chapter__clip__title")
          .all();
      } catch (e) {
        console.log(`    ⚠️ 클립 목록 가져오기 실패`);
        continue;
      }

      console.log(`    📹 ${clipElements.length}개 클립`);

      let clipNum = 0;

      for (let clipIdx = 0; clipIdx < clipElements.length; clipIdx++) {
        if (TEST_MODE && globalIndex >= TEST_LIMIT) break;

        clipNum++;
        globalIndex++;

        // 클립 요소 다시 가져오기 (Part 컨테이너 내에서만)
        let clipEl;
        let title = "";
        try {
          const currentChToggles = await partContainer
            .locator(".classroom-sidebar-clip__chapter__part__title")
            .all();
          const chapterContainer = currentChToggles[chIdx]
            .locator("..")
            .locator("..");
          const clips = await chapterContainer
            .locator(".classroom-sidebar-clip__chapter__clip__title")
            .all();
          if (clipIdx >= clips.length) continue;
          clipEl = clips[clipIdx];
          title = await clipEl.textContent();
          title = title.trim();
        } catch (e) {
          console.log(`    ⚠️ 클립 요소 접근 실패`);
          continue;
        }

        console.log(`\n    [${globalIndex}] 🎬 ${title.slice(0, 45)}`);

        capturedUrl = null;

        try {
          await closePopup();
          await clipEl.click({ force: true, timeout: 5000 });
          await page.waitForTimeout(1500);
          await closePopup();
          await page.waitForTimeout(3000);

          if (capturedUrl) {
            const clipData = {
              index: globalIndex,
              title,
              partNum,
              partTitle,
              chapterNum,
              chapterTitle,
              chapterPrefix,
              clipNum,
              m3u8_url: capturedUrl,
            };
            results.push(clipData);
            downloadQueue.push(clipData);
            console.log(`      ✓ URL 수집 완료`);
          } else {
            results.push({
              index: globalIndex,
              title,
              partNum,
              partTitle,
              chapterNum,
              chapterTitle,
              chapterPrefix,
              clipNum,
              m3u8_url: null,
              error: "No URL",
            });
            console.log(`      ✗ URL 없음`);
          }
        } catch (err) {
          results.push({
            index: globalIndex,
            title,
            partNum,
            partTitle,
            chapterNum,
            chapterTitle,
            chapterPrefix,
            clipNum,
            m3u8_url: null,
            error: err.message,
          });
          console.log(`      ✗ 에러: ${err.message.slice(0, 30)}`);
        }
      }

      // Chapter 완료 후 중간 저장
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
    }

    // Part 완료
    console.log(`\n  ✓ Part ${partNum} 완료 (총 ${results.length}개 클립)`);

    // 다운로드 큐가 너무 쌓이면 대기
    while (downloadQueue.length > 10) {
      console.log(`  ⏳ 다운로드 대기... (큐: ${downloadQueue.length})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // 최종 저장
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
  const successCount = results.filter((r) => r.m3u8_url).length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`URL 수집 완료: ${successCount}/${results.length}개`);
  console.log(`${"=".repeat(60)}\n`);

  // 남은 다운로드 대기
  console.log("남은 다운로드 완료 대기...");
  while (downloadQueue.length > 0 || activeDownloads > 0) {
    console.log(
      `  대기: ${downloadQueue.length}, 진행: ${activeDownloads}, 완료: ${downloadedCount}`
    );
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`✅ 모든 작업 완료!`);
  console.log(`URL: ${successCount}/${results.length}`);
  console.log(
    `다운로드: ${downloadedCount}개 성공, ${downloadFailedCount}개 실패`
  );
  console.log(`${"=".repeat(60)}\n`);

  // 실패한 다운로드 목록 저장
  if (failedDownloads.length > 0) {
    console.log(`\n⚠️ 실패한 다운로드 ${failedDownloads.length}개:`);
    failedDownloads.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.filename}`);
    });

    // 실패 목록 파일로 저장
    const failedFile = "./failed-downloads.json";
    fs.writeFileSync(
      failedFile,
      JSON.stringify(
        failedDownloads.map((f) => f.clip),
        null,
        2
      )
    );
    console.log(`\n실패 목록 저장됨: ${failedFile}`);
    console.log(`재시도: node retry-failed.js`);
  }

  await browser.close();
  process.exit(0);
}

main().catch(console.error);
