# Cloud sync setup (one-time)

Claude Pulse works fully offline with no cloud setup. This is only needed if you want your
session activity visible from another device.

**Already done for this project** (`claudepulse`, ref `udiloonuymsihqrjuwjj`):
- `supabase/migrations` applied (`public.pulse_sessions`, `pulse_day_stats`, `pulse_decisions`,
  `pulse_events` — RLS on, zero policies, so only the service role the Edge Function holds can
  touch them).
- `supabase/functions/pulse-api` deployed with `--no-verify-jwt` (it does its own auth via the
  `PULSE_TOKEN` secret, not Supabase's built-in JWT check).
- `PULSE_TOKEN` secret set.
- `pulse-cloud.json` written on this machine (gitignored) — that's what turns cloud sync on for
  `server.js`. Delete it to go back to local-only.

## Redeploying after an edit to the Edge Function

```bash
export SUPABASE_ACCESS_TOKEN=<a personal access token — dashboard/account/tokens>
npx supabase link --project-ref udiloonuymsihqrjuwjj
npx supabase db push                              # only if you changed supabase/migrations
npx supabase functions deploy pulse-api --no-verify-jwt
```

## Setting up a second device

1. On that device, open `cloud.html` from wherever you've hosted this repo's static files
   (e.g. a Vercel static deploy, or just `file://` the folder for a quick check).
2. Paste the Supabase project URL (`https://udiloonuymsihqrjuwjj.supabase.co`) and the
   `pulseToken` value from this machine's `pulse-cloud.json`.
3. It polls the Edge Function directly — no local server needed on that device.

Treat the token like a password: anyone who has it can read your session activity (titles,
prompts, replies, file names). Rotate it by generating a new one and re-running
`supabase secrets set PULSE_TOKEN=<new>`, then updating `pulse-cloud.json` and every device's
saved token.

## Why `public.pulse_*` instead of a `pulse` schema

PostgREST (what `supabase-js` talks to from the Edge Function) only serves the `public` schema
by default. A separate schema needs it added to the project's "Exposed schemas" setting; using
`public` with a `pulse_` prefix skips that step. Security is unaffected — RLS is still enabled
with no policies, so `anon`/`authenticated` get nothing regardless of schema.
