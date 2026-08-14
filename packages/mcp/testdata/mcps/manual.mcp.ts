import { defineMcpResource } from '../../src/index.js';

export default defineMcpResource(
  { kind: 'static', name: 'manual', uri: 'hile://fixture/manual' },
  async () => ({ contents: [{ uri: 'hile://fixture/manual', text: 'manual' }] }),
);
