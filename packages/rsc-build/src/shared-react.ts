import type { Plugin } from 'esbuild';

/** Public named exports provided by the pinned React runtime. */
export const HILE_RSC_SHARED_REACT_EXPORTS = [
  'Activity', 'Children', 'Component', 'Fragment', 'Profiler', 'PureComponent',
  'StrictMode', 'Suspense', 'act', 'cache', 'cacheSignal', 'captureOwnerStack',
  'cloneElement', 'createContext', 'createElement', 'createRef', 'forwardRef',
  'isValidElement', 'lazy', 'memo', 'startTransition', 'unstable_useCacheRefresh',
  'use', 'useActionState', 'useCallback', 'useContext', 'useDebugValue',
  'useDeferredValue', 'useEffect', 'useEffectEvent', 'useId', 'useImperativeHandle',
  'useInsertionEffect', 'useLayoutEffect', 'useMemo', 'useOptimistic', 'useReducer',
  'useRef', 'useState', 'useSyncExternalStore', 'useTransition', 'version',
] as const;

/** Public named exports provided by the pinned ReactDOM runtime. */
export const HILE_RSC_SHARED_REACT_DOM_EXPORTS = [
  'createPortal', 'flushSync', 'preconnect', 'prefetchDNS', 'preinit',
  'preinitModule', 'preload', 'preloadModule', 'requestFormReset',
  'unstable_batchedUpdates', 'useFormState', 'useFormStatus', 'version',
] as const;

/** Public named exports provided by the pinned ReactDOM client runtime. */
export const HILE_RSC_SHARED_REACT_DOM_CLIENT_EXPORTS = [
  'createRoot', 'hydrateRoot', 'version',
] as const;

export function createSharedReactPlugin(): Plugin {
  return {
    name: 'hile-rsc-shared-react',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hile-react' }));
      build.onResolve({ filter: /^react\/jsx-(?:runtime|dev-runtime)$/ }, (args) => ({
        path: args.path,
        namespace: 'hile-react-jsx',
      }));
      build.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'react-dom', namespace: 'hile-react-dom' }));
      build.onResolve({ filter: /^react-dom\/client$/ }, () => ({
        path: 'react-dom/client',
        namespace: 'hile-react-dom-client',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hile-react' }, () => ({
        contents: [
          `const React = globalThis.__HILE_RSC_REACT__;`,
          `if (!React) throw new Error('Hile RSC host did not install the shared React runtime');`,
          `export default React;`,
          ...HILE_RSC_SHARED_REACT_EXPORTS.map((name) => `export const ${name} = React.${name};`),
        ].join('\n'),
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hile-react-jsx' }, () => ({
        contents: `
          const Runtime = globalThis.__HILE_RSC_JSX_RUNTIME__;
          if (!Runtime) throw new Error('Hile RSC host did not install the shared JSX runtime');
          export const Fragment = Runtime.Fragment;
          export const jsx = Runtime.jsx;
          export const jsxs = Runtime.jsxs;
          export const jsxDEV = Runtime.jsxDEV;
        `,
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hile-react-dom' }, () => ({
        contents: [
          `const ReactDom = globalThis.__HILE_RSC_REACT_DOM__;`,
          `if (!ReactDom) throw new Error('Hile RSC host did not install the shared ReactDOM runtime');`,
          `export default ReactDom;`,
          ...HILE_RSC_SHARED_REACT_DOM_EXPORTS.map((name) => `export const ${name} = ReactDom.${name};`),
        ].join('\n'),
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hile-react-dom-client' }, () => ({
        contents: [
          `const ReactDomClient = globalThis.__HILE_RSC_REACT_DOM_CLIENT__;`,
          `if (!ReactDomClient) throw new Error('Hile RSC host did not install the shared ReactDOM client runtime');`,
          `export default ReactDomClient;`,
          ...HILE_RSC_SHARED_REACT_DOM_CLIENT_EXPORTS.map((name) => `export const ${name} = ReactDomClient.${name};`),
        ].join('\n'),
        loader: 'js',
      }));
    },
  };
}
