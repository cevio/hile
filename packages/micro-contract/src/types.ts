import type { ExecutionContext } from '@hile/context';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type MicroOperation = Readonly<{
  path: string;
  input: StandardSchemaV1;
  output: StandardSchemaV1;
}>;

export type MicroContract<
  Operations extends Record<string, MicroOperation> = Record<string, MicroOperation>,
> = Readonly<{
  namespace: string;
  operations: Readonly<Operations>;
}>;

export type MicroCallOptions = Readonly<{
  context: ExecutionContext;
  signal?: AbortSignal;
  timeout?: number;
  retries?: number;
}>;

export interface MicroCaller {
  call(namespace: string, path: string, data: unknown, options: MicroCallOptions): Promise<unknown>;
}

export type MicroClient<Contract extends MicroContract, Options = MicroCallOptions> = {
  readonly [Key in keyof Contract['operations']]: (
    input: StandardSchemaV1.InferInput<Contract['operations'][Key]['input']>,
    options: Options,
  ) => Promise<StandardSchemaV1.InferOutput<Contract['operations'][Key]['output']>>;
};

export type MicroContractPhase =
  | 'client_request'
  | 'provider_request'
  | 'provider_response'
  | 'client_response';

export type MicroContractErrorKind = 'validation' | 'schema' | 'wire';

export type MicroOperationMetadata = Readonly<{
  namespace: string;
  key: string;
  path: string;
  contract: MicroContract;
}>;
