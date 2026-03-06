import React, { createElement, use } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { createFromFetch } from 'react-server-dom-webpack/client';

window.onload = () => {
  const container = document.getElementById('root');
  if (container) {
    hydrateRoot(container, createElement(App));
  }
}

function App() {
  const content = createFromFetch(
    fetch('/~' + window.location.pathname + window.location.search)
  );
  return createElement(React.Fragment, null, use(content));
}