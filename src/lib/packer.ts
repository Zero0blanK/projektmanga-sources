// Dean Edwards' "packer" (`eval(function(p,a,c,k,e,d){...}('payload',radix,count,'words'.split('|')...))`),
// undone without running any of it: the payload is a template whose short base-N tokens
// stand for entries of the word list. Some readers hide their image URLs this way.

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A token's index in the word list, read in the packer's base (up to 62). */
function decode(token: string, radix: number): number {
  let value = 0;
  for (const char of token) {
    const digit = DIGITS.indexOf(char);
    if (digit < 0 || digit >= radix) return NaN;
    value = value * radix + digit;
  }
  return value;
}

/** The script a packed `eval(function(p,a,c,k,e,d)...)` would run, or null if `source`
 * holds no packed script. */
export function unpack(source: string): string | null {
  const match = source.match(
    /\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/s,
  );
  if (!match) return null;
  const [, payload, radixText, countText, wordList] = match;
  const radix = Number(radixText);
  const count = Number(countText);
  if (!(radix >= 2 && radix <= 62) || !Number.isFinite(count)) return null;
  const words = wordList.split("|");
  const template = payload.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  return template.replace(/\b\w+\b/g, (token) => {
    const index = decode(token, radix);
    return Number.isFinite(index) && index < count && words[index] ? words[index] : token;
  });
}

/** Every single-quoted string literal in `script`, joined: what `'a'+'b'+'c'` evaluates to. */
export function joinedLiterals(script: string): string {
  return [...script.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((literal) => literal[1]).join("");
}
