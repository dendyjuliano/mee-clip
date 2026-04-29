"use client";

import { useState, useEffect, useCallback } from "react";
import { createBrowserClient } from "@supabase/ssr";
import { useRouter } from "next/navigation";
import type { ClipJob } from "@/types";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

const STATUS_LABELS: Record<string, string> = {
  pending: "Waiting in queue...",
  downloading: "Downloading video...",
  transcribing: "Transcribing audio...",
  analyzing: "AI selecting highlights...",
  rendering: "Rendering clips with subtitles...",
  uploading: "Uploading to cloud...",
  completed: "Done!",
  failed: "Failed",
};

export default function Home() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<ClipJob | null>(null);
  const [history, setHistory] = useState<ClipJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [userEmail, setUserEmail] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) setUserEmail(user.email ?? "");
    });
    fetchHistory();
  }, []);

  async function fetchHistory() {
    const res = await fetch("/api/jobs");
    if (res.ok) {
      const data = await res.json();
      setHistory(data);
    }
  }

  const pollJob = useCallback(async (id: string) => {
    const res = await fetch(`/api/jobs?id=${id}`);
    if (!res.ok) return;
    const data: ClipJob = await res.json();
    setActiveJob(data);
    if (data.status === "completed") {
      fetchHistory();
    }
    return data;
  }, []);

  useEffect(() => {
    if (!activeJobId) return;
    if (activeJob?.status === "completed" || activeJob?.status === "failed") return;

    const interval = setInterval(async () => {
      const data = await pollJob(activeJobId);
      if (data?.status === "completed" || data?.status === "failed") {
        clearInterval(interval);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [activeJobId, activeJob?.status, pollJob]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    setActiveJob(null);

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl: url }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Something went wrong");
        return;
      }

      setActiveJobId(data.jobId);
      pollJob(data.jobId);
      setUrl("");
    } catch {
      setError("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/auth/login");
  }

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-12">
          <h1 className="text-2xl font-bold bg-linear-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
            MeeClip
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-gray-400 text-sm hidden sm:block">{userEmail}</span>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 px-3 py-1.5 rounded-lg transition"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Input */}
        <div className="mb-10">
          <p className="text-gray-400 mb-4">Paste a YouTube link. AI will auto-cut highlights with subtitles.</p>
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              required
              className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 transition"
            />
            <button
              type="submit"
              disabled={loading}
              className="bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed px-6 py-3 rounded-xl font-semibold transition shrink-0"
            >
              {loading ? "Submitting..." : "Generate"}
            </button>
          </form>

          {error && (
            <div className="bg-red-900/40 border border-red-700 text-red-300 rounded-xl px-4 py-3 mt-3 text-sm">
              {error}
            </div>
          )}
        </div>

        {/* Active job progress */}
        {activeJob && activeJob.status !== "completed" && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5 mb-8">
            <p className="text-sm font-medium text-gray-300 mb-3">Processing...</p>
            <div className="flex justify-between text-sm text-gray-400 mb-2">
              <span>{STATUS_LABELS[activeJob.status] || activeJob.status}</span>
              <span>{activeJob.progress}%</span>
            </div>
            <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-linear-to-r from-purple-500 to-pink-500 transition-all duration-500"
                style={{ width: `${activeJob.progress}%` }}
              />
            </div>
            {activeJob.status === "failed" && (
              <p className="text-red-400 text-sm mt-2">{activeJob.error_message}</p>
            )}
          </div>
        )}

        {/* History */}
        <div>
          <h2 className="text-lg font-semibold mb-4 text-gray-200">Your History</h2>

          {history.length === 0 ? (
            <div className="text-center py-12 text-gray-600">
              No clips generated yet. Paste a YouTube link above to get started.
            </div>
          ) : (
            <div className="space-y-4">
              {history.map((job) => (
                <div key={job.id} className="bg-gray-800/50 border border-gray-700 rounded-2xl p-5">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <a
                      href={job.youtube_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-purple-400 hover:text-purple-300 truncate"
                    >
                      {job.youtube_url}
                    </a>
                    <span className={`text-xs px-2 py-1 rounded-full shrink-0 ${
                      job.status === "completed" ? "bg-green-900/50 text-green-400" :
                      job.status === "failed" ? "bg-red-900/50 text-red-400" :
                      "bg-yellow-900/50 text-yellow-400"
                    }`}>
                      {job.status}
                    </span>
                  </div>

                  {job.status !== "completed" && job.status !== "failed" && (
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-linear-to-r from-purple-500 to-pink-500"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  )}

                  {job.clips && job.clips.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {job.clips.map((clip, i) => (
                        <div key={clip.id} className="flex items-center justify-between bg-gray-700/40 rounded-xl px-4 py-2.5">
                          <div>
                            <p className="text-sm font-medium">{clip.title || `Clip ${i + 1}`}</p>
                            <p className="text-xs text-gray-400">
                              {Math.floor(clip.start_time)}s — {Math.floor(clip.end_time)}s
                            </p>
                          </div>
                          {clip.cloudinary_url && (
                            <a
                              href={clip.cloudinary_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs bg-purple-600 hover:bg-purple-700 px-3 py-1.5 rounded-lg transition"
                            >
                              Download
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="text-xs text-gray-600 mt-3">
                    {new Date(job.created_at).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
