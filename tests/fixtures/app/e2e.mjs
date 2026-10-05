// Hits the server started as background process by the extra-tests entry.
const res = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/api/health`)
const body = await res.json()
if (body.status !== 'ok') throw new Error(`unexpected health: ${JSON.stringify(body)}`)
console.log('e2e ok')
