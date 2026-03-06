import React, { createElement, use } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-ignore
import { createFromFetch } from 'react-server-dom-webpack/client';

window.onload = () => {
  const container = document.getElementById('root');
  if (!container) return;

  // hydrateRoot(container, createElement(App as any));
  // hydrateRoot(container, createElement(Fragment));
  createRoot(container).render(createElement(App));
}

function App(): React.ReactNode {
  const content = createFromFetch(
    fetch('/~' + window.location.pathname + window.location.search)
  );
  return use(content);
}