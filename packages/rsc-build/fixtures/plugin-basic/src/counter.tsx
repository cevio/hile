'use client';

import React, { useEffect, useState } from 'react';
import { helperText } from './helper';
import { FixtureContext, useFixtureContext } from './context';
import { add } from './actions';
import './counter.css';

export function CounterLabel() {
  return React.createElement('span', null, useFixtureContext());
}

function InteractiveFixture({ initial }: { initial: number }) {
  const [count, setCount] = useState(initial);
  const contextValue = useFixtureContext();
  useEffect(() => {
    window.localStorage.setItem('counter', String(count));
  }, [count]);
  const loadLazy = () => import('./lazy').then(({ lazyText }) => lazyText);
  return React.createElement(
    'button',
    {
      className: 'counter',
      onClick: () => {
        setCount(count + 1);
        void add(count).then(({ value }) => window.localStorage.setItem('server-function', String(value)));
        void loadLazy().then((value) => window.localStorage.setItem('lazy-module', value));
      },
    },
    `${contextValue}:${count}`,
  );
}

export default function Counter({ initial }: { initial: number }) {
  return React.createElement(
    FixtureContext.Provider,
    { value: helperText },
    React.createElement(InteractiveFixture, { initial }),
  );
}
