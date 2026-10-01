/**
 * Stable download links for the website: /download/mac and /download/android
 * redirect to the newest release's DMG or APK on GitHub, and /download/latest.json
 * reports both versions for the page's labels. Releases never require a page edit.
 *
 * The newest tags come from the public releases Atom feed (no GitHub API and no
 * token); file URLs follow the fixed asset names .github/workflows/release.yml
 * produces. The answer is cached, and if the feed is unreachable visitors land
 * on the Releases page instead of a broken link.
 */

const REPOSITORY = "aliahadmd/wovoice";
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
const ASSET_PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const CACHE_KEY = "https://wovoice.aliahad.com/__cache/github-releases-v2";
const CACHE_SECONDS = 600;
const LINK_MAX_AGE_SECONDS = 300;

export type DownloadPlatform = "mac" | "android";

export interface DownloadInfo {
  version: string;
  url: string;
}

export type LatestDownloads = Record<DownloadPlatform, DownloadInfo | null>;

export interface DownloadDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Returns the edge cache, or null where none is available. */
  cache: () => Cache | null;
}

export const productionDownloadDeps: DownloadDeps = {
  fetch: (input, init) => fetch(input, init),
  cache: () => (typeof caches === "undefined" ? null : caches.default),
};

/** Each platform's tag and asset naming, as produced by .github/workflows/release.yml. */
const PLATFORMS: Record<DownloadPlatform, { tag: RegExp; assetName: (version: string) => string }> = {
  mac: {
    tag: /^desktop-v(\d+(?:\.\d+)*)$/u,
    assetName: (version) => `wovoice-desktop-${version}.dmg`,
  },
  android: {
    tag: /^v(\d+(?:\.\d+)*)$/u,
    assetName: (version) => `WoVoice-${version}.apk`,
  },
};

export async function handleDownloadRoute(
  request: Request,
  ctx: ExecutionContext | undefined,
  deps: DownloadDeps = productionDownloadDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/download/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const platform = url.pathname === "/download/mac"
    ? "mac"
    : url.pathname === "/download/android" ? "android" : null;
  if (url.pathname !== "/download/latest.json" && platform === null) {
    return new Response("Not found", { status: 404 });
  }

  const latest = await latestDownloads(deps, ctx);
  if (platform === null) {
    return Response.json(
      { ...latest, releasesUrl: RELEASES_PAGE },
      { headers: { "Cache-Control": `public, max-age=${LINK_MAX_AGE_SECONDS}` } },
    );
  }
  const target = latest[platform]?.url ?? RELEASES_PAGE;
  return new Response(null, {
    status: 302,
    headers: { Location: target, "Cache-Control": `public, max-age=${LINK_MAX_AGE_SECONDS}` },
  });
}

/** The newest DMG and APK; never throws (a platform it cannot resolve is null). */
export async function latestDownloads(deps: DownloadDeps, ctx?: ExecutionContext): Promise<LatestDownloads> {
  const cache = deps.cache();
  const cached = await cache?.match(CACHE_KEY).catch(() => undefined);
  if (cached) {
    try {
      return (await cached.json()) as LatestDownloads;
    } catch {
      // A damaged cache entry is simply refreshed below.
    }
  }

  let latest: LatestDownloads = { mac: null, android: null };
  try {
    latest = await fromFeed(deps);
  } catch (error) {
    console.error(JSON.stringify({ event: "download_feed_failed", reason: String(error).slice(0, 200) }));
  }

  // Cache only complete answers, so a partial outage is retried on the next visit.
  if (cache && latest.mac && latest.android) {
    const write = cache.put(
      CACHE_KEY,
      Response.json(latest, { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } }),
    ).catch(() => undefined);
    if (ctx) ctx.waitUntil(write);
    else await write;
  }
  return latest;
}

async function fromFeed(deps: DownloadDeps): Promise<LatestDownloads> {
  const response = await deps.fetch(`${RELEASES_PAGE}.atom`, {
    headers: { Accept: "application/atom+xml", "User-Agent": "wovoice-website" },
  });
  if (!response.ok) throw new Error(`GitHub feed answered ${response.status}`);
  const feed = await response.text();
  // The feed lists releases newest first; drafts never appear in it.
  const tags = [...feed.matchAll(/\/releases\/tag\/([A-Za-z0-9._-]+)"/gu)].map((match) => match[1]);

  const pick = (platform: DownloadPlatform): DownloadInfo | null => {
    const rule = PLATFORMS[platform];
    for (const tag of tags) {
      const match = rule.tag.exec(tag);
      if (match) {
        return { version: match[1], url: `${ASSET_PREFIX}${tag}/${rule.assetName(match[1])}` };
      }
    }
    return null;
  };
  return { mac: pick("mac"), android: pick("android") };
}
