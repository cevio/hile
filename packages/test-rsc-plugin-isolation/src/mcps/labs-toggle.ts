let toggle: (() => Promise<boolean>) | undefined;

export function bindLabsToggle(handler: () => Promise<boolean>) {
  if (toggle) throw new Error('Labs provider toggle is already bound');
  toggle = handler;
  return () => { if (toggle === handler) toggle = undefined; };
}

export function toggleLabsProvider() {
  if (!toggle) throw new Error('Labs provider toggle is unavailable');
  return toggle();
}
