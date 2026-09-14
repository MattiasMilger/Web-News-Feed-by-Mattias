/**
 * worker.js - Personal CORS proxy for Web News Feed by Mattias
 *
 * Deploy this on Cloudflare Workers (free tier). It fetches whatever
 * RSS URL is passed in ?url= and returns it with permissive CORS
 * headers, so your news feed app can read it directly - no dependency
 * on public/shared proxy services.
 *
 * Free tier: 100,000 requests/day, no credit card required.
 */

export default {
    async fetch(request) {
        const requestUrl = new URL(request.url);
        const target = requestUrl.searchParams.get("url");

        // Handle CORS preflight requests
        if (request.method === "OPTIONS") {
            return new Response(null, {
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Access-Control-Allow-Headers": "*"
                }
            });
        }

        if (!target) {
            return new Response("Missing 'url' query parameter.", { status: 400 });
        }

        let targetUrl;
        try {
            targetUrl = new URL(target);
            if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
                throw new Error("Unsupported protocol");
            }
        } catch (err) {
            return new Response("Invalid 'url' parameter.", { status: 400 });
        }

        try {
            const upstreamResponse = await fetch(targetUrl.toString(), {
                headers: {
                    "User-Agent": "Mozilla/5.0 (compatible; PersonalNewsFeedProxy/1.0)"
                },
                cf: { cacheTtl: 120, cacheEverything: true } // light caching to save on requests
            });

            const body = await upstreamResponse.arrayBuffer();
            const headers = new Headers(upstreamResponse.headers);

            headers.set("Access-Control-Allow-Origin", "*");
            headers.delete("content-encoding");
            headers.delete("content-length");
            headers.delete("content-security-policy");

            return new Response(body, {
                status: upstreamResponse.status,
                headers
            });
        } catch (err) {
            return new Response("Proxy fetch failed: " + err.message, {
                status: 502,
                headers: { "Access-Control-Allow-Origin": "*" }
            });
        }
    }
};
