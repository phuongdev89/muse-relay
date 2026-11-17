# Muse Relay — share package for friends (v4)

Each person uses their OWN Supabase project. The Muse logs in with its OWN
email/password — Supabase RLS locks it to exactly one project, so it can
never read another Muse's data.

## What you need to prepare (3 things, none of them secret)

1. Supabase Project ID — `YOUR-PROJECT-REF` (the part before `.supabase.co`)
2. Publishable Key — Supabase Dashboard → Settings → API (`sb_publishable_…`)
3. Muse Email + Password — created for you by the Muse Relay web UI wizard
   (⚙ → Token shows them again anytime)

## How to deploy with your Muse

1. Unzip this package and give it to your Muse.
2. Tell your Muse: "deploy Muse Relay for me" — and give it the instruction
   the web UI wizard generates (Project ID, Publishable Key, Muse Email).
3. Muse writes `config.json` itself and tests the login.
4. Muse shows a secure form named "Muse Relay password" — enter the
   Password there. Muse cannot see the value, and it is never written to disk.
5. Muse runs the indefinite poll daemon (~3s per round) and sets up its
   3-minute schedule + 10-second wake hook for you.

## Notes

- NEVER send the relay password in chat; enter it only in the secure form.
- Your Secret Key / PAT never belong in this package — the Muse only needs
  the PUBLIC publishable key plus its own login.
- Assets (images/videos/files) in replies go only as Dropbox links, never
  through Supabase. In normal chat in the Muse app, files are sent directly.
- This package contains NO secret, NO messages, and NO logs from the owner.
