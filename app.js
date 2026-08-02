// ============================================================
// LVL BOARD — everything server-side in one file.
//
// This single process does THREE jobs at once:
//   1. Runs the Discord bot (slash command + reaction voting)
//   2. Runs the API the website's JavaScript calls
//   3. Serves site.html itself, so visiting your server's address
//      in a browser shows the leaderboard
//
// Run it with:  npm install   then   npm start
// Everything you need to configure lives in .env (copy .env.example).
// ============================================================

import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  Events,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
} from "discord.js";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------
// Config — all pulled from .env. See .env.example for what each does.
// ------------------------------------------------------------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  MOD_ROLE_ID,
  JUDGE_ROLE_ID,
  PORT = 3001,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const STORAGE_BUCKET = "media";
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB
const CATEGORIES = ["layout", "deco", "hardest"];

// ============================================================
// SHARED DATABASE FUNCTIONS
// Both the Discord bot (below) and the API routes (further below)
// call these directly — no network hop between "bot" and "backend"
// because they're the same process now.
// ============================================================

async function insertSubmission(fields) {
  const { data, error } = await supabase.from("submissions").insert(fields).select().single();
  if (error) throw error;
  const { error: rpcError } = await supabase.rpc("increment_rater", {
    p_discord_id: fields.submitted_by_discord_id,
    p_username: fields.submitted_by_username,
  });
  if (rpcError) console.error("increment_rater failed:", rpcError.message);
  return data;
}

async function upsertRating({ discordMessageId, raterDiscordId, raterUsername, score, isJudge }) {
  const { data: submission, error: findErr } = await supabase
    .from("submissions")
    .select("id")
    .eq("discord_message_id", discordMessageId)
    .single();
  if (findErr || !submission) throw new Error("No submission found for that message");

  const { error } = await supabase.rpc("cast_vote", {
    p_submission_id: submission.id,
    p_rater_discord_id: raterDiscordId,
    p_rater_username: raterUsername,
    p_score: score,
    p_is_judge: isJudge,
  });
  if (error) throw error;
}

async function deleteRating({ discordMessageId, raterDiscordId }) {
  const { data: submission, error: findErr } = await supabase
    .from("submissions")
    .select("id")
    .eq("discord_message_id", discordMessageId)
    .single();
  if (findErr || !submission) return; // nothing to delete
  await supabase.from("ratings").delete().eq("submission_id", submission.id).eq("rater_discord_id", raterDiscordId);
}

async function uploadAttachmentToStorage(attachment, folder) {
  const res = await fetch(attachment.url);
  if (!res.ok) throw new Error(`Couldn't download attachment (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = attachment.name.includes(".") ? attachment.name.split(".").pop() : "bin";
  const filePath = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(filePath, buffer, {
    contentType: attachment.contentType || undefined,
    upsert: false,
  });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
  return data.publicUrl;
}

// ============================================================
// DISCORD BOT
// ============================================================
const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const SCORE_BY_EMOJI = Object.fromEntries(NUMBER_EMOJI.map((e, i) => [e, i + 1]));

const discordBot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
});

function isJudge(member) {
  if (!member) return false;
  return (
    (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) ||
    (JUDGE_ROLE_ID && member.roles.cache.has(JUDGE_ROLE_ID))
  );
}

const submitLevelCommand = new SlashCommandBuilder()
  .setName("submit-level")
  .setDescription("Submit a level for rating")
  .addIntegerOption((opt) => opt.setName("level_id").setDescription("In-game level ID").setRequired(true))
  .addStringOption((opt) => opt.setName("name").setDescription("Level name").setRequired(true))
  .addStringOption((opt) => opt.setName("creator").setDescription("Level creator").setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName("category")
      .setDescription("Leaderboard category")
      .setRequired(true)
      .addChoices(
        { name: "Layout", value: "layout" },
        { name: "Deco", value: "deco" },
        { name: "Hardest", value: "hardest" }
      )
  )
  .addAttachmentOption((opt) =>
    opt.setName("thumbnail").setDescription("Thumbnail image shown on the leaderboard card").setRequired(true)
  )
  .addAttachmentOption((opt) =>
    opt.setName("video").setDescription("Showcase/verification video (plays on hover on the site)").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("difficulty_tier").setDescription("e.g. 'Extreme Demon' — shown as a tag, doesn't affect ranking").setRequired(false)
  );

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [submitLevelCommand.toJSON()],
  });
  console.log("Slash commands registered.");
}

discordBot.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "submit-level") return;
  await interaction.deferReply();

  const name = interaction.options.getString("name");
  const creator = interaction.options.getString("creator");
  const category = interaction.options.getString("category");
  const levelId = interaction.options.getInteger("level_id");
  const tier = interaction.options.getString("difficulty_tier");
  const thumbnail = interaction.options.getAttachment("thumbnail");
  const video = interaction.options.getAttachment("video");

  if (!thumbnail.contentType?.startsWith("image/")) {
    return interaction.editReply("❌ Thumbnail must be an image file (png/jpg/webp).");
  }
  if (thumbnail.size > MAX_THUMBNAIL_BYTES) {
    return interaction.editReply(`❌ Thumbnail is too large (max ${MAX_THUMBNAIL_BYTES / 1024 / 1024}MB).`);
  }
  if (!video.contentType?.startsWith("video/")) {
    return interaction.editReply("❌ Video must be a video file (mp4/webm/mov).");
  }
  if (video.size > MAX_VIDEO_BYTES) {
    return interaction.editReply(`❌ Video is too large (max ${MAX_VIDEO_BYTES / 1024 / 1024}MB).`);
  }

  try {
    const [thumbnailUrl, videoUrl] = await Promise.all([
      uploadAttachmentToStorage(thumbnail, "thumbnails"),
      uploadAttachmentToStorage(video, "videos"),
    ]);

    const embed = new EmbedBuilder()
      .setTitle(name)
      .setDescription(`by **${creator}** · #${levelId}`)
      .setImage(thumbnailUrl)
      .addFields(
        { name: "Category", value: category, inline: true },
        ...(tier ? [{ name: "Tier", value: tier, inline: true }] : [])
      )
      .setFooter({ text: "Vote below — Mods/Judges set the leaderboard score, everyone else sets the Community score." })
      .setColor(0x4cc9f0);

    const videoAttachment = new AttachmentBuilder(video.url, { name: video.name });
    const replyMessage = await interaction.editReply({ embeds: [embed], files: [videoAttachment], fetchReply: true });

    await insertSubmission({
      gd_level_id: levelId,
      level_name: name,
      creator,
      category,
      difficulty_tier: tier ?? null,
      thumbnail_url: thumbnailUrl,
      video_url: videoUrl,
      submitted_by_discord_id: interaction.user.id,
      submitted_by_username: interaction.user.username,
      discord_message_id: replyMessage.id,
    });

    for (const emoji of NUMBER_EMOJI) await replyMessage.react(emoji);
  } catch (err) {
    console.error(err);
    await interaction.followUp({ content: `❌ Couldn't submit that level: ${err.message}`, ephemeral: true });
  }
});

discordBot.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  const score = SCORE_BY_EMOJI[reaction.emoji.name];
  if (!score) return;

  if (reaction.partial) await reaction.fetch();
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

  for (const [emoji, other] of message.reactions.cache) {
    if (emoji === reaction.emoji.name || !SCORE_BY_EMOJI[emoji]) continue;
    const users = other.users.cache.has(user.id) ? other.users.cache : await other.users.fetch();
    if (users.has(user.id)) await other.users.remove(user.id).catch(() => {});
  }

  const member = await message.guild.members.fetch(user.id).catch(() => null);

  try {
    await upsertRating({
      discordMessageId: message.id,
      raterDiscordId: user.id,
      raterUsername: user.username,
      score,
      isJudge: isJudge(member),
    });
  } catch (err) {
    console.error("upsertRating failed:", err.message);
  }
});

discordBot.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  if (!SCORE_BY_EMOJI[reaction.emoji.name]) return;

  if (reaction.partial) await reaction.fetch();
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;

  const stillVoted = [...message.reactions.cache.values()].some(
    (r) => SCORE_BY_EMOJI[r.emoji.name] && r.users.cache.has(user.id)
  );
  if (stillVoted) return;

  try {
    await deleteRating({ discordMessageId: message.id, raterDiscordId: user.id });
  } catch (err) {
    console.error("deleteRating failed:", err.message);
  }
});

discordBot.once(Events.ClientReady, (c) => console.log(`Discord bot ready as ${c.user.tag}`));

// ============================================================
// WEBSITE + API (Express)
// ============================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves site.html, so "/" shows the leaderboard

app.get("/api/levels", async (req, res) => {
  const { category, limit = 50 } = req.query;
  const take = Math.min(Number(limit) || 50, 100);

  if (!category || !["layout", "deco", "hardest", "community"].includes(category)) {
    return res.status(400).json({ error: "category must be layout, deco, hardest, or community" });
  }

  let query = supabase.from("submission_scores").select("*").limit(take);
  if (category === "community") {
    query = query.order("community_rating", { ascending: false, nullsFirst: false });
  } else {
    query = query.eq("category", category).order("judge_rating", { ascending: false, nullsFirst: false });
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/stats", async (_req, res) => {
  const { count: totalLevels, error: countErr } = await supabase
    .from("submissions")
    .select("*", { count: "exact", head: true });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: activeRaters, error: ratersErr } = await supabase
    .from("raters")
    .select("discord_id")
    .gte("last_active", thirtyDaysAgo);

  const { data: topSubmitters, error: topErr } = await supabase
    .from("raters")
    .select("username, levels_submitted")
    .order("levels_submitted", { ascending: false })
    .limit(10);

  if (countErr || ratersErr || topErr) {
    return res.status(500).json({ error: (countErr || ratersErr || topErr).message });
  }

  res.json({
    total_levels: totalLevels ?? 0,
    active_raters: activeRaters?.length ?? 0,
    top_submitters: topSubmitters ?? [],
  });
});

// Note: there are no POST/DELETE routes for submissions or ratings.
// Writing to the database only happens from inside this same process
// (the Discord bot handlers above calling insertSubmission/upsertRating
// directly) — there is nothing external can POST to, which is safer
// by default than exposing write endpoints over HTTP.

// ------------------------------------------------------------
// Start everything
// ------------------------------------------------------------

// Force the root URL to serve the site interface
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "site.html"));
});



app.listen(PORT, () => console.log(`Website + API listening on http://localhost:${PORT}`));
registerCommands().then(() => discordBot.login(DISCORD_TOKEN));
