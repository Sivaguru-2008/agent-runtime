-- 0030_signups_attribution_columns.sql
-- Robust source attribution + UTM capture on the durable signup record.
--
-- Why this exists:
--   v0 stored a single optional free-text `source`. Typos ("twiter"), casing
--   ("Docs" vs "docs") and missing values fragment every by-source number, and
--   `coalesce(source,'direct')` was the only normalization. Real acquisition
--   also uses utm_source/medium/campaign/term/content — there was nowhere to
--   put them, so a `?utm_campaign=launch` link was invisible. UTM data is
--   PERISHABLE: if not captured at signup it is lost forever, so we add the
--   columns now even though full campaign reporting lands later.
--
-- What changes:
--   • `source_norm` — the server-normalized attribution slug (lowercased,
--     trimmed, slugified, aliased). The funnel groups by THIS, not raw source,
--     so "Twitter" / "twitter " / "TWITTER" collapse to one bucket. Raw `source`
--     is kept verbatim for audit.
--   • utm_* / referrer / landing_path — first-touch attribution, nullable.
--
-- Backward compatibility:
--   All columns are nullable / additive (add column if not exists). The
--   backfill below populates source_norm from existing source so historical
--   rows group consistently; rows with no source map to 'direct' at read time
--   via coalesce, exactly as before.

alter table signups add column if not exists source_norm  text null;
alter table signups add column if not exists utm_source   text null;
alter table signups add column if not exists utm_medium   text null;
alter table signups add column if not exists utm_campaign text null;
alter table signups add column if not exists utm_term     text null;
alter table signups add column if not exists utm_content  text null;
alter table signups add column if not exists referrer     text null;
alter table signups add column if not exists landing_path text null;

-- Backfill source_norm from the existing free-text source. This mirrors the
-- formatting half of normalizeSource() (lowercase + trim + slugify); the alias
-- map lives in application code and only affects NEW writes. Empty/whitespace
-- sources are left NULL so the read-side coalesce(..., 'direct') still applies.
update signups
   set source_norm = nullif(
         regexp_replace(
           regexp_replace(lower(btrim(source)), '[^a-z0-9]+', '-', 'g'),
           '(^-+|-+$)', '', 'g'
         ),
         ''
       )
 where source is not null
   and source_norm is null;

-- Group-by support for the point-in-time funnel now that it keys on source_norm.
create index if not exists idx_signups_source_norm on signups (source_norm);
