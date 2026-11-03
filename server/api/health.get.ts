// Shows which storage the app is using (never the credentials). Open /api/health on the live site.
export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  try {
    return await checkStorage()
  } catch (e: any) {
    setResponseStatus(event, 503)
    return { ok: false, error: e?.message || String(e) }
  }
})
