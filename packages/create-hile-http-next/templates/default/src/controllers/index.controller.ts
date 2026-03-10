import { defineController } from "@hile/http"

export default defineController('GET', async ctx => {
  return 'Hello World'
})