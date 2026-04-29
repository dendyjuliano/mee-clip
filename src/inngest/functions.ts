import { inngest } from "./client";
import { supabaseAdmin } from "@/lib/supabase";
import { uploadVideo } from "@/lib/cloudinary";
import { create as createYoutubeDl } from "youtube-dl-exec";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import OpenAI from "openai";
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import os from "os";
import type { TranscriptSegment } from "@/types";

// Use system yt-dlp (local Mac) or the bundled binary (Vercel/Linux)
const ytdlpPath = process.env.YTDLP_PATH || undefined;
const youtubeDl = ytdlpPath ? createYoutubeDl(ytdlpPath) : createYoutubeDl("yt-dlp");

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

async function downloadYouTubeVideo(url: string, outputPath: string): Promise<void> {
  const outputTemplate = outputPath.replace(/\.[^.]+$/, ".%(ext)s");

  await youtubeDl(url, {
    output: outputTemplate,
    format: "best[ext=mp4]/best",
    noPlaylist: true,
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
        content:
          "You are a video editor expert. Analyze transcripts and select the most engaging, shareable moments for short-form video clips (30-90 seconds each). Return JSON only.",
      },
      {
        role: "user",
        content: `Video transcript (total duration: ${videoDuration}s):\n\n${transcript}\n\nSelect 3-5 best highlight clips. Each clip should be 30-90 seconds and contain a complete, engaging thought or moment.\n\nRespond with JSON array: [{"start": number, "end": number, "title": "short descriptive title"}]`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const content = response.choices[0].message.content || "{}";
  const parsed = JSON.parse(content);
  return parsed.clips || parsed.highlights || [];
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

  const srtPath = outputPath.replace(".mp4", ".srt");
  let srtContent = "";
  clipSegments.forEach((seg, i) => {
    const toSRT = (t: number) => {
      const h = Math.floor(t / 3600);
      const m = Math.floor((t % 3600) / 60);
      const s = Math.floor(t % 60);
      const ms = Math.floor((t % 1) * 1000);
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    };
    srtContent += `${i + 1}\n${toSRT(seg.start - startTime)} --> ${toSRT(seg.end - startTime)}\n${seg.text.trim()}\n\n`;
  });

  fs.writeFileSync(srtPath, srtContent);

  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(startTime)
      .duration(endTime - startTime)
      .videoFilters(`subtitles=${srtPath}:force_style='FontSize=18,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2'`)
      .output(outputPath)
      .on("end", () => {
        fs.unlinkSync(srtPath);
        resolve();
      })
      .on("error", reject)
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
        const info = await youtubeDl(youtubeUrl, {
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
