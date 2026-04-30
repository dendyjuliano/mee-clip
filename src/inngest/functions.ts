import { inngest } from "./client";
import { supabaseAdmin } from "@/lib/supabase";
import { uploadVideo } from "@/lib/cloudinary";
import { create as createYoutubeDl } from "youtube-dl-exec";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import OpenAI from "openai";
import Groq from "groq-sdk";
import fs from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import os from "os";
import type { TranscriptSegment } from "@/types";

const YTDLP_TMP = path.join(os.tmpdir(), "yt-dlp");
// Standalone Linux binary (no Python required); ~60 MB, cached in /tmp across warm invocations
const YTDLP_DOWNLOAD_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

async function resolveYtDlpPath(): Promise<string> {
  // Dev: use the path set in env (e.g. /opt/homebrew/bin/yt-dlp)
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;

  // Production (Vercel / Linux): download the standalone binary once per Lambda instance
  if (!fs.existsSync(YTDLP_TMP)) {
    const res = await fetch(YTDLP_DOWNLOAD_URL, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`Failed to download yt-dlp: ${res.status}`);
    const ws = fs.createWriteStream(YTDLP_TMP);
    await pipeline(Readable.fromWeb(res.body as import("stream/web").ReadableStream), ws);
    fs.chmodSync(YTDLP_TMP, 0o755);
  }

  return YTDLP_TMP;
}

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// OpenRouter for chat/highlight analysis
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

// Groq for audio transcription (Whisper)
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function updateJobStatus(
  jobId: string,
  status: string,
  progress: number,
  errorMessage?: string
) {
  await supabaseAdmin
    .from("clip_jobs")
    .update({
      status,
      progress,
      error_message: errorMessage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);
}

const NETSCAPE_HEADER = "# Netscape HTTP Cookie File\n";

function resolveCookiesPath(): string | undefined {
  // Priority 1: base64 env var (Vercel) — decode to /tmp
  if (process.env.YTDLP_COOKIES_BASE64) {
    const tmpCookies = path.join(os.tmpdir(), "yt-cookies.txt");
    let content = Buffer.from(process.env.YTDLP_COOKIES_BASE64, "base64").toString("utf8");
    if (!content.startsWith("# Netscape")) content = NETSCAPE_HEADER + content;
    fs.writeFileSync(tmpCookies, content);
    return tmpCookies;
  }
  // Priority 2: local file path (dev)
  if (process.env.YTDLP_COOKIES_FILE && fs.existsSync(process.env.YTDLP_COOKIES_FILE)) {
    return process.env.YTDLP_COOKIES_FILE;
  }
  return undefined;
}

async function downloadYouTubeVideo(url: string, outputPath: string): Promise<void> {
  const outputTemplate = outputPath.replace(/\.[^.]+$/, ".%(ext)s");
  const cookiesPath = resolveCookiesPath();
  const ytdlp = createYoutubeDl(await resolveYtDlpPath());

  await ytdlp(url, {
    output: outputTemplate,
    format: "best[ext=mp4]/best",
    noPlaylist: true,
    ...(process.env.YTDLP_COOKIES_BROWSER
      ? { cookiesFromBrowser: process.env.YTDLP_COOKIES_BROWSER }
      : {}),
    ...(cookiesPath ? { cookies: cookiesPath } : {}),
  });

  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, path.extname(outputPath));
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(base));

  if (files.length === 0) throw new Error("yt-dlp did not produce any output file");

  const actualPath = path.join(dir, files[0]);
  if (actualPath !== outputPath) {
    fs.renameSync(actualPath, outputPath);
  }
}

async function extractAudio(videoPath: string, audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .output(audioPath)
      .audioCodec("libmp3lame")
      .audioBitrate("32k")   // low bitrate to stay under Groq's 25MB limit
      .audioChannels(1)       // mono
      .audioFrequency(16000)  // 16kHz is enough for speech recognition
      .noVideo()
      .on("end", () => resolve())
      .on("error", reject)
      .run();
  });
}

async function transcribeAudio(audioPath: string): Promise<TranscriptSegment[]> {
  const audioFile = fs.createReadStream(audioPath);
  const response = await groq.audio.transcriptions.create({
    model: "whisper-large-v3-turbo",
    file: audioFile,
    response_format: "verbose_json",
  });

  const result = response as unknown as { segments?: TranscriptSegment[] };
  return result.segments || [];
}

const MIN_CLIP_DURATION = 30;
const MAX_CLIP_DURATION = 90;

async function selectHighlights(
  segments: TranscriptSegment[],
  videoDuration: number
): Promise<Array<{ start: number; end: number; title: string }>> {
  const transcript = segments
    .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}`)
    .join("\n");

  const response = await openai.chat.completions.create({
    model: "openai/gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are a video editor expert. Select engaging highlight clips from transcripts for short-form social media. Return JSON only.",
      },
      {
        role: "user",
        content: `Video transcript (total duration: ${videoDuration}s):\n\n${transcript}\n\n` +
          `Select 3-5 highlight clips. IMPORTANT RULES:\n` +
          `- Each clip MUST be between ${MIN_CLIP_DURATION} and ${MAX_CLIP_DURATION} seconds long (end - start >= ${MIN_CLIP_DURATION})\n` +
          `- Pick a start time, then set end = start + 45 to 90 seconds\n` +
          `- Choose moments with engaging speech, insights, or interesting stories\n` +
          `- Clips should not overlap\n\n` +
          `Respond with this exact JSON: {"clips": [{"start": number, "end": number, "title": "short title"}]}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content || "{}";
  const parsed = JSON.parse(content);
  const raw: Array<{ start: number; end: number; title: string }> =
    parsed.clips || parsed.highlights || [];

  // Enforce minimum duration regardless of what AI returned
  return raw.map((clip) => {
    const duration = clip.end - clip.start;
    if (duration < MIN_CLIP_DURATION) {
      return {
        ...clip,
        end: Math.min(clip.start + MIN_CLIP_DURATION, videoDuration),
      };
    }
    if (duration > MAX_CLIP_DURATION) {
      return { ...clip, end: clip.start + MAX_CLIP_DURATION };
    }
    return clip;
  });
}

async function renderClipWithSubtitles(
  videoPath: string,
  outputPath: string,
  startTime: number,
  endTime: number,
  segments: TranscriptSegment[]
): Promise<void> {
  const clipSegments = segments.filter(
    (s) => s.start >= startTime && s.end <= endTime
  );

  // Font path: Mac local, fallback to Linux (Vercel/Railway)
  const fontPath = fs.existsSync("/System/Library/Fonts/Supplemental/Arial.ttf")
    ? "/System/Library/Fonts/Supplemental/Arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

  const hasFontFile = fs.existsSync(fontPath);

  // Build drawtext filter — commas inside between() must be escaped as \, for ffmpeg
  const drawtextFilters = clipSegments.map((seg) => {
    const relStart = seg.start - startTime;
    const relEnd = seg.end - startTime;
    const text = seg.text.trim()
      .replace(/\\/g, "\\\\")
      .replace(/’/g, "’")  // replace smart quote to avoid quoting issues
      .replace(/:/g, "\\:")
      .replace(/,/g, "\\,")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
    const fontArg = hasFontFile ? `fontfile=${fontPath}:` : "";
    // Use \, to escape commas inside between() so ffmpeg doesn’t split at them
    return (
      `drawtext=${fontArg}text=’${text}’:` +
      `fontsize=22:fontcolor=white:borderw=2:bordercolor=black:` +
      `x=(w-text_w)/2:y=h-th-50:` +
      `enable=between(t\\,${relStart.toFixed(3)}\\,${relEnd.toFixed(3)})`
    );
  });

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(videoPath)
      .seekInput(startTime)
      .duration(endTime - startTime)
      .output(outputPath);

    if (drawtextFilters.length > 0) {
      // Pass as single string via outputOptions to prevent fluent-ffmpeg comma splitting
      cmd.outputOptions(["-vf", drawtextFilters.join(",")]);
    }

    cmd
      .on("end", () => resolve())
      .on("error", (err, _stdout, stderr) => {
        reject(new Error(`ffmpeg error: ${err.message} | stderr: ${stderr}`));
      })
      .run();
  });
}

export const processVideoJob = inngest.createFunction(
  {
    id: "process-video-job",
    retries: 1,
    triggers: [{ event: "video/process" }],
    // Allow up to 15 minutes for the full processing pipeline
    timeouts: { finish: "15m" },
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async ({ event, step }: any) => {
    const { jobId, youtubeUrl } = event.data;
    const tmpDir = os.tmpdir();
    const videoPath = path.join(tmpDir, `${jobId}.mp4`);
    const audioPath = path.join(tmpDir, `${jobId}.mp3`);

    try {
      // All file operations in ONE step to avoid /tmp isolation across serverless instances
      const { segments, highlights } = await step.run("process-video", async () => {
        await updateJobStatus(jobId, "downloading", 10);
        await downloadYouTubeVideo(youtubeUrl, videoPath);

        await updateJobStatus(jobId, "transcribing", 30);
        await extractAudio(videoPath, audioPath);
        const segs = await transcribeAudio(audioPath);

        await updateJobStatus(jobId, "analyzing", 50);
        const ytdlp = createYoutubeDl(await resolveYtDlpPath());
        const info = await ytdlp(youtubeUrl, {
          dumpSingleJson: true,
          noWarnings: true,
        }) as { duration: number };
        const duration = info.duration ?? 600;
        const hl = await selectHighlights(segs, duration);

        return { segments: segs, highlights: hl };
      });

      await step.run("render-and-upload", async () => {
        await updateJobStatus(jobId, "rendering", 70);

        for (let i = 0; i < highlights.length; i++) {
          const highlight = highlights[i];
          const clipPath = path.join(tmpDir, `${jobId}_clip_${i}.mp4`);

          await renderClipWithSubtitles(
            videoPath,
            clipPath,
            highlight.start,
            highlight.end,
            segments
          );

          await updateJobStatus(jobId, "uploading", 70 + (i / highlights.length) * 25);

          const uploadResult = await uploadVideo(clipPath, `${jobId}_clip_${i}`);

          await supabaseAdmin.from("clips").insert({
            job_id: jobId,
            title: highlight.title,
            start_time: highlight.start,
            end_time: highlight.end,
            cloudinary_url: uploadResult.secure_url,
            cloudinary_public_id: uploadResult.public_id,
          });

          fs.unlinkSync(clipPath);
        }
      });

      await updateJobStatus(jobId, "completed", 100);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      await updateJobStatus(jobId, "failed", 0, msg);
      throw error;
    } finally {
      [videoPath, audioPath].forEach((f) => {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      });
    }
  }
);
