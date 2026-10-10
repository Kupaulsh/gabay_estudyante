# Gabay Estudyante

A calendar / schedule / subjects / activities / reviewers site for PCCM and TUP, backed by Supabase. Content is shared across every visitor and device; only admins (Google accounts on an allowlist) can edit it.

## File structure
```
index.html          — page shell
style.css            — all styling
supabase-client.js   — your Supabase project keys go here
vendor-supabase.js   — local copy of the Supabase library (so the app loads offline)
sw.js                — keeps the web version available offline
build.js             — copies the web files into www/ for the Android app
data.js              — all reads/writes to Supabase
app.js               — public-facing pages (calendar, subjects, reviewers, etc.)
admin.js             — Google sign-in + admin CRUD panel
schema.sql           — run once in Supabase to create everything
pccm-logo.png / tup-logo.png — add these yourself (see below)
```

## 1. Create a Supabase project
1. Go to [supabase.com](https://supabase.com) → New project.
2. Wait for it to finish provisioning (~2 min).

## 2. Run the schema
1. In your project, open **SQL Editor → New query**.
2. Open `schema.sql` from this repo, paste the whole thing in.
3. **Before running**, find this line near the bottom and replace the email with your real Google account email:
   ```sql
   insert into admins (email) values ('YOUR_EMAIL@gmail.com')
   ```
4. Click **Run**. You should see "Success. No rows returned."

You can add more admins later any time by running:
```sql
insert into admins (email) values ('someone-else@gmail.com');
```

> **Already ran an older `schema.sql`?** Also run `migration_item_types.sql` once (SQL Editor → New query → paste → Run). It adds the table that stores custom calendar/activity types and their colors. Without it the app still works, you just can't add custom types.
>
> Also run `migration_semesters.sql` once. It adds semesters (all your existing data becomes **Semester 1**) and lets admins add new schools from the app. Without it everything else still works, but the semester and add-school features in **Account** won't.

## 3. Enable Google sign-in
This needs a Google OAuth client — Supabase can't create one for you, but it's a short one-time setup:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create (or pick) a project.
2. **APIs & Services → OAuth consent screen** → set it up as **External**, fill in the app name/email, save.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: copy this from Supabase — go to your Supabase project → **Authentication → Providers → Google**, it shows a callback URL like:
     `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
   - Paste that into Google's "Authorized redirect URIs", save.
4. Copy the generated **Client ID** and **Client Secret** from Google.
5. Back in Supabase: **Authentication → Providers → Google** → paste the Client ID and Client Secret → toggle it **on** → Save.
6. Still in Supabase: **Authentication → URL Configuration** → set **Site URL** to wherever you'll host this (e.g. your GitHub Pages URL) and add it under **Redirect URLs** too.

## 4. Connect the app to your project
1. In Supabase: **Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `supabase-client.js` in this repo and paste them in:
   ```js
   var SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   var SUPABASE_ANON_KEY = 'eyJhbGciOi...';
   ```

## 5. Add your logos (optional)
Drop `pccm-logo.png` and `tup-logo.png` (or `.jpg`) in the same folder as `index.html`. If they're missing, the landing page falls back to plain letter badges — nothing breaks either way.

## 6. Host it
Push this whole folder to a GitHub repo, then:
- **Settings → Pages → Deploy from branch** → pick `main` / root.
- Your site will be live at `https://yourusername.github.io/reponame/`.
- Go back to Supabase → **Authentication → URL Configuration** and make sure that exact URL is set as the Site URL / in Redirect URLs, or Google sign-in will bounce back with an error.

## Using it
- Anyone can view the site — no login needed to browse.
- To edit, tap **Sign in** (landing page, or the pencil) and sign in with Google **once** — the app remembers you afterwards.
- The **pencil button** next to the gear turns editing on (green) and off (red). You stay signed in; there is no need to log out to stop editing.
- Gear menu → **Account**: switch school, add a school, switch semester, add a semester, and sign out.
- Only Google accounts listed in the `admins` table can actually save changes (everyone else can sign in but will see "not on the admin list").
- Files aren't uploaded to Supabase — for syllabi/materials/PDFs, upload to Google Drive, share the link, and paste that link into the edit form.

## Offline use
The app keeps a copy of each school's data on the device, so it opens and works without internet (open each school once while online first). Changes made offline are saved on the device and sent automatically when the connection returns. The dot at the top shows the state: **green** online, **yellow** saving, **red** offline.

## Build the Android app
Run these in the project folder (the one with `package.json`):
```bash
npm install          # first time only
npx cap add android  # first time only
npm run sync         # copies the web files into www/ and syncs them into the Android project
npm run open         # opens Android Studio → Build → Build APK(s)
```
