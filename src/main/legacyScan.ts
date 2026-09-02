// Reads a legacy single-file project — the format where every image sits inside
// the JSON as a base64 data URL — WITHOUT ever holding the file as one string.
//
// This is not an optimisation. V8 caps a string at 2^29-24 characters (512 MiB),
// and the owner's biggest project is 522 MiB on disk: `JSON.parse(readFileSync(f,
// 'utf8'))` throws "Cannot create a string longer than 0x1fffffe8 characters"
// before it parses anything, which is why the app reported "no project is open"
// for it. So the file is read as a Buffer (Buffers go to gigabytes), walked once
// with a small JSON tokenizer, and only the `images[i].src` strings — 99.9% of the
// bytes — are treated specially: they are cut out, replaced with "", and returned
// as byte ranges so the caller can base64-decode each one straight from the
// Buffer into its own file. What is left ("slim") is a few hundred KB of layout
// and prompts that JSON.parse handles like any other file.
//
// The walker is a real (if minimal) JSON tokenizer rather than a regex for
// `"src":"`, because prompts are user text and the legacy files come from more
// than one writer (some are `{"id": "…"}` with spaces, some are minified).

/** Byte range [start, end) of a string's CONTENT — the quotes are excluded. */
export type ByteRange = { start: number; end: number }

export type ScannedProject = {
  /** The project JSON with every images[i].src replaced by "". */
  slim: string
  /** Where each images[i].src string was, by array index; null when the image
   *  had no src or it was not a string. */
  srcs: (ByteRange | null)[]
}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const LBRACE = 0x7b
const RBRACE = 0x7d
const LBRACKET = 0x5b
const RBRACKET = 0x5d
const COLON = 0x3a
const COMMA = 0x2c

type Frame = {
  array: boolean
  /** In an object: the key whose value is being read. */
  key: string | null
  /** In an object: the next string is a key, not a value. */
  expectKey: boolean
  /** In an array: index of the element being read. */
  index: number
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09
}

function isDelimiter(c: number): boolean {
  return isSpace(c) || c === COMMA || c === RBRACE || c === RBRACKET || c === COLON
}

/** `i` is the opening quote; returns the index of the closing quote. Uses the
 *  native indexOf so a 5 MB base64 string costs one memchr, not five million
 *  JS iterations. */
function skipString(buf: Buffer, i: number): number {
  let from = i + 1
  for (;;) {
    const q = buf.indexOf(QUOTE, from)
    if (q < 0) throw new Error('legacy project: unterminated string')
    // A quote preceded by an odd number of backslashes is escaped.
    let slashes = 0
    for (let k = q - 1; k > i && buf[k] === BACKSLASH; k--) slashes++
    if (slashes % 2 === 0) return q
    from = q + 1
  }
}

/** True when the tokenizer is at `<root>.images[<n>].src`. */
function atImageSrc(stack: Frame[]): boolean {
  return (
    stack.length === 3 &&
    !stack[0].array &&
    stack[0].key === 'images' &&
    stack[1].array &&
    !stack[2].array &&
    stack[2].key === 'src'
  )
}

export function scanLegacyProject(buf: Buffer): ScannedProject {
  const stack: Frame[] = []
  const chunks: Buffer[] = []
  const srcs: (ByteRange | null)[] = []
  const empty = Buffer.from('""')
  let copiedTo = 0
  let i = 0
  const n = buf.length
  while (i < n) {
    const c = buf[i]
    if (isSpace(c)) {
      i++
      continue
    }
    if (c === QUOTE) {
      const end = skipString(buf, i)
      const top = stack[stack.length - 1]
      if (top && !top.array && top.expectKey) {
        top.key = buf.toString('utf8', i + 1, end)
        top.expectKey = false
      } else if (atImageSrc(stack)) {
        chunks.push(buf.subarray(copiedTo, i), empty)
        copiedTo = end + 1
        srcs[stack[1].index] = { start: i + 1, end }
      }
      i = end + 1
      continue
    }
    if (c === LBRACE) {
      stack.push({ array: false, key: null, expectKey: true, index: 0 })
      i++
    } else if (c === LBRACKET) {
      stack.push({ array: true, key: null, expectKey: false, index: 0 })
      i++
    } else if (c === RBRACE || c === RBRACKET) {
      stack.pop()
      i++
    } else if (c === COMMA) {
      const top = stack[stack.length - 1]
      if (top) {
        if (top.array) top.index++
        else top.expectKey = true
      }
      i++
    } else if (c === COLON) {
      i++
    } else {
      // number / true / false / null
      while (i < n && !isDelimiter(buf[i])) i++
    }
  }
  if (stack.length) throw new Error('legacy project: truncated JSON')
  chunks.push(buf.subarray(copiedTo))
  return { slim: Buffer.concat(chunks).toString('utf8'), srcs }
}

/** Decode a `data:<mime>;base64,…` string that lives at `r` inside `buf`.
 *  Returns null when it is not a base64 data URL. */
export function decodeDataUrlRange(
  buf: Buffer,
  r: ByteRange
): { mime: string; bytes: Buffer } | null {
  const headEnd = Math.min(r.end, r.start + 80)
  const head = buf.toString('latin1', r.start, headEnd)
  const m = /^data:([\w/+.-]+);base64,/.exec(head)
  if (!m) return null
  const bodyStart = r.start + m[0].length
  if (bodyStart >= r.end) return null
  // Buffer.from(<string>, 'base64') is the only base64 decoder Node offers; the
  // intermediate latin1 string is per image (a few MB), never the whole file.
  return {
    mime: m[1].toLowerCase(),
    bytes: Buffer.from(buf.toString('latin1', bodyStart, r.end), 'base64')
  }
}

/** The same thing for a data URL that is already a string. */
export function decodeDataUrl(src: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([\w/+.-]+);base64,/.exec(src.slice(0, 80))
  if (!m || m[0].length >= src.length) return null
  return { mime: m[1].toLowerCase(), bytes: Buffer.from(src.slice(m[0].length), 'base64') }
}
