import { createHash, randomBytes, randomInt } from 'node:crypto'
import { Redis } from '@upstash/redis'
import IORedis from 'ioredis'

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
  readonly kind: 'upstash-rest' | 'redis-tcp' | 'memory'
  save(draw: SealedDraw): Promise<void>
  load(id: string): Promise<{ draw: SealedDraw; claims: Claims } | null>
  /** Must be atomic: two simultaneous claims on one box can never both succeed. */
  claim(id: string, box: number, name: string): Promise<ClaimResult>
}

const keysFor = (id: string) => ({
  draw: `chama:draw:${id}`,
  claims: `chama:draw:${id}:claims`,
  names: `chama:draw:${id}:names`,
})

/** HGETALL may come back as an object or as a flat [field, value, ...] array depending on the client. */
function toClaims(raw: unknown): Claims {
  if (!raw) return {}
  if (Array.isArray(raw)) {
    const out: Claims = {}
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1])
    return out
  }
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
}

/**
 * Upstash Redis over REST (Vercel Marketplace "Upstash", or upstash.com).
 * HSETNX makes the claim atomic across every serverless instance.
 */
function upstashBackend(url: string, token: string): Backend {
  const redis = new Redis({ url, token, automaticDeserialization: false })

  return {
    kind: 'upstash-rest',
    async save(draw) {
      await redis.set(keysFor(draw.id).draw, JSON.stringify(draw), { ex: TTL_SECONDS })
    },
    async load(id) {
      const k = keysFor(id)
      const [raw, claims] = await redis.pipeline().get(k.draw).hgetall(k.claims).exec<[unknown, unknown]>()
      if (!raw) return null
      return { draw: JSON.parse(String(raw)) as SealedDraw, claims: toClaims(claims) }
    },
    async claim(id, box, name) {
      const k = keysFor(id)
      // Reserve the name first so one person can't hold two boxes.
      if (!(await redis.hsetnx(k.names, name.toLowerCase(), String(box)))) return 'name_taken'
      if (!(await redis.hsetnx(k.claims, String(box), name))) {
        await redis.hdel(k.names, name.toLowerCase())
        return 'box_taken'
      }
      await redis.pipeline().expire(k.claims, TTL_SECONDS).expire(k.names, TTL_SECONDS).exec()
      return 'ok'
    },
  }
}

/** Any Redis reachable by URL (redis:// or rediss://), e.g. Vercel Marketplace "Redis". */
function tcpBackend(redisUrl: string): Backend {
  const redis = new IORedis(redisUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 8000,
    // Many managed Redis hosts need TLS but hand out redis:// URLs; rediss:// enables it explicitly.
    ...(redisUrl.startsWith('rediss://') ? { tls: {} } : {}),
  })
  redis.on('error', err => console.error('[chama] redis error:', err.message))

  return {
    kind: 'redis-tcp',
    async save(draw) {
      await redis.set(keysFor(draw.id).draw, JSON.stringify(draw), 'EX', TTL_SECONDS)
    },
    async load(id) {
      const k = keysFor(id)
      const res = await redis.pipeline().get(k.draw).hgetall(k.claims).exec()
      const [[e1, raw], [e2, claims]] = res as [[Error | null, unknown], [Error | null, unknown]]
      if (e1) throw e1
      if (e2) throw e2
      if (!raw) return null
      return { draw: JSON.parse(String(raw)) as SealedDraw, claims: toClaims(claims) }
    },
    async claim(id, box, name) {
      const k = keysFor(id)
      if (!(await redis.hsetnx(k.names, name.toLowerCase(), String(box)))) return 'name_taken'
      if (!(await redis.hsetnx(k.claims, String(box), name))) {
        await redis.hdel(k.names, name.toLowerCase())
        return 'box_taken'
      }
      await redis.pipeline().expire(k.claims, TTL_SECONDS).expire(k.names, TTL_SECONDS).exec()
      return 'ok'
    },
  }
}

/** In-memory Map: local development only. */
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
    kind: 'memory',
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

/** Find an env var by exact name or by suffix (Vercel lets you set a custom prefix, e.g. STORAGE_KV_REST_API_URL). */
function findEnv(...suffixes: string[]): { name: string; value: string } | undefined {
  const env = process.env
  for (const s of suffixes) if (env[s]) return { name: s, value: env[s]! }
  for (const s of suffixes) {
    const name = Object.keys(env).find(k => k.endsWith(`_${s}`) && env[k])
    if (name) return { name, value: env[name]! }
  }
  return undefined
}

let backend: Backend | undefined
let storageInfo = { kind: 'unconfigured' as Backend['kind'] | 'unconfigured', source: '' }

function store(): Backend {
  if (backend) return backend

  // 1. Upstash REST credentials.
  const restUrl = findEnv('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL')
  if (restUrl) {
    const tokenName = restUrl.name.replace(/URL$/, 'TOKEN')
    const token = process.env[tokenName] || findEnv('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN')?.value
    if (token) {
      backend = upstashBackend(restUrl.value, token)
      storageInfo = { kind: backend.kind, source: restUrl.name }
      return backend
    }
  }

  // 2. A plain Redis connection URL.
  const tcpUrl = findEnv('REDIS_URL', 'KV_URL')
  if (tcpUrl && /^rediss?:\/\//.test(tcpUrl.value)) {
    backend = tcpBackend(tcpUrl.value)
    storageInfo = { kind: backend.kind, source: tcpUrl.name }
    return backend
  }

  // 3. Nothing configured. Memory only works on a single long-running server, never on Vercel.
  if (process.env.VERCEL) {
    throw createError({
      statusCode: 503,
      message: 'Storage is not configured. Connect a Redis database to this Vercel project and redeploy.',
    })
  }
  backend = memoryBackend()
  storageInfo = { kind: backend.kind, source: 'in-process' }
  return backend
}

/** Used by /api/health: which storage is active, and does a round trip work? */
export async function checkStorage() {
  const started = Date.now()
  const b = store()
  await b.load('healthcheck')
  return { ...storageInfo, ok: true, latencyMs: Date.now() - started }
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
