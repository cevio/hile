'use client';

import { useState } from 'react';

export default function InteractiveBoundary({ initialValue, buildId }: { initialValue: number; buildId: string }) {
  const [value, setValue] = useState(initialValue);
  return <button data-build-id={buildId} onClick={() => setValue((current) => current + 1)}>{value}</button>;
}
