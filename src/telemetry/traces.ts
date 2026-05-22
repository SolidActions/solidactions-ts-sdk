/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-require-imports */
import type { Span } from '@opentelemetry/sdk-trace-base';
import type { SpanContext } from '@opentelemetry/api';
import { TelemetryCollector } from './collector';
import { bootParams } from '../utils';
import type { BasicTracerProvider as BasicTracerProviderType } from '@opentelemetry/sdk-trace-base';

// As SolidActions OTLP is optional, OTLP objects must only be dynamically imported
// and only when OTLP is enabled. Importing OTLP types is fine as long
// as signatures using those types are not exported from this file.

interface Attributes {
  [attributeKey: string]: AttributeValue | undefined;
}
/**
 * Attribute values may be any non-nullish primitive value except an object.
 *
 * null or undefined attribute values are invalid and will result in undefined behavior.
 */
declare type AttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>;

export enum SpanStatusCode {
  /**
   * The default status.
   */
  UNSET = 0,
  /**
   * The operation has been validated by an Application developer or
   * Operator to have completed successfully.
   */
  OK = 1,
  /**
   * The operation contains an error.
   */
  ERROR = 2,
}

interface SpanStatus {
  /** The status code of this message. */
  code: SpanStatusCode;
  /** A developer-facing error message. */
  message?: string;
}

export type SolidActionsSpan = {
  setStatus(status: SpanStatus): SolidActionsSpan;
  attributes: Attributes;
  setAttribute(key: string, attribute: AttributeValue): SolidActionsSpan;
  addEvent(name: string, attributesOrStartTime?: Attributes, timeStamp?: number): SolidActionsSpan;
};

class StubSpan implements SolidActionsSpan {
  attributes: Attributes = {};

  setStatus(_status: SpanStatus): SolidActionsSpan {
    return this;
  }

  setAttribute(_key: string, _attribute: AttributeValue): SolidActionsSpan {
    return this;
  }

  addEvent(_name: string, _attributesOrStartTime?: Attributes, _timeStamp?: number): SolidActionsSpan {
    return this;
  }
}

export function runWithTrace<R>(span: SolidActionsSpan, func: () => Promise<R>): Promise<R> {
  if (!bootParams.enableOTLP) {
    return func();
  }
  const { context, trace } = require('@opentelemetry/api');
  return context.with(trace.setSpan(context.active(), span as Span), func);
}

export function getActiveSpan() {
  if (!bootParams.enableOTLP) {
    return undefined;
  }
  const { trace } = require('@opentelemetry/api');
  return trace.getActiveSpan() as SolidActionsSpan | undefined;
}

export function isTraceContextWorking(): boolean {
  if (!bootParams.enableOTLP) {
    return false;
  }
  const { context, trace } = require('@opentelemetry/api');
  const span = trace.getTracer('otel-bootstrap-check').startSpan('probe');
  const testContext = trace.setSpan(context.active(), span);

  let visible: boolean | undefined;
  context.with(testContext, () => {
    visible = trace.getSpan(context.active()) === span;
  });

  span.end?.();
  return visible === true;
}

export function installTraceContextManager(appName: string = 'solidactions'): void {
  if (!bootParams.enableOTLP) {
    return;
  }
  const { AsyncLocalStorageContextManager } = require('@opentelemetry/context-async-hooks');
  const { context, trace } = require('@opentelemetry/api');
  const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base');

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);

  const provider: BasicTracerProviderType = new BasicTracerProvider({
    resource: {
      attributes: {
        'service.name': appName,
      },
    },
  });
  trace.setGlobalTracerProvider(provider);
}

export class Tracer {
  readonly applicationID: string;
  readonly executorID: string;
  constructor(
    private readonly telemetryCollector: TelemetryCollector,
    appName: string = 'solidactions',
  ) {
    this.applicationID = bootParams.appID;
    this.executorID = bootParams.executorID; // for consistency with src/context.ts
    if (!bootParams.enableOTLP) {
      return;
    }
    const { trace } = require('@opentelemetry/api');
    const { BasicTracerProvider } = require('@opentelemetry/sdk-trace-base');

    const tracer: BasicTracerProviderType = new BasicTracerProvider({
      resource: {
        attributes: {
          'service.name': appName,
        },
      },
    });
    trace.setGlobalTracerProvider(tracer);
  }

  startSpanWithContext(spanContext: unknown, name: string, attributes?: Attributes): SolidActionsSpan {
    if (!bootParams.enableOTLP) {
      return new StubSpan();
    }
    const opentelemetry = require('@opentelemetry/api');
    const tracer = opentelemetry.trace.getTracer('solidactions-tracer');
    const ctx = opentelemetry.trace.setSpanContext(opentelemetry.context.active(), spanContext as SpanContext);
    return tracer.startSpan(name, { startTime: performance.now(), attributes: attributes }, ctx) as Span;
  }

  startSpan(name: string, attributes?: Attributes, inputSpan?: SolidActionsSpan): SolidActionsSpan {
    if (!bootParams.enableOTLP) {
      return new StubSpan();
    }
    const parentSpan = inputSpan as Span;
    const opentelemetry = require('@opentelemetry/api');
    const { hrTime } = require('@opentelemetry/core');
    const tracer = opentelemetry.trace.getTracer('solidactions-tracer');
    const startTime = hrTime(performance.now());
    if (parentSpan) {
      const ctx = opentelemetry.trace.setSpan(opentelemetry.context.active(), parentSpan);
      return tracer.startSpan(name, { startTime: startTime, attributes: attributes }, ctx) as Span;
    } else {
      return tracer.startSpan(name, { startTime: startTime, attributes: attributes }) as Span;
    }
  }

  endSpan(inputSpan: SolidActionsSpan) {
    if (!bootParams.enableOTLP) {
      return;
    }
    const { hrTime } = require('@opentelemetry/core');
    const span = inputSpan as Span;
    span.setAttributes({
      applicationID: this.applicationID,
      applicationVersion: bootParams.appVersion,
    });
    if (span.attributes && !('executorID' in span.attributes)) {
      span.setAttribute('executorID', this.executorID);
    }
    span.end(hrTime(performance.now()));
    this.telemetryCollector.push(span);
  }
}
