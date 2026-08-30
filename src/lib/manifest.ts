/**
 * Manifest-derived values that both the running source and the generated index need.
 *
 * A source object has to expose `isNSFW: boolean` because that is what the app's `Source`
 * interface declares, but the manifest authors `content_rating` instead — one boolean
 * cannot distinguish "adult site" from "general catalogue with an adult corner". The
 * mapping between the two lives here so every source applies it identically.
 *
 * `build.mjs` implements the same rule when it writes `isNSFW` into `index.json`; the two
 * must agree, or a source would report one rating in the listing and another once
 * installed. Both are one line, and `npm run build` prints the rating it derived.
 */

/** `nsfw` is the only rating that sets the boolean: `mixed` sources stay visible under a
 * "hide NSFW sources" setting and are expected to be badged instead. */
export function deriveIsNSFW(contentRating: string): boolean {
  return contentRating === 'nsfw';
}
