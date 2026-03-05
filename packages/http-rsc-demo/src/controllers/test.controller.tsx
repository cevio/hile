import { defineController } from '@hile/http'
import { payload } from '../datasource.js'
import { Name } from '../client/name.js'

export default defineController('GET', async (ctx) => {
  const data = await payload();

  return <div>
    <h1>hello world</h1>
    <ul>
      {data.map(item => (
        <li key={item.id}>
          <a href="/">go back</a>
          <Name name={item.name}>hello {item.name} - 123</Name>
        </li>
      ))}
    </ul>
  </div>
})
