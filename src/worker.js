// 政策立案ツール — Cloudflare Worker（Discord OAuth + D1）
import { handleAuth, requireUser, currentUser, isLocal, renewSession } from "./auth.js";
import { HttpError, json } from "./util.js";
import { routes as projectRoutes } from "./api/projects.js";
import { routes as taskRoutes } from "./api/tasks.js";
import { routes as meetingRoutes } from "./api/meetings.js";
import { routes as overviewRoutes } from "./api/overview.js";
import { routes as seedRoutes } from "./api/seeds.js";
import { routes as hearingRoutes } from "./api/hearings.js";
import { routes as adminRoutes } from "./api/admin.js";
import { routes as researchRoutes } from "./api/research.js";
import { routes as presentationRoutes } from "./api/presentation.js";
import { routes as deptRoutes } from "./api/dept.js";
import { routes as searchRoutes } from "./api/search.js";
import { routes as timelineRoutes } from "./api/timeline.js";
import { routes as surveyRoutes } from "./api/surveys.js";
import { routes as notionBackfillRoutes } from "./api/notion-backfill.js";
import { routes as schedulePollRoutes } from "./api/schedule-polls.js";
import { routes as trashRoutes } from "./api/trash.js";
import { routes as shareRoutes, handleShare } from "./share.js";
import { routes as discordPostRoutes } from "./discord-post.js";
import { routes as otherRoutes } from "./api/other.js";
import { runDailyReminders } from "./cron.js";
import { reportError } from "./monitor.js";

// [メソッド, パス（:id は数字）, ハンドラ]。ハンドラは (ctx) => Response | data
const ROUTES = [...overviewRoutes, ...projectRoutes, ...taskRoutes, ...meetingRoutes, ...seedRoutes, ...hearingRoutes, ...adminRoutes, ...researchRoutes, ...presentationRoutes, ...deptRoutes, ...searchRoutes, ...timelineRoutes, ...surveyRoutes, ...notionBackfillRoutes, ...schedulePollRoutes, ...trashRoutes, ...shareRoutes, ...discordPostRoutes, ...otherRoutes].map(([method, path, handler]) => [
  method,
  new RegExp(`^${path.replace(/:(\w+)/g, "(?<$1>\\d+)")}$`),
  handler,
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/auth/")) return await handleAuth(request, env, url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url, ctx);
      // Discordに貼ったときのカード（ログインなし。src/share.js）
      if (url.pathname.startsWith("/s/")) return await handleShare(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      // 想定外のエラーは記録する（管理者メニュー・SENTRY_DSN があれば Sentry にも）
      await reportError(env, { source: "server", message: err?.message || String(err), stack: err?.stack, url: `${request.method} ${url.pathname}` }, ctx).catch(() => {});
      return json({ error: "サーバーでエラーが発生しました" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyReminders(env).catch((err) =>
      reportError(env, { source: "server", message: `毎朝のリマインド：${err?.message || err}`, stack: err?.stack })));
  },
};

async function handleApi(request, env, url, ctx) {
  // ログイン前の画面で使う情報
  if (url.pathname === "/api/session") {
    const user = await currentUser(request, env);
    // siteLabel：テスト版などで、画面上部に帯を出す
    // version：デプロイごとに変わる。画面は、これが変わったら次の画面移動で読み込み直す（古いプログラムのまま使い続けないように）
    return json({ user, devLogin: env.DEV_LOGIN === "true" && isLocal(url), siteLabel: env.SITE_LABEL || "", guildId: env.DISCORD_GUILD_ID || "", version: env.CF_VERSION?.id || "" });
  }

  if (request.method !== "GET") assertSameOrigin(request, url);
  const user = await requireUser(request, env);

  // 画面で起きたエラーを受け取って記録する（ログインしている人から、1回に1件）
  if (url.pathname === "/api/client-errors" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    await reportError(env, { source: "client", message: body.message, stack: body.stack, url: body.url, userId: user.id });
    return json({ ok: true });
  }

  for (const [method, re, handler] of ROUTES) {
    if (method !== request.method) continue;
    const m = url.pathname.match(re);
    if (!m) continue;
    const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, Number(v)]));
    const result = await handler({ request, env, url, user, params, ctx });
    const res = result instanceof Response ? result : json(result);
    const renewed = await renewSession(request, env, url).catch(() => null);
    if (renewed) { try { res.headers.append("Set-Cookie", renewed); } catch { /* 書き換えられない返事はそのまま */ } }
    return res;
  }
  return json({ error: "Not found" }, 404);
}

// 書き込みは同じオリジンの画面からだけ受け付ける（Cookie は SameSite=Lax だが念のため）
function assertSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "不正なリクエストです");
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) {
    throw new HttpError(415, "不正なリクエストです");
  }
}
