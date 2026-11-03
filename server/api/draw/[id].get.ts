export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const session = await getDraw(id)

  if (!session) {
    throw createError({ statusCode: 404, message: 'Draw not found or expired.' })
  }

  setResponseHeader(event, 'Cache-Control', 'no-store')
  // Never return the raw session: unpicked values and the secret are stripped here.
  return toPublicDraw(session)
})
