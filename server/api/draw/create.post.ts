export default defineEventHandler(async (event) => {
  const body = await readBody<{ title?: unknown; mode?: unknown; size?: unknown }>(event)

  const mode = body?.mode === 'numbers' ? 'numbers' : 'winner'
  const size = Number(body?.size)
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 60) : ''

  if (!Number.isInteger(size) || size < MIN_BOXES || size > MAX_BOXES) {
    throw createError({
      statusCode: 400,
      message: `Number of boxes must be between ${MIN_BOXES} and ${MAX_BOXES}.`,
    })
  }

  const session = await createDraw({ title, mode, size })
  return { id: session.id, hash: session.hash }
})
