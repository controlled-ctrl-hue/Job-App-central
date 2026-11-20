// Fetch a public web page safely: http(s) only, no private/loopback addresses
// (so a malicious link can't make this app probe your home network), manual
// redirect handling so every hop is checked, size and time limits.
import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublic(url) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Blocked protocol ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Blocked local hostname');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Blocked private network address');
}

export async function fetchPage(rawUrl) {
  let url = new URL(rawUrl);
  const hops = [];
  for (let i = 0; i < 6; i++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      hops.push(url.href);
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    const html = await readCapped(res);
    return { status: res.status, finalUrl: url.href, redirects: hops, html };
  }
  throw new Error('Too many redirects');
}

async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function htmlToText(html) {
  return html
    .replace(/<script(?![^>]*ld\+json)[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Return schema.org JobPosting objects embedded as JSON-LD, if any. */
export function extractJobPostingLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const it of items) {
        const t = it?.['@type'];
        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) out.push(it);
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return out;
}

export function pageTitle(html) {
  return htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
}
