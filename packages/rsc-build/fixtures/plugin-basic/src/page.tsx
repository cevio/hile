import React from 'react';
import Counter, { CounterLabel } from './counter';
import { add } from './actions';

export default async function Page() {
  return React.createElement(
    'section',
    null,
    React.createElement('h1', null, 'Plugin server page'),
    React.createElement(Counter, { initial: 1 }),
    React.createElement(CounterLabel, null),
    React.createElement('pre', null, String(typeof add)),
  );
}
