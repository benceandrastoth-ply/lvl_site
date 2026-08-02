-- ============================================================
-- Leaderboard database schema (Postgres / Supabase)
--
-- Rating model:
--   A submission requires a thumbnail image AND a showcase video
--   (both re-hosted in Supabase Storage by the bot, since Discord's
--   own attachment CDN links expire after ~24h).
--
--   People vote 1-10 by reacting with number emojis on the bot's
--   message. Each vote is tagged is_judge (true = Mod/Judge role).
--
--     - Layout / Deco / Hardest tabs rank by the AVERAGE of judge
--       votes only. Non-judge votes are ignored for these tabs.
--     - Community tab ranks ALL submissions by the AVERAGE of
--       non-judge votes only. Judge votes are ignored for this tab.
--
-- One vote per person per submission — voting again overwrites the
-- previous vote rather than adding a second one.
-- ============================================================

create extension if not exists "uuid-ossp";

create table if not exists submissions (
  id                       uuid primary key default uuid_generate_v4(),
  gd_level_id              bigint not null,                 -- in-game level ID
  level_name               text not null,
  creator                  text not null,
  category                 text not null check (category in ('layout', 'deco', 'hardest')),

  -- optional flavor tag shown alongside the score on the Hardest tab
  -- e.g. "Extreme Demon" — informational only, not used for ranking
  difficulty_tier          text,

  -- permanent Supabase Storage URLs (NOT the raw Discord CDN attachment
  -- URL — those expire after ~24h). Both required at submission time.
  thumbnail_url            text not null,
  video_url                text not null,

  submitted_by_discord_id   text not null,
  submitted_by_username     text not null,

  -- the bot's own message ID (not the interaction ID) — this is the
  -- message people react to with number emojis to cast votes
  discord_message_id       text unique,

  created_at                timestamptz not null default now()
);

create index if not exists idx_submissions_category
  on submissions (category);

create index if not exists idx_submissions_created_at
  on submissions (created_at desc);

-- One row per person's current vote on a submission.
create table if not exists ratings (
  submission_id      uuid not null references submissions(id) on delete cascade,
  rater_discord_id    text not null,
  rater_username       text not null,
  score               smallint not null check (score between 1 and 10),

  -- true = rater held the Mod or Judge role at the time of voting.
  -- Determines which leaderboard(s) this vote counts toward.
  is_judge            boolean not null default false,

  created_at           timestamptz not null default now(),

  primary key (submission_id, rater_discord_id)
);

create index if not exists idx_ratings_submission on ratings (submission_id);

-- Read-optimized view combining a submission with both of its aggregate
-- scores. The frontend/API reads exclusively from this view.
create or replace view submission_scores as
select
  s.*,
  (select round(avg(r.score)::numeric, 1) from ratings r
     where r.submission_id = s.id and r.is_judge = true)  as judge_rating,
  (select count(*) from ratings r
     where r.submission_id = s.id and r.is_judge = true)  as judge_votes,
  (select round(avg(r.score)::numeric, 1) from ratings r
     where r.submission_id = s.id and r.is_judge = false) as community_rating,
  (select count(*) from ratings r
     where r.submission_id = s.id and r.is_judge = false) as community_votes
from submissions s;

-- Upsert helper the API calls when a reaction vote comes in.
-- Overwrites the rater's previous vote on this submission, if any.
create or replace function cast_vote(
  p_submission_id uuid,
  p_rater_discord_id text,
  p_rater_username text,
  p_score smallint,
  p_is_judge boolean
) returns void as $$
  insert into ratings (submission_id, rater_discord_id, rater_username, score, is_judge, created_at)
  values (p_submission_id, p_rater_discord_id, p_rater_username, p_score, p_is_judge, now())
  on conflict (submission_id, rater_discord_id)
  do update set
    score = excluded.score,
    is_judge = excluded.is_judge,
    rater_username = excluded.rater_username,
    created_at = now();
$$ language sql;

-- Lightweight submitter roll-up, updated by the API on each new submission.
-- Powers "Server Stats" -> top submitters.
create table if not exists raters (
  discord_id         text primary key,
  username             text not null,
  levels_submitted     int not null default 0,
  last_active           timestamptz not null default now()
);

create or replace function increment_rater(p_discord_id text, p_username text)
returns void as $$
  insert into raters (discord_id, username, levels_submitted, last_active)
  values (p_discord_id, p_username, 1, now())
  on conflict (discord_id)
  do update set
    levels_submitted = raters.levels_submitted + 1,
    username = excluded.username,
    last_active = now();
$$ language sql;

-- ============================================================
-- Row Level Security (Supabase)
-- Public/anon key: read-only. All writes go through the backend
-- API using the secret key, never exposed to the browser.
-- ============================================================
alter table submissions enable row level security;
alter table ratings enable row level security;
alter table raters enable row level security;

create policy "Public read access on submissions"
  on submissions for select
  using (true);

create policy "Public read access on ratings"
  on ratings for select
  using (true);

create policy "Public read access on raters"
  on raters for select
  using (true);

-- No insert/update/delete policies for the anon role are created on
-- purpose — all writes must use the secret key from server.js.

-- ============================================================
-- Storage bucket setup (run once, manually, in Supabase):
--   Dashboard -> Storage -> New bucket -> name it "media" -> Public bucket: ON
-- The bot uploads thumbnails/videos here and stores the permanent
-- public URL in submissions.thumbnail_url / submissions.video_url.
-- ============================================================
