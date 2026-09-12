let toggle;
export function bindLabsToggle(handler) {
    if (toggle)
        throw new Error('Labs provider toggle is already bound');
    toggle = handler;
    return () => { if (toggle === handler)
        toggle = undefined; };
}
export function toggleLabsProvider() {
    if (!toggle)
        throw new Error('Labs provider toggle is unavailable');
    return toggle();
}
