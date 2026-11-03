export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') ?? ''
  const body = await readBody<{ boxNumber?: unknown; memberName?: unknown }>(event)

  const session = await getDraw(id)
  if (!session) {
    throw createError({ statusCode: 404, message: 'Draw not found or expired.' })
  }

  const boxNumber = Number(body?.boxNumber)
  const memberName =
    typeof body?.memberName === 'string' ? body.memberName.trim().replace(/\s+/g, ' ').slice(0, 30) : ''

  if (!memberName) {
    throw createError({ statusCode: 400, message: 'Please enter your name.' })
  }

  const box = session.boxes.find(b => b.number === boxNumber)
  if (!box) {
    throw createError({ statusCode: 400, message: 'That box does not exist.' })
  }

  // Fast path for the common case; the atomic claim below is the real guard.
  if (box.claimedBy) {
    throw createError({ statusCode: 409, message: 'Already picked!' })
  }

  const result = await claimBox(id, boxNumber, memberName)
  if (result === 'box_taken') {
    throw createError({ statusCode: 409, message: 'Already picked!' })
  }
  if (result === 'name_taken') {
    throw createError({
      statusCode: 409,
      message: "That name has already picked. Add your initial if it's a different person.",
    })
  }

  return {
    boxNumber: box.number,
    claimedBy: memberName,
    value: box.value,
  }
})
