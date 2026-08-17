export const HILE_REMOTE_CLIENT_REFERENCE = '@hile/rsc/remote-client-boundary';
export const HILE_REMOTE_CLIENT_MODULE_ID = '__hile_rsc_remote_client_boundary__';
export const HILE_RSC_RUNTIME = Object.freeze({
  react: '19.2.8',
  reactDom: '19.2.8',
  rsc: '19.2.8',
} as const);

export const HILE_RSC_PLUGIN_METADATA_LIMITS = Object.freeze({
  displayNameLength: 120,
  descriptionLength: 500,
  navigationItems: 128,
  navigationIdLength: 64,
  navigationLabelLength: 120,
  navigationGroupLength: 120,
  navigationOrderMagnitude: 1_000_000,
} as const);
