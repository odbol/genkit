/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  Action,
  defineAction,
  FlowError,
  FlowState,
  FlowStateSchema,
  FlowStateStore,
  getStreamingCallback,
  config as globalConfig,
  isDevEnv,
  Operation,
  StreamingCallback,
} from '@genkit-ai/core';
import { logger } from '@genkit-ai/core/logging';
import { initializeAllPlugins } from '@genkit-ai/core/registry';
import { toJsonSchema } from '@genkit-ai/core/schema';
import {
  newTrace,
  setCustomMetadataAttribute,
  setCustomMetadataAttributes,
  SPAN_TYPE_ATTR,
} from '@genkit-ai/core/tracing';
import { SpanStatusCode } from '@opentelemetry/api';
import * as bodyParser from 'body-parser';
import { default as cors, CorsOptions } from 'cors';
import express from 'express';
import { performance } from 'node:perf_hooks';
import * as z from 'zod';
import { Context } from './context.js';
import {
  FlowExecutionError,
  FlowStillRunningError,
  getErrorMessage,
  getErrorStack,
  InterruptError,
} from './errors.js';
import * as telemetry from './telemetry.js';
import {
  FlowActionInputSchema,
  FlowInvokeEnvelopeMessage,
  FlowInvokeEnvelopeMessageSchema,
  Invoker,
  RetryConfig,
  Scheduler,
} from './types.js';
import {
  generateFlowId,
  metadataPrefix,
  runWithActiveContext,
} from './utils.js';

const streamDelimiter = '\n';

const CREATED_FLOWS = 'genkit__CREATED_FLOWS';

function createdFlows(): Flow<any, any, any>[] {
  if (global[CREATED_FLOWS] === undefined) {
    global[CREATED_FLOWS] = [];
  }
  return global[CREATED_FLOWS];
}

/**
 * Step configuration for retries, etc.
 */
export interface RunStepConfig {
  name: string;
  retryConfig?: RetryConfig;
}

/**
 * Flow Auth policy. Consumes the authorization context of the flow and
 * performs checks before the flow runs. If this throws, the flow will not
 * be executed.
 */
export interface FlowAuthPolicy<I extends z.ZodTypeAny = z.ZodTypeAny> {
  (auth: any | undefined, input: z.infer<I>): void | Promise<void>;
}

/**
 * For express-based flows, req.auth should contain the value to bepassed into
 * the flow context.
 */
export interface __RequestWithAuth extends express.Request {
  auth?: unknown;
}

/**
 * Base configuration for a flow.
 */
export interface BaseFlowConfig<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Name of the flow. */
  name: string;
  /** Schema of the input to the flow. */
  inputSchema?: I;
  /** Schema of the output from the flow. */
  outputSchema?: O;
  /** Auth policy. */
  authPolicy?: FlowAuthPolicy<I>;
  /** Middleware for HTTP requests. Not called for direct invocations. */
  middleware?: express.RequestHandler[];
  /** Invoker for the flow. Defaults to local dispatcher. */
  invoker?: Invoker<I, O, S>;
}

/**
 * Configuration for a non-streaming flow.
 */
export interface FlowConfig<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> extends BaseFlowConfig<I, O, z.ZodVoid> {
  /** Experimental. Whether the flow is durable. */
  experimentalDurable?: boolean;
  /** Experimental. Scheduler for a durable flow. `experimentalDurable` must be true. */
  experimentalScheduler?: Scheduler<I, O>;
}

/**
 * Configuration for a streaming flow.
 */
export interface StreamingFlowConfig<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> extends BaseFlowConfig<I, O, S> {
  /** Schema of the streaming chunks from the flow. */
  streamSchema?: S;
}

/**
 * Non-streaming flow that can be called directly like a function.
 */
export interface CallableFlow<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  (
    input?: z.infer<I>,
    opts?: { withLocalAuthContext?: unknown }
  ): Promise<z.infer<O>>;
  flow: Flow<I, O, z.ZodVoid>;
}

/**
 * Streaming flow that can be called directly like a function.
 */
export interface StreamableFlow<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> {
  (
    input?: z.infer<I>,
    opts?: { withLocalAuthContext?: unknown }
  ): StreamingResponse<O, S>;
  flow: Flow<I, O, S>;
}

/**
 * Response from a streaming flow.
 */
interface StreamingResponse<
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Iterator over the streaming chunks. */
  stream: AsyncGenerator<unknown, Operation, z.infer<S> | undefined>;
  /** Final output of the flow. */
  output: Promise<z.infer<O>>;
}

/**
 * Function to be executed in the flow.
 */
export type StepsFunction<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> = (
  /** Input to the flow. */
  input: z.infer<I>,
  /** Callback for streaming functions only. */
  streamingCallback?: S extends z.ZodVoid
    ? undefined
    : StreamingCallback<z.infer<S>>
) => Promise<z.infer<O>>;

/**
 * Defines a non-streaming flow.
 */
export function defineFlow<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
>(
  config: FlowConfig<I, O>,
  steps: StepsFunction<I, O, z.ZodVoid>
): CallableFlow<I, O> {
  const f = new Flow<I, O, z.ZodVoid>(
    {
      ...config,
      stateStore: globalConfig
        ? () => globalConfig.getFlowStateStore()
        : undefined,
      // We always use local dispatcher in dev mode or when one is not provided.
      invoker: async (flow, msg) => {
        if (!isDevEnv() && config.invoker) {
          return config.invoker(flow, msg);
        }
        const state = await flow.runEnvelope(msg);
        return state.operation;
      },
      scheduler: async (flow, msg, delay = 0) => {
        if (!config.experimentalDurable) {
          throw new Error(
            'This flow is not durable, cannot use scheduling features.'
          );
        }
        if (!isDevEnv() && config.experimentalScheduler) {
          return config.experimentalScheduler(flow, msg, delay);
        }
        setTimeout(() => flow.runEnvelope(msg), delay * 1000);
      },
    },
    steps
  );
  createdFlows().push(f);
  wrapAsAction(f);
  const callableFlow: CallableFlow<I, O> = async (input, opts) => {
    return f.run(input, opts);
  };
  callableFlow.flow = f;
  return callableFlow;
}

/**
 * Defines a streaming flow.
 */
export function defineStreamingFlow<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
>(
  config: StreamingFlowConfig<I, O, S>,
  steps: StepsFunction<I, O, S>
): StreamableFlow<I, O, S> {
  const f = new Flow(
    {
      ...config,
      stateStore: globalConfig
        ? () => globalConfig.getFlowStateStore()
        : undefined,
      // We always use local dispatcher in dev mode or when one is not provided.
      invoker: async (flow, msg, streamingCallback) => {
        if (!isDevEnv() && config.invoker) {
          return config.invoker(flow, msg, streamingCallback);
        }
        const state = await flow.runEnvelope(msg, streamingCallback);
        return state.operation;
      },
    },
    steps
  );
  createdFlows().push(f);
  wrapAsAction(f);
  const streamableFlow: StreamableFlow<I, O, S> = (input, opts) => {
    return f.stream(input, opts);
  };
  streamableFlow.flow = f;
  return streamableFlow;
}

export class Flow<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly name: string;
  readonly inputSchema?: I;
  readonly outputSchema?: O;
  readonly streamSchema?: S;
  readonly stateStore?: () => Promise<FlowStateStore>;
  readonly invoker: Invoker<I, O, S>;
  readonly scheduler?: S extends z.ZodVoid ? Scheduler<I, O> : undefined;
  readonly experimentalDurable: boolean;
  readonly authPolicy?: FlowAuthPolicy<I>;
  readonly middleware?: express.RequestHandler[];

  constructor(
    config: {
      name: string;
      inputSchema?: I;
      outputSchema?: O;
      streamSchema?: S;
      stateStore?: () => Promise<FlowStateStore>;
      invoker: Invoker<I, O, S>;
      scheduler?: S extends z.ZodVoid ? Scheduler<I, O> : undefined;
      experimentalDurable?: boolean;
      authPolicy?: FlowAuthPolicy<I>;
      middleware?: express.RequestHandler[];
    },
    private steps: StepsFunction<I, O, S>
  ) {
    this.name = config.name;
    this.inputSchema = config.inputSchema;
    this.outputSchema = config.outputSchema;
    this.streamSchema = config.streamSchema;
    this.stateStore = config.stateStore;
    this.invoker = config.invoker;
    this.scheduler = config.scheduler;
    this.experimentalDurable = config.experimentalDurable ?? false;
    this.authPolicy = config.authPolicy;
    this.middleware = config.middleware;

    // Durable flows can't use an auth policy; instead they should be invoked
    // from a privileged context after ACL checks are performed.
    if (this.authPolicy && this.experimentalDurable) {
      throw new Error('Durable flows can not define auth policies.');
    }
  }

  /**
   * Executes the flow with the input directly.
   *
   * This will either be called by runEnvelope when starting durable flows,
   * or it will be called directly when starting non-durable flows.
   */
  async runDirectly(
    input: unknown,
    opts: {
      streamingCallback?: S extends z.ZodVoid
        ? undefined
        : StreamingCallback<z.infer<S>>;
      labels?: Record<string, string>;
      auth?: unknown;
    }
  ): Promise<FlowState> {
    const flowId = generateFlowId();
    const state = createNewState(flowId, this.name, input);
    const ctx = new Context(this, flowId, state, opts.auth);
    try {
      await this.executeSteps(
        ctx,
        this.steps,
        'start',
        opts.streamingCallback,
        opts.labels
      );
    } finally {
      if (isDevEnv() || this.experimentalDurable) {
        await ctx.saveState();
      }
    }
    return state;
  }

  /**
   * Executes the flow with the input in the envelope format.
   */
  async runEnvelope(
    req: FlowInvokeEnvelopeMessage,
    streamingCallback?: S extends z.ZodVoid
      ? undefined
      : StreamingCallback<z.infer<S>>,
    auth?: unknown
  ): Promise<FlowState> {
    logger.debug(req, 'runEnvelope');
    if (req.start) {
      // First time, create new state.
      return this.runDirectly(req.start.input, {
        streamingCallback,
        auth,
        labels: req.start.labels,
      });
    }
    if (req.schedule) {
      if (!this.experimentalDurable) {
        throw new Error('Cannot schedule a non-durable flow');
      }
      if (!this.stateStore) {
        throw new Error(
          'Flow state store for durable flows must be configured'
        );
      }
      // First time, create new state.
      const flowId = generateFlowId();
      const state = createNewState(flowId, this.name, req.schedule.input);
      try {
        await (await this.stateStore()).save(flowId, state);
        await this.scheduler?.(
          this as unknown as Flow<I, O, z.ZodVoid>, // TODO: Fix this hack?
          { runScheduled: { flowId } } as FlowInvokeEnvelopeMessage,
          req.schedule.delay
        );
      } catch (e) {
        state.operation.done = true;
        state.operation.result = {
          error: getErrorMessage(e),
          stacktrace: getErrorStack(e),
        };
        await (await this.stateStore()).save(flowId, state);
      }
      return state;
    }
    if (req.state) {
      if (!this.experimentalDurable) {
        throw new Error('Cannot state check a non-durable flow');
      }
      if (!this.stateStore) {
        throw new Error(
          'Flow state store for durable flows must be configured'
        );
      }
      const flowId = req.state.flowId;
      const state = await (await this.stateStore()).load(flowId);
      if (state === undefined) {
        throw new Error(`Unable to find flow state for ${flowId}`);
      }
      return state;
    }
    if (req.runScheduled) {
      if (!this.experimentalDurable) {
        throw new Error('Cannot run scheduled non-durable flow');
      }
      if (!this.stateStore) {
        throw new Error(
          'Flow state store for durable flows must be configured'
        );
      }
      const flowId = req.runScheduled.flowId;
      const state = await (await this.stateStore()).load(flowId);
      if (state === undefined) {
        throw new Error(`Unable to find flow state for ${flowId}`);
      }
      const ctx = new Context(this, flowId, state);
      try {
        await this.executeSteps(
          ctx,
          this.steps,
          'runScheduled',
          undefined,
          undefined
        );
      } finally {
        await ctx.saveState();
      }
      return state;
    }
    if (req.resume) {
      if (!this.experimentalDurable) {
        throw new Error('Cannot resume a non-durable flow');
      }
      if (!this.stateStore) {
        throw new Error(
          'Flow state store for durable flows must be configured'
        );
      }
      const flowId = req.resume.flowId;
      const state = await (await this.stateStore()).load(flowId);
      if (state === undefined) {
        throw new Error(`Unable to find flow state for ${flowId}`);
      }
      if (!state.blockedOnStep) {
        throw new Error(
          "Unable to resume flow that's currently not interrupted"
        );
      }
      state.eventsTriggered[state.blockedOnStep.name] = req.resume.payload;
      const ctx = new Context(this, flowId, state);
      try {
        await this.executeSteps(
          ctx,
          this.steps,
          'resume',
          undefined,
          undefined
        );
      } finally {
        await ctx.saveState();
      }
      return state;
    }
    // TODO: add retry

    throw new Error(
      'Unexpected envelope message case, must set one of: ' +
        'start, schedule, runScheduled, resume, retry, state'
    );
  }

  /**
   * Runs the flow. This is used when calling a flow from another flow.
   */
  async run(
    payload?: z.infer<I>,
    opts?: { withLocalAuthContext?: unknown }
  ): Promise<z.infer<O>> {
    const input = this.inputSchema ? this.inputSchema.parse(payload) : payload;
    await this.authPolicy?.(opts?.withLocalAuthContext, payload);

    if (this.middleware) {
      logger.warn(
        `Flow (${this.name}) middleware won't run when invoked with runFlow.`
      );
    }

    const state = await this.runEnvelope({
      start: {
        input,
      },
    });
    if (!state.operation.done) {
      throw new FlowStillRunningError(
        `Flow ${state.name} did not finish execution.`
      );
    }
    if (state.operation.result?.error) {
      throw new FlowExecutionError(
        state.operation.name,
        state.operation.result?.error,
        state.operation.result?.stacktrace
      );
    }
    return state.operation.result?.response;
  }

  /**
   * Runs the flow and streams results. This is used when calling a flow from another flow.
   */
  stream(
    payload?: z.infer<I>,
    opts?: { withLocalAuthContext?: unknown }
  ): StreamingResponse<O, S> {
    let chunkStreamController: ReadableStreamController<z.infer<S>>;
    const chunkStream = new ReadableStream<z.infer<S>>({
      start(controller) {
        chunkStreamController = controller;
      },
      pull() {},
      cancel() {},
    });

    const authPromise =
      this.authPolicy?.(opts?.withLocalAuthContext, payload) ??
      Promise.resolve();

    const operationPromise = authPromise
      .then(() =>
        this.runEnvelope(
          {
            start: {
              input: this.inputSchema
                ? this.inputSchema.parse(payload)
                : payload,
            },
          },
          ((chunk: z.infer<S>) => {
            chunkStreamController.enqueue(chunk);
          }) as S extends z.ZodVoid ? undefined : StreamingCallback<z.infer<S>>
        )
      )
      .then((s) => s.operation);
    operationPromise.then((o) => {
      chunkStreamController.close();
      return o;
    });

    return {
      output: operationPromise.then((op) => {
        if (!op.done) {
          throw new FlowStillRunningError(
            `flow ${op.name} did not finish execution`
          );
        }
        if (op.result?.error) {
          throw new FlowExecutionError(
            op.name,
            op.result?.error,
            op.result?.stacktrace
          );
        }
        return op.result?.response;
      }),
      stream: (async function* () {
        const reader = chunkStream.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.value) {
            yield chunk.value;
          }
          if (chunk.done) {
            break;
          }
        }
        return await operationPromise;
      })(),
    };
  }

  // TODO: refactor me... this is a mess!
  private async executeSteps(
    ctx: Context<I, O, S>,
    handler: StepsFunction<I, O, S>,
    dispatchType: string,
    streamingCallback?: S extends z.ZodVoid
      ? undefined
      : StreamingCallback<z.infer<S>>,
    labels?: Record<string, string>
  ) {
    const startTimeMs = performance.now();
    await initializeAllPlugins();
    await runWithActiveContext(ctx, async () => {
      let traceContext;
      if (ctx.state.traceContext) {
        traceContext = JSON.parse(ctx.state.traceContext);
      }
      let ctxLinks = traceContext ? [{ context: traceContext }] : [];
      let errored = false;
      const output = await newTrace(
        {
          name: ctx.flow.name,
          labels: {
            [SPAN_TYPE_ATTR]: 'flow',
          },
          links: ctxLinks,
        },
        async (metadata, rootSpan) => {
          ctx.state.executions.push({
            startTime: Date.now(),
            traceIds: [],
          });
          setCustomMetadataAttribute(
            metadataPrefix(`execution`),
            (ctx.state.executions.length - 1).toString()
          );
          if (labels) {
            Object.keys(labels).forEach((label) => {
              setCustomMetadataAttribute(
                metadataPrefix(`label:${label}`),
                labels[label]
              );
            });
          }

          setCustomMetadataAttributes({
            [metadataPrefix('name')]: this.name,
            [metadataPrefix('id')]: ctx.flowId,
          });
          ctx
            .getCurrentExecution()
            .traceIds.push(rootSpan.spanContext().traceId);
          // Save the trace in the state so that we can tie subsequent invocation together.
          if (!traceContext) {
            ctx.state.traceContext = JSON.stringify(rootSpan.spanContext());
          }
          setCustomMetadataAttribute(
            metadataPrefix('dispatchType'),
            dispatchType
          );
          try {
            const input = this.inputSchema
              ? this.inputSchema.parse(ctx.state.input)
              : ctx.state.input;
            metadata.input = input;
            const output = await handler(input, streamingCallback);
            metadata.output = JSON.stringify(output);
            setCustomMetadataAttribute(metadataPrefix('state'), 'done');
            telemetry.writeFlowSuccess(
              ctx.flow.name,
              performance.now() - startTimeMs
            );
            return output;
          } catch (e) {
            if (e instanceof InterruptError) {
              setCustomMetadataAttribute(
                metadataPrefix('state'),
                'interrupted'
              );
              // Log interrupted
            } else {
              metadata.state = 'error';
              rootSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: getErrorMessage(e),
              });
              if (e instanceof Error) {
                rootSpan.recordException(e);
              }

              setCustomMetadataAttribute(metadataPrefix('state'), 'error');
              ctx.state.operation.done = true;
              ctx.state.operation.result = {
                error: getErrorMessage(e),
                stacktrace: getErrorStack(e),
              } as FlowError;

              telemetry.recordError(e);
              telemetry.writeFlowFailure(
                ctx.flow.name,
                performance.now() - startTimeMs,
                e
              );
            }
            errored = true;
          }
        }
      );
      if (!errored) {
        // flow done, set response.
        ctx.state.operation.done = true;
        ctx.state.operation.result = { response: output };
      }
    });
  }

  private async durableExpressHandler(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    telemetry.logRequest(this.name, req);
    if (req.query.stream === 'true') {
      const respBody = {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'Output from durable flows cannot be streamed',
        },
      };
      res.status(400).send(respBody).end();
      telemetry.logResponse(this.name, 400, respBody);
      return;
    }

    let data = req.body;
    // Task queue will wrap body in a "data" object, unwrap it.
    if (req.body.data) {
      data = req.body.data;
    }
    const envMsg = FlowInvokeEnvelopeMessageSchema.parse(data);
    try {
      const state = await this.runEnvelope(envMsg);
      res.status(200).send(state.operation).end();
      telemetry.logResponse(this.name, 200, state.operation);
    } catch (e) {
      // Pass errors as operations instead of a standard API error
      // (https://cloud.google.com/apis/design/errors#http_mapping)
      telemetry.recordError(e);
      const respBody = {
        done: true,
        result: {
          error: getErrorMessage(e),
          stacktrace: getErrorStack(e),
        },
      };
      res
        .status(500)
        .send(respBody as Operation)
        .end();
      telemetry.logResponse(this.name, 500, respBody);
    }
  }

  private async nonDurableExpressHandler(
    req: __RequestWithAuth,
    res: express.Response
  ): Promise<void> {
    telemetry.logRequest(this.name, req);
    const { stream } = req.query;
    const auth = req.auth;

    let input = req.body.data;

    try {
      await this.authPolicy?.(auth, input);
    } catch (e: any) {
      telemetry.recordError(e);
      const respBody = {
        error: {
          status: 'PERMISSION_DENIED',
          message: e.message || 'Permission denied to resource',
        },
      };
      res.status(403).send(respBody).end();
      telemetry.logResponse(this.name, 403, respBody);
      return;
    }

    if (stream === 'true') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Transfer-Encoding': 'chunked',
      });
      try {
        const state = await this.runDirectly(input, {
          streamingCallback: ((chunk: z.infer<S>) => {
            res.write(JSON.stringify(chunk) + streamDelimiter);
          }) as S extends z.ZodVoid ? undefined : StreamingCallback<z.infer<S>>,
          auth,
        });
        res.write(JSON.stringify(state.operation));
        res.end();
        telemetry.logResponse(this.name, 200, state.operation);
      } catch (e) {
        // Errors while streaming are also passed back as operations
        telemetry.recordError(e);
        const respBody = {
          done: true,
          result: {
            error: getErrorMessage(e),
            stacktrace: getErrorStack(e),
          },
        };
        res.write(JSON.stringify(respBody as Operation));
        res.end();
        telemetry.logResponse(this.name, 500, respBody);
      }
    } else {
      try {
        const state = await this.runDirectly(input, { auth });
        if (state.operation.result?.error) {
          throw new Error(state.operation.result?.error);
        }
        // Responses for non-streaming, non-durable flows are passed back
        // with the flow result stored in a field called "result."
        res
          .status(200)
          .send({
            result: state.operation.result?.response,
          })
          .end();
        telemetry.logResponse(this.name, 200, state.operation);
      } catch (e) {
        // Errors for non-durable, non-streaming flows are passed back as
        // standard API errors.
        telemetry.recordError(e);
        res
          .status(500)
          .send({
            error: {
              status: 'INTERNAL',
              message: getErrorMessage(e),
              details: getErrorStack(e),
            },
          })
          .end();
      }
    }
  }

  get expressHandler(): (
    req: __RequestWithAuth,
    res: express.Response
  ) => Promise<void> {
    return this.experimentalDurable
      ? this.durableExpressHandler.bind(this)
      : this.nonDurableExpressHandler.bind(this);
  }
}

function createNewState(
  flowId: string,
  name: string,
  input: unknown
): FlowState {
  return {
    flowId: flowId,
    name: name,
    startTime: Date.now(),
    input: input,
    cache: {},
    eventsTriggered: {},
    blockedOnStep: null,
    executions: [],
    operation: {
      name: flowId,
      done: false,
    },
  };
}

function wrapAsAction<
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
  S extends z.ZodTypeAny = z.ZodTypeAny,
>(
  flow: Flow<I, O, S>
): Action<typeof FlowActionInputSchema, typeof FlowStateSchema> {
  return defineAction(
    {
      actionType: 'flow',
      name: flow.name,
      inputSchema: FlowActionInputSchema,
      outputSchema: FlowStateSchema,
      metadata: {
        inputSchema: toJsonSchema({ schema: flow.inputSchema }),
        outputSchema: toJsonSchema({ schema: flow.outputSchema }),
        experimentalDurable: !!flow.experimentalDurable,
        requiresAuth: !!flow.authPolicy,
      },
    },
    async (envelope) => {
      // Only non-durable flows have an authPolicy, so envelope.start should always
      // be defined here.
      await flow.authPolicy?.(
        envelope.auth,
        envelope.start?.input as I | undefined
      );
      setCustomMetadataAttribute(metadataPrefix('wrapperAction'), 'true');
      return await flow.runEnvelope(
        envelope,
        getStreamingCallback() as S extends z.ZodVoid
          ? undefined
          : StreamingCallback<z.infer<S>>,
        envelope.auth
      );
    }
  );
}

/**
 * Start the flows server.
 */
export function startFlowsServer(params?: {
  flows?: Flow<any, any, any>[];
  port?: number;
  cors?: CorsOptions;
  pathPrefix?: string;
  jsonParserOptions?: bodyParser.OptionsJson;
}) {
  const port =
    params?.port || (process.env.PORT ? parseInt(process.env.PORT) : 0) || 3400;
  const pathPrefix = params?.pathPrefix ?? '';
  const app = express();
  app.use(bodyParser.json(params?.jsonParserOptions));
  app.use(cors(params?.cors));

  const flows = params?.flows || createdFlows();
  logger.info(`Starting flows server on port ${port}`);
  flows.forEach((f) => {
    const flowPath = `/${pathPrefix}${f.name}`;
    logger.info(` - ${flowPath}`);
    // Add middlware
    f.middleware?.forEach((m) => {
      app.post(flowPath, m);
    });
    app.post(flowPath, f.expressHandler);
  });

  app.listen(port, () => {
    console.log(`Flows server listening on port ${port}`);
  });
}
