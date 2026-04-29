export type JobStatus =
  | "pending"
  | "downloading"
  | "transcribing"
  | "analyzing"
  | "rendering"
  | "uploading"
  | "completed"
  | "failed";

export interface ClipJob {
  id: string;
  youtube_url: string;
  status: JobStatus;
  progress: number;
  error_message?: string;
  created_at: string;
  updated_at: string;
  clips?: Clip[];
}

export interface Clip {
  id: string;
  job_id: string;
  title: string;
  start_time: number;
  end_time: number;
  cloudinary_url?: string;
  cloudinary_public_id?: string;
  created_at: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}
