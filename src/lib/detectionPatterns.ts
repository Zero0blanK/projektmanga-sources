/**
 * "Does this response body look like a bot-block?" — mirrors
 * `apps/extensions/utils/detectionPatterns.ts`. Deliberately has zero imports: it is
 * pulled in by sourceError.ts, which every source imports.
 */
export const CLOUDFLARE_PATTERNS: RegExp[] = [
  /cf-browser-verification/i,
  /cf-challenge/i,
  /just\s*a\s*moment/i,
  /checking\s*your\s*browser/i,
  /you\s*are\s*being\s*redirected/i,
  /ddos-guard/i,
  /__cf_chl_/i,
];

export const CAPTCHA_PATTERNS: RegExp[] = [
  /recaptcha/i,
  /hcaptcha/i,
  /captcha/i,
  /g-recaptcha/i,
  /h-captcha/i,
  /verify\s*you\s*are\s*human/i,
  /prove\s*you\s*are\s*not\s*a\s*robot/i,
];
