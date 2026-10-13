const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function assertAllowedUrl(url, allowedHosts) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Scheme "${url.protocol}" is not allowed for source requests`);
  }
  const allowed = allowedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  if (!allowed) throw new TypeError(`Host "${url.hostname}" is not in this source's allowlist`);
}

export async function allowlistedFetch(input, init, allowedHosts, fetchImpl = globalThis.fetch) {
  let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  let requestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertAllowedUrl(url, allowedHosts);
    const response = await fetchImpl(url, requestInit);
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (hop === MAX_REDIRECTS) {
      await response.body?.cancel();
      throw new TypeError(`Too many redirects while fetching ${url.origin}${url.pathname}`);
    }
    const nextUrl = new URL(location, url);
    assertAllowedUrl(nextUrl, allowedHosts);
    if (nextUrl.origin !== url.origin && requestInit.headers) {
      const headers = new Headers(requestInit.headers);
      headers.delete('authorization');
      headers.delete('cookie');
      requestInit = { ...requestInit, headers };
    }
    await response.body?.cancel();
    url = nextUrl;
  }
  throw new TypeError('Redirect limit exceeded');
}
