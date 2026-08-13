'use client';

import { useId, useState } from 'react';
import './isolation.css';

export default function IsolationWidget({ marker }: { marker: string }) {
  const id = useId();
  const [value, setValue] = useState(marker);
  return (
    <section className="isolation-widget" data-testid="isolation-client">
      <label htmlFor={id}>Independent client state</label>
      <input id={id} value={value} onChange={(event) => setValue(event.target.value)} />
      <output data-testid="isolation-value">{value}</output>
    </section>
  );
}
