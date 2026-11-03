import { createHash, randomBytes, randomInt } from 'node:crypto'
import { Redis } from '@upstash/redis'

export type DrawMode = 'winner' | 'numbers'

export interface DrawBox {
  number: number
  value: string
  claimedBy: string | null
}

export interface DrawSession {
  id: string
  title: string
  mode: DrawMode
  size: number
  boxes: DrawBox[]
  secret: string
  proof: string
  hash: string
  createdAt: number
}

/** The sealed part of a draw. Written once at creation, never modified. */
interface SealedDraw {
  id: string
  title: string
  mode: DrawMode
  size: number
  values: string[]
  secret: string
  proof: string
  hash: string
  createdAt: number
}

/** boxNumber -> member name */
type Claims = Record<string, string>

export type ClaimResult = 'ok' | 'box_taken' | 'name_taken'

export const MIN_BOXES = 2
export const MAX_BOXES = 100
const TTL_SECONDS = 24 * 60 * 60
const TTL_MS = TTL_SECONDS * 1000

/* ------------------------------------------------------------------ */
/* Storage backends                                                    */
/* ------------------------------------------------------------------ */

interface Backend {
  save(draw: SealedDraw): Promise<void>
  load(id: string): Promise<{ draw: SealedDraw; claims: Claims } | null>
  /** Must be atomic: two simultaneous claims on one box can never both succeed. */
  claim(id: string, box: number, name: string): Promise<ClaimResult>
}

/**
 * Upstash Redis — used on Vercel (serverless functions don't share memory).
 * HSETNX makes the claim atomic across every function instance.
 */
function redisBackend(url: string, token: string): Backend {
  const redis = new Redis({ url, token, automaticDeserialization: false })
  const k = (id: string) => ({
    draw: `chama:draw:${id}`,
    claims: `chama:draw:${id}:claims`,
    names: `chama:draw:${id}:names`,
  })

  return {
    async save(draw) {
      await redis.set(k(draw.id).draw, JSON.stringify(draw), { ex: TTL_SECONDS })
    },

    async load(id) {
      const keys = k(id)
      const [raw, claims] = await redis
        .pipeline()
        .get<string>(keys.draw)
        .hgetall<Claims>(keys.claims)
        .exec<[string | null, Claims | null]>()
      if (!raw) return null
      return { draw: JSON.parse(raw) as SealedDraw, claims: claims ?? {} }
    },

    async claim(id, box, name) {
      const keys = k(id)
      // Reserve the name first so one person can't hold two boxes.
      const nameOk = await redis.hsetnx(keys.names, name.toLowerCase(), String(box))
      if (!nameOk) return 'name_taken'

      const boxOk = await redis.hsetnx(keys.claims, String(box), name)
      if (!boxOk) {
        await redis.hdel(keys.names, name.toLowerCase())
        return 'box_taken'
      }

      await redis.pipeline().expire(keys.claims, TTL_SECONDS).expire(keys.names, TTL_SECONDS).exec()
      return 'ok'
    },
  }
}

/** In-memory Map — local development fallback when no Redis credentials are set. */
function memoryBackend(): Backend {
  const g = globalThis as typeof globalThis & {
    __chamaDraws?: Map<string, { draw: SealedDraw; claims: Claims }>
  }
  const draws = g.__chamaDraws ?? (g.__chamaDraws = new Map())

  const purge = () => {
    const cutoff = Date.now() - TTL_MS
    for (const [id, entry] of draws) if (entry.draw.createdAt < cutoff) draws.delete(id)
  }

  return {
    async save(draw) {
      purge()
      draws.set(draw.id, { draw, claims: {} })
    },
    async load(id) {
      purge()
      const entry = draws.get(id)
      return entry ? { draw: entry.draw, claims: { ...entry.claims } } : null
    },
    async claim(id, box, name) {
      // No awaits between check and assign: Node runs this block without interruption.
      const entry = draws.get(id)!
      const lower = name.toLowerCase()
      if (Object.values(entry.claims).some(n => n.toLowerCase() === lower)) return 'name_taken'
      if (entry.claims[box]) return 'box_taken'
      entry.claims[box] = name
      return 'ok'
    },
  }
}

let backend: Backend | undefined
function store(): Backend {
  if (backend) return backend
  // Vercel's Upstash integration sets KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    backend = redisBackend(url, token)
  } else {
    if (process.env.VERCEL) {
      console.warn('[chama] No Redis credentials found — draws will NOT persist on Vercel.')
    }
    backend = memoryBackend()
  }
  return backend
}

/* ------------------------------------------------------------------ */
/* Draw logic                                                          */
/* ------------------------------------------------------------------ */

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Fisher–Yates shuffle using a cryptographically secure RNG. */
function secureShuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  return arr
}

export async function createDraw(opts: { title: string; mode: DrawMode; size: number }): Promise<DrawSession> {
  const raw =
    opts.mode === 'winner'
      ? ['YES', ...Array.from({ length: opts.size - 1 }, () => 'NO')]
      : Array.from({ length: opts.size }, (_, i) => String(i + 1))

  const values = secureShuffle(raw)
  const secret = randomBytes(8).toString('hex')
  const proof = [...values.map((v, i) => `Box${i + 1}:${v}`), `Secret:${secret}`].join(' | ')

  const sealed: SealedDraw = {
    id: randomBytes(6).toString('base64url'), // 8 URL-safe chars, 48 bits of randomness
    title: opts.title,
    mode: opts.mode,
    size: opts.size,
    values,
    secret,
    proof,
    hash: sha256(proof),
    createdAt: Date.now(),
  }
  await store().save(sealed)
  return toSession(sealed, {})
}

function toSession(d: SealedDraw, claims: Claims): DrawSession {
  return {
    id: d.id,
    title: d.title,
    mode: d.mode,
    size: d.size,
    secret: d.secret,
    proof: d.proof,
    hash: d.hash,
    createdAt: d.createdAt,
    boxes: d.values.map((value, i) => ({
      number: i + 1,
      value,
      claimedBy: claims[String(i + 1)] ?? null,
    })),
  }
}

export async function getDraw(id: string): Promise<DrawSession | undefined> {
  if (!/^[\w-]{1,32}$/.test(id)) return undefined
  const found = await store().load(id)
  return found ? toSession(found.draw, found.claims) : undefined
}

export async function claimBox(id: string, box: number, name: string): Promise<ClaimResult> {
  return store().claim(id, box, name)
}

export function isComplete(s: DrawSession): boolean {
  return s.boxes.every(b => b.claimedBy !== null)
}

/** What the browser is allowed to see: unpicked values stay hidden until everything is picked. */
export function toPublicDraw(s: DrawSession) {
  const complete = isComplete(s)
  return {
    id: s.id,
    title: s.title,
    mode: s.mode,
    size: s.size,
    hash: s.hash,
    createdAt: s.createdAt,
    expiresAt: s.createdAt + TTL_MS,
    complete,
    pickedCount: s.boxes.filter(b => b.claimedBy).length,
    proof: complete ? s.proof : null,
    boxes: s.boxes.map(b => ({
      number: b.number,
      claimedBy: b.claimedBy,
      value: b.claimedBy || complete ? b.value : null,
    })),
  }
}

export type PublicDraw = ReturnType<typeof toPublicDraw>
