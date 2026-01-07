const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = './videos';
const FAILED_FILE = './failed-downloads.json';
const DOWNLOAD_TIMEOUT = 5 * 60 * 1000;
const MAX_RETRIES = 3;

function sanitizeFilename(name) {
    return name
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);
}

function downloadVideoOnce(clip, outputPath) {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', [
            '-i', clip.m3u8_url,
            '-c', 'copy',
            '-bsf:a', 'aac_adtstoasc',
            '-y',
            outputPath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

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

    if (fs.existsSync(outputPath)) {
        console.log(`📁 스킵: ${filename.slice(0, 60)}`);
        return { success: true, skipped: true };
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (attempt === 1) {
            console.log(`⬇️  다운로드: ${filename.slice(0, 50)}...`);
        } else {
            console.log(`🔄 재시도 ${attempt}/${MAX_RETRIES}: ${filename.slice(0, 40)}...`);
        }

        const result = await downloadVideoOnce(clip, outputPath);

        if (result.success) {
            console.log(`✅ 완료: ${filename.slice(0, 50)}`);
            return { success: true };
        }

        if (attempt < MAX_RETRIES) {
            console.log(`⚠️ 실패 (${result.reason}), 3초 후 재시도...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    console.log(`❌ 최종 실패: ${filename.slice(0, 50)}`);
    return { success: false, clip };
}

async function main() {
    if (!fs.existsSync(FAILED_FILE)) {
        console.log('실패 목록 파일이 없습니다:', FAILED_FILE);
        return;
    }

    const failedClips = JSON.parse(fs.readFileSync(FAILED_FILE, 'utf-8'));
    console.log(`\n${failedClips.length}개 실패한 다운로드 재시도\n`);

    const stillFailed = [];
    let successCount = 0;

    for (const clip of failedClips) {
        const result = await downloadVideo(clip);
        if (result.success) {
            successCount++;
        } else {
            stillFailed.push(clip);
        }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`완료: ${successCount}/${failedClips.length}`);

    if (stillFailed.length > 0) {
        console.log(`여전히 실패: ${stillFailed.length}개`);
        fs.writeFileSync(FAILED_FILE, JSON.stringify(stillFailed, null, 2));
        console.log(`실패 목록 업데이트됨: ${FAILED_FILE}`);
    } else {
        fs.unlinkSync(FAILED_FILE);
        console.log('모든 다운로드 성공! 실패 목록 삭제됨.');
    }
}

main().catch(console.error);
