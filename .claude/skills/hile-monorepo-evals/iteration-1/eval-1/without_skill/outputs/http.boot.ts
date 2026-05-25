import { defineService } from '@hile/core'
import { Http } from '@hile/http'

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: 4000 })

  await http.load('./src/controllers', { suffix: 'controller' })

  const close = await http.listen()
  shutdown(close)
})
