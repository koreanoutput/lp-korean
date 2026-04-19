create table if not exists public.trial_user_progress (
  user_id text primary key,
  started_at timestamptz not null,
  completed_days jsonb not null default '[]'::jsonb,
  selected_day_index integer null,
  delivered_days jsonb not null default '[0]'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.set_trial_user_progress_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_trial_user_progress_updated_at on public.trial_user_progress;
create trigger trg_trial_user_progress_updated_at
before update on public.trial_user_progress
for each row
execute function public.set_trial_user_progress_updated_at();

create table if not exists public.trial_feedback_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  day_index integer not null,
  lesson_day integer not null,
  source_message_id text null,
  recognized_text text null,
  score integer not null default 0,
  pronunciation text not null,
  intonation text not null,
  fix text not null,
  model text not null,
  feedback_text text not null,
  followup_text text null,
  status text not null default 'pending',
  reviewer_note text null,
  approved_at timestamptz null,
  rejected_at timestamptz null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trial_feedback_reviews_status_check
    check (status in ('pending', 'approved', 'rejected', 'sent'))
);

create index if not exists idx_trial_feedback_reviews_status_created_at
  on public.trial_feedback_reviews (status, created_at desc);

create index if not exists idx_trial_feedback_reviews_user_day
  on public.trial_feedback_reviews (user_id, day_index, created_at desc);

drop trigger if exists trg_trial_feedback_reviews_updated_at on public.trial_feedback_reviews;
create trigger trg_trial_feedback_reviews_updated_at
before update on public.trial_feedback_reviews
for each row
execute function public.set_trial_user_progress_updated_at();
