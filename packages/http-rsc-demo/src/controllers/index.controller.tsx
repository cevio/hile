import { defineController } from '@hile/http'
import { payload } from '../datasource.js'
import { Name } from '../client/name.js'

export default defineController('GET', async (ctx) => {
  const data = await payload();
  return <div>
    <h1>Hello RSC!</h1>
    <p>This is a Server Component</p>
    <ul>
      {data.map(item => (
        <li key={item.id}>
          <a href={`/test?id=${item.id}`}>{item.name}</a>
          <Name name={item.name}>id:{item.id}</Name>
        </li>
      ))}
    </ul>
  </div>
})
