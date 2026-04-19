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
