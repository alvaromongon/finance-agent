// Fetches news headlines to enrich Claude's context.
// Source: Yahoo Finance public RSS (no API key, no cost).
// Non-blocking: any failure returns an empty array and logs a warning.
// finance.yahoo.com/rss/headline redirects (301) to feeds.finance.yahoo.com —
// this domain is requested directly because the Routines egress allowlist is
// by exact subdomain and does not follow redirects to new hosts.
const RSS_BASE = "https://feeds.finance.yahoo.com/rss/2.0/headline";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " + "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function fetchHeadlines(ticker: string, maxItems = 5): Promise<string[]> {
  try {
    const url = `${RSS_BASE}?s=${encodeURIComponent(ticker)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[news-provider] HTTP ${res.status} for ${ticker}`);
      return [];
    }
    const xml = await res.text();
    // Extracts <title> inside each <item> (the first <title> is the channel, skipped).
    const titles: string[] = [];
    const itemRe = /<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) !== null && titles.length < maxItems) {
      const title = m[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (title) titles.push(title);
    }
    if (titles.length > 0) {
      console.log(`[news-provider] ${ticker}: ${titles.length} headline(s) fetched.`);
    } else {
      console.warn(`[news-provider] ${ticker}: no headlines in the RSS.`);
    }
    return titles;
  } catch (err) {
    console.warn(`[news-provider] Could not fetch headlines for ${ticker}:`, err instanceof Error ? err.message : err);
    return [];
  }
}
