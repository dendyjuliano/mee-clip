import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { createClient } from "@/lib/supabase-server";
import { inngest } from "@/inngest/client";
import { v4 as uuidv4 } from "uuid";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { youtubeUrl } = await req.json();

  if (!youtubeUrl || (!youtubeUrl.includes("youtube.com") && !youtubeUrl.includes("youtu.be"))) {
    return NextResponse.json({ error: "Invalid YouTube URL" }, { status: 400 });
  }

  const jobId = uuidv4();

  const { error } = await supabaseAdmin.from("clip_jobs").insert({
    id: jobId,
    user_id: user.id,
    youtube_url: youtubeUrl,
    status: "pending",
    progress: 0,
  });

  if (error) {
    return NextResponse.json({ error: "Failed to create job" }, { status: 500 });
  }

  await inngest.send({
    name: "video/process",
    data: { jobId, youtubeUrl },
  });

  return NextResponse.json({ jobId });
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("id");

  if (jobId) {
    const { data: job, error } = await supabaseAdmin
      .from("clip_jobs")
      .select("*, clips(*)")
      .eq("id", jobId)
      .eq("user_id", user.id)
      .single();

    if (error || !job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    return NextResponse.json(job);
  }

  // Return all jobs for the user (history)
  const { data: jobs, error } = await supabaseAdmin
    .from("clip_jobs")
    .select("*, clips(*)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch jobs" }, { status: 500 });
  }

  return NextResponse.json(jobs);
}
