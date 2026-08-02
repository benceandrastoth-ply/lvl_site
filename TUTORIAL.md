# LVL BOARD — Setup Tutorial (from scratch)

You now only need to keep track of 5 files:

```
lvl-board/
├── app.js          <- runs the Discord bot AND the website/API together
├── site.html       <- the website itself (edit this for branding/text)
├── package.json    <- tells npm what to install
├── .env            <- your secrets (you'll create this from .env.example)
└── schema.sql      <- paste into Supabase once, then you never touch it again
```

One thing to understand up front: **`app.js` is the whole backend.** When you run it, it starts your Discord bot AND serves the website AND handles the API, all in one process, in one terminal window. You don't run two things anymore.

---

## 1. Install Node.js

Go to [nodejs.org](https://nodejs.org), download the **LTS** version, install it.

Check it worked — open Command Prompt and run:
```
node --version
```
You should see a version number like `v22.x.x`.

---

## 2. Create your project folder

Make a folder anywhere, e.g. on your Desktop:
```
mkdir C:\Users\User\Desktop\lvl-board
cd C:\Users\User\Desktop\lvl-board
```
Put `app.js`, `site.html`, `package.json`, and `schema.sql` (all provided) into this folder.

---

## 3. Set up Supabase (your database)

1. Go to [supabase.com](https://supabase.com), sign up, click **New project**.
2. Once it's created, go to **SQL Editor** (left sidebar) → **New query**.
3. Open `schema.sql`, copy everything, paste it in, click **Run**.
   This creates all your tables in one go — you never need to touch this file again.
4. Go to **Storage** (left sidebar) → **New bucket** → name it exactly `media` → toggle **Public bucket: ON** → **Create bucket**.
   This is where thumbnails and videos get stored permanently.
5. Go to **Settings → General**. Copy the **Project ID**, e.g. `abcxyz123`. Your Supabase URL is:
   ```
   https://abcxyz123.supabase.co
   ```
6. Go to **Settings → API Keys**. Find the **Secret key** (starts with `sb_secret_...`). Copy it.
   **Never paste this anywhere public — not in Discord, not in a chat, not on GitHub.**

---

## 4. Create your Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → name it.
2. Go to **Bot** (left sidebar):
   - Click **Reset Token** → copy the token (this is `DISCORD_TOKEN`) — treat it like a password.
   - Scroll to **Privileged Gateway Intents** → turn ON **Server Members Intent** → **Save Changes**.
3. Go to **OAuth2 → URL Generator**:
   - Under **Scopes**, check `bot` and `applications.commands`.
   - Under **Bot Permissions**, check: `Send Messages`, `Manage Messages`, `Add Reactions`, `Read Message History`, `Attach Files`, `Embed Links`.
   - Copy the generated URL at the bottom, open it in your browser, and add the bot to your server.
4. Back on the **General Information** page, copy the **Application ID** (this is `CLIENT_ID`).
5. In Discord, turn on **Developer Mode** (User Settings → Advanced), then right-click your server icon → **Copy Server ID** (this is `GUILD_ID`).
6. Right-click your Mod role → **Copy Role ID** (this is `MOD_ROLE_ID`). Do the same for your Judge role if you have a separate one.

---

## 5. Create your `.env` file

In your project folder, copy `.env.example` and rename the copy to `.env`. Open it in Notepad and fill in every value you collected above:

```
SUPABASE_URL=https://abcxyz123.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_xxxxxxxxxxxxx
DISCORD_TOKEN=your-bot-token
CLIENT_ID=your-application-id
GUILD_ID=your-server-id
MOD_ROLE_ID=your-mod-role-id
JUDGE_ROLE_ID=your-judge-role-id
PORT=3001
```
No quotes around values, no spaces around the `=`.

---

## 6. Install and run

In Command Prompt, inside your project folder:
```
npm install
npm start
```
You should see:
```
Website + API listening on http://localhost:3001
Slash commands registered.
Discord bot ready as YourBotName#1234
```
That's both the bot and the website running, in this one window. Leave it open.

---

## 7. Try it

- In Discord, run `/submit-level` — attach a thumbnail image and a short video, fill in the rest, submit.
- React with a number (1️⃣–🔟) on the bot's post to vote.
- Open **http://localhost:3001/site.html** in your browser — you should see your submitted level on the leaderboard, with the thumbnail. Hover over it to preview the video.

---

## 8. Editing the website

Everything about how the site looks and reads is in `site.html`. The top of the `<script>` section has a `CONFIG` object:
```js
const CONFIG = {
  discordInviteUrl: "https://discord.gg/your-invite-code",
  apiBaseUrl: "",
  tutorialSteps: [ ... ],
};
```
Change your Discord invite link and the tutorial text there. Colors and fonts are near the top of the `<style>` section if you want to adjust the look.

---

## 9. Going live (so it's not just on your PC)

Right now this only works while your computer is on and `npm start` is running. To make it a real website reachable by anyone:

1. Push your project folder to a free host that runs Node.js continuously — **Render** or **Railway** are the easiest.
2. In their dashboard, set the same environment variables from your `.env` file (never upload `.env` itself — most hosts have a dedicated "Environment Variables" section for this).
3. Once deployed, they give you a public URL like `https://lvl-board.onrender.com` — that's your live site.

Want help with that step once you've tested everything locally? Just ask.
