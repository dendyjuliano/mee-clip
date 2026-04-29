-- clip_jobs table
create table clip_jobs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  youtube_url text not null,
  status text not null default 'pending',
  progress integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- clips table
create table clips (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references clip_jobs(id) on delete cascade,
  title text,
  start_time numeric not null,
  end_time numeric not null,
  cloudinary_url text,
  cloudinary_public_id text,
  created_at timestamptz not null default now()
);

create index on clips(job_id);
create index on clip_jobs(user_id);

-- Row Level Security
alter table clip_jobs enable row level security;
alter table clips enable row level security;

create policy "Users can view own jobs"
  on clip_jobs for select
  using (auth.uid() = user_id);

create policy "Users can insert own jobs"
  on clip_jobs for insert
  with check (auth.uid() = user_id);

create policy "Service role can do everything on jobs"
  on clip_jobs for all
  using (true)
  with check (true);

create policy "Users can view clips from own jobs"
  on clips for select
  using (
    exists (
      select 1 from clip_jobs
      where clip_jobs.id = clips.job_id
      and clip_jobs.user_id = auth.uid()
    )
  );

create policy "Service role can do everything on clips"
  on clips for all
  using (true)
  with check (true);
