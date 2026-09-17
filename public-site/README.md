# public-site/

This folder is the entire cross-device Claude Pulse viewer: `index.html` (same content as
`cloud.html` served locally at `http://localhost:4319/cloud.html`) + `pulse.css`. It's isolated
in its own folder so Vercel's static-site detection never trips over `server.js` at the repo
root (see `.vercelignore` and the note in the main README/commit history for why that mattered).

It's deployed as its own Vercel project (`claude-pulse-web`), rooted at this directory, with
auto-deploy on every push to `main`. No build step — plain static HTML/CSS/JS, talks directly to
the Supabase `pulse-api` Edge Function.

Keep this folder and the local server's copies in sync — `server.js` serves
`http://localhost:4319/cloud.html` and `/pulse.css` directly from these same two files.
