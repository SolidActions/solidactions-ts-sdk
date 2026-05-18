/**
 * Mock HTTP Server for SolidActions SDK Testing & Local Development
 *
 * Provides an in-memory HTTP server that implements the SolidActions API
 * for testing and running workflows locally without a real backend.
 *
 * Usage:
 *   import { createMockServer } from '@solidactions/sdk/testing';
 *   const server = await createMockServer();
 *   // server.baseUrl is now available (e.g., http://127.0.0.1:12345)
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { StatusString } from '../workflow';

interface MockWorkflow {
  workflowUUID: string;
  status: string;
  workflowName: string;
  workflowClassName: string;
  workflowConfigName: string;
  authenticatedUser: string;
  assumedRole: string;
  authenticatedRoles: string[];
  request: object;
  executorId: string;
  applicationVersion?: string;
  applicationID: string;
  input: string | null;
  output: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  queueName?: string;
  recoveryAttempts: number;
  timeoutMS?: number;
  deadlineEpochMS?: number;
  deduplicationID?: string;
  priority: number;
  queuePartitionKey?: string;
  forkedFrom?: string;
}

interface MockOperation {
  workflowUUID: string;
  functionId?: number;
  functionID?: number; // SDK sends this casing
  functionName: string;
  output: string | null;
  error: string | null;
  childWorkflowId?: string | null;
  childWorkflowID?: string | null; // SDK sends this casing
  startedAtEpochMs?: number;
  startTimeEpochMs?: number; // SDK sends this
  completedAtEpochMs?: number;
  endTimeEpochMs?: number; // SDK sends this
  checkConflict?: boolean;
}

interface MockMessage {
  destinationUUID: string;
  topic: string | null;
  message: string | null;
  consumed: boolean;
}

interface MockEvent {
  workflowUUID: string;
  key: string;
  value: string | null;
}

interface MockStream {
  workflowUUID: string;
  key: string;
  values: unknown[];
  closed: boolean;
}

/**
 * In-memory storage for mock server
 */
export class MockStore {
  workflows: Map<string, MockWorkflow> = new Map();
  operations: Map<string, MockOperation[]> = new Map(); // keyed by workflowUUID
  messages: MockMessage[] = [];
  events: Map<string, MockEvent> = new Map(); // keyed by workflowUUID:key
  streams: Map<string, MockStream> = new Map(); // keyed by workflowUUID:key
  eventDispatch: Map<string, object> = new Map(); // keyed by service:fn:key

  clear(): void {
    this.workflows.clear();
    this.operations.clear();
    this.messages = [];
    this.events.clear();
    this.streams.clear();
    this.eventDispatch.clear();
  }
}

/**
 * Mock HTTP Server for testing
 */
export class MockHttpServer {
  private server: Server | null = null;
  private port: number;
  public store: MockStore;
  public requestLog: Array<{
    method: string;
    path: string;
    body?: unknown;
    headers: Record<string, string | string[] | undefined>;
  }> = [];

  constructor(port: number = 0) {
    this.port = port;
    this.store = new MockStore();
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      this.server.on('error', reject);

      this.server.listen(this.port, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const query = url.searchParams;

    // Read body
    let body: unknown;
    if (method !== 'GET' && method !== 'HEAD') {
      body = await this.readBody(req);
    }

    // Log request (headers captured read-only for identity-isolation assertions;
    // this only records — it does not alter routing or responses below)
    this.requestLog.push({ method, path, body, headers: { ...req.headers } });

    try {
      const result = this.route(method, path, query, body);
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      const err = error as { status?: number; message?: string };
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: err.message || 'Internal server error' }));
    }
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  private route(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
  ): { status: number; body: unknown } {
    // Health check
    if (path === '/health' && method === 'GET') {
      return { status: 200, body: { status: 'ok' } };
    }

    // Normalize path: SDK uses /runs/status/... but older tests used /workflows/...
    // Accept both path prefixes for compatibility
    const normalizedPath = path.replace(/^\/runs\/status/, '/workflows');

    // Pending workflows - check BEFORE /workflows/:id to avoid matching "pending" as an ID
    if (normalizedPath === '/workflows/pending' && method === 'GET') {
      return this.getPendingWorkflows(query.get('executorId') || '', query.get('appVersion') || '');
    }

    // Workflows
    if (normalizedPath === '/workflows' && method === 'POST') {
      return this.createWorkflow(body as Partial<MockWorkflow>);
    }

    if (normalizedPath === '/workflows' && method === 'GET') {
      return this.listWorkflows(query);
    }

    const workflowMatch = normalizedPath.match(/^\/workflows\/([^/]+)$/);
    if (workflowMatch && method === 'GET') {
      return this.getWorkflow(decodeURIComponent(workflowMatch[1]));
    }

    const outputMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/output$/);
    if (outputMatch && method === 'PUT') {
      return this.recordOutput(decodeURIComponent(outputMatch[1]), body as { output: string; status: string });
    }

    const errorMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/error$/);
    if (errorMatch && method === 'PUT') {
      return this.recordError(decodeURIComponent(errorMatch[1]), body as { error: string; status: string });
    }

    const resultMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/result$/);
    if (resultMatch && method === 'GET') {
      return this.getResult(decodeURIComponent(resultMatch[1]));
    }

    const statusMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/status$/);
    if (statusMatch && method === 'PUT') {
      return this.setWorkflowStatus(
        decodeURIComponent(statusMatch[1]),
        body as { status: string; resetRecoveryAttempts: boolean },
      );
    }

    const cancelMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      return this.cancelWorkflow(decodeURIComponent(cancelMatch[1]));
    }

    const resumeMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/resume$/);
    if (resumeMatch && method === 'POST') {
      return this.resumeWorkflow(decodeURIComponent(resumeMatch[1]));
    }

    const cancelledMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/cancelled$/);
    if (cancelledMatch && method === 'GET') {
      return this.checkCancelled(decodeURIComponent(cancelledMatch[1]));
    }

    // Operations
    const opsMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/operations$/);
    if (opsMatch && method === 'GET') {
      return this.getOperations(decodeURIComponent(opsMatch[1]));
    }
    if (opsMatch && method === 'POST') {
      return this.recordOperation(decodeURIComponent(opsMatch[1]), body as MockOperation);
    }

    const opMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/operations\/(\d+)$/);
    if (opMatch && method === 'GET') {
      return this.getOperation(decodeURIComponent(opMatch[1]), parseInt(opMatch[2]));
    }

    // Messages
    const msgMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/messages$/);
    if (msgMatch && method === 'POST') {
      return this.sendMessage(decodeURIComponent(msgMatch[1]), body as MockMessage);
    }
    if (msgMatch && method === 'GET') {
      return this.receiveMessage(decodeURIComponent(msgMatch[1]), query.get('topic'));
    }

    // Wait (for workflows waiting on external events)
    const waitMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/wait$/);
    if (waitMatch && method === 'POST') {
      return { status: 200, body: {} };
    }

    // Events
    const eventMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/events\/([^/]+)$/);
    if (eventMatch && method === 'PUT') {
      return this.setEvent(decodeURIComponent(eventMatch[1]), decodeURIComponent(eventMatch[2]), body as MockEvent);
    }
    if (eventMatch && method === 'GET') {
      return this.getEvent(decodeURIComponent(eventMatch[1]), decodeURIComponent(eventMatch[2]));
    }

    // Queues
    const queueStartMatch = normalizedPath.match(/^\/queues\/([^/]+)\/start-workflows$/);
    if (queueStartMatch && method === 'POST') {
      return this.startQueuedWorkflows(decodeURIComponent(queueStartMatch[1]), body as object);
    }

    const dedupeMatch = normalizedPath.match(/^\/queues\/([^/]+)\/deduplicated\/([^/]+)$/);
    if (dedupeMatch && method === 'GET') {
      return this.getDeduplicatedWorkflow(decodeURIComponent(dedupeMatch[1]), decodeURIComponent(dedupeMatch[2]));
    }

    // Admin
    if (path === '/admin/garbage-collect' && method === 'POST') {
      return { status: 200, body: {} };
    }

    if (path === '/admin/metrics' && method === 'GET') {
      return { status: 200, body: [] };
    }

    // Sleep
    const sleepMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/sleep$/);
    if (sleepMatch && method === 'POST') {
      return { status: 200, body: {} };
    }

    // Queue assignment
    const queueAssignMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/queue-assignment$/);
    if (queueAssignMatch && method === 'DELETE') {
      return { status: 200, body: { cleared: true } };
    }

    // Fork
    const forkMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/fork$/);
    if (forkMatch && method === 'POST') {
      return this.forkWorkflow(decodeURIComponent(forkMatch[1]), body as { startStep: number; newWorkflowID?: string });
    }

    // Streams
    const streamMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/streams\/([^/]+)$/);
    if (streamMatch && method === 'POST') {
      return this.writeStream(
        decodeURIComponent(streamMatch[1]),
        decodeURIComponent(streamMatch[2]),
        body as { value: unknown },
      );
    }

    const streamCloseMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/streams\/([^/]+)\/close$/);
    if (streamCloseMatch && method === 'POST') {
      return this.closeStream(decodeURIComponent(streamCloseMatch[1]), decodeURIComponent(streamCloseMatch[2]));
    }

    const streamReadMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/streams\/([^/]+)\/(\d+)$/);
    if (streamReadMatch && method === 'GET') {
      return this.readStream(
        decodeURIComponent(streamReadMatch[1]),
        decodeURIComponent(streamReadMatch[2]),
        parseInt(streamReadMatch[3]),
      );
    }

    // Patch (for workflow patching)
    const patchMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/patch\/(\d+)$/);
    if (patchMatch && method === 'PUT') {
      return { status: 200, body: {} };
    }

    // Event dispatch
    const dispatchMatch = path.match(/^\/event-dispatch\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (dispatchMatch && method === 'GET') {
      return this.getEventDispatch(
        decodeURIComponent(dispatchMatch[1]),
        decodeURIComponent(dispatchMatch[2]),
        decodeURIComponent(dispatchMatch[3]),
      );
    }

    if (path === '/event-dispatch' && method === 'PUT') {
      return this.upsertEventDispatch(body as object);
    }

    // Queue partitions
    const partitionsMatch = path.match(/^\/queues\/([^/]+)\/partitions$/);
    if (partitionsMatch && method === 'GET') {
      return { status: 200, body: { partitions: [] } };
    }

    // Patch check (GET returns patch state)
    const patchGetMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/patch\/(\d+)$/);
    if (patchGetMatch && method === 'GET') {
      return { status: 200, body: { isPatched: false, hasEntry: false } };
    }

    // Webhook output (no-op for local dev)
    const webhookOutputMatch = normalizedPath.match(/^\/workflows\/([^/]+)\/webhook-output$/);
    if (webhookOutputMatch && method === 'PUT') {
      return { status: 200, body: {} };
    }

    return { status: 404, body: { message: `Not found: ${method} ${path}` } };
  }

  // Workflow handlers
  private createWorkflow(data: Partial<MockWorkflow>): { status: number; body: unknown } {
    const workflowUUID = data.workflowUUID!;

    if (this.store.workflows.has(workflowUUID)) {
      const existing = this.store.workflows.get(workflowUUID)!;
      return {
        status: 200,
        body: {
          status: existing.status,
          shouldExecuteOnThisExecutor: false,
        },
      };
    }

    const workflow: MockWorkflow = {
      workflowUUID,
      status: data.status || StatusString.PENDING,
      workflowName: data.workflowName || '',
      workflowClassName: data.workflowClassName || '',
      workflowConfigName: data.workflowConfigName || '',
      authenticatedUser: data.authenticatedUser || '',
      assumedRole: data.assumedRole || '',
      authenticatedRoles: data.authenticatedRoles || [],
      request: data.request || {},
      executorId: data.executorId || 'local',
      applicationVersion: data.applicationVersion,
      applicationID: data.applicationID || 'test',
      input: data.input ?? null,
      output: null,
      error: null,
      createdAt: data.createdAt || Date.now(),
      updatedAt: Date.now(),
      queueName: data.queueName,
      recoveryAttempts: 0,
      timeoutMS: data.timeoutMS,
      deadlineEpochMS: data.deadlineEpochMS,
      deduplicationID: data.deduplicationID,
      priority: data.priority ?? 0,
      queuePartitionKey: data.queuePartitionKey,
      forkedFrom: data.forkedFrom,
    };

    this.store.workflows.set(workflowUUID, workflow);
    this.store.operations.set(workflowUUID, []);

    return {
      status: 201,
      body: {
        status: workflow.status,
        shouldExecuteOnThisExecutor: true,
        deadlineEpochMS: workflow.deadlineEpochMS,
      },
    };
  }

  private getWorkflow(workflowUUID: string): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }
    return { status: 200, body: workflow };
  }

  private listWorkflows(query: URLSearchParams): { status: number; body: unknown } {
    let workflows = Array.from(this.store.workflows.values());

    const status = query.get('status');
    if (status) {
      workflows = workflows.filter((w) => w.status === status);
    }

    const limit = parseInt(query.get('limit') || '100');
    const offset = parseInt(query.get('offset') || '0');

    workflows = workflows.slice(offset, offset + limit);

    return { status: 200, body: workflows };
  }

  private recordOutput(
    workflowUUID: string,
    data: { output: string; status: string },
  ): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }
    workflow.output = data.output;
    workflow.status = data.status;
    workflow.updatedAt = Date.now();
    return { status: 200, body: {} };
  }

  private recordError(
    workflowUUID: string,
    data: { error: string; status: string },
  ): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }
    workflow.error = data.error;
    workflow.status = data.status;
    workflow.updatedAt = Date.now();
    return { status: 200, body: {} };
  }

  private getResult(workflowUUID: string): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 200, body: null };
    }
    if (workflow.status === StatusString.PENDING || workflow.status === StatusString.ENQUEUED) {
      return { status: 200, body: null };
    }
    return {
      status: 200,
      body: {
        output: workflow.output,
        error: workflow.error,
        cancelled: workflow.status === StatusString.CANCELLED,
      },
    };
  }

  private setWorkflowStatus(
    workflowUUID: string,
    data: { status: string; resetRecoveryAttempts: boolean },
  ): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }
    workflow.status = data.status;
    if (data.resetRecoveryAttempts) {
      workflow.recoveryAttempts = 0;
    }
    workflow.updatedAt = Date.now();
    return { status: 200, body: {} };
  }

  private cancelWorkflow(workflowUUID: string): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }
    workflow.status = StatusString.CANCELLED;
    workflow.updatedAt = Date.now();
    return { status: 200, body: {} };
  }

  private resumeWorkflow(workflowUUID: string): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }
    workflow.status = StatusString.PENDING;
    workflow.updatedAt = Date.now();
    return { status: 200, body: {} };
  }

  private checkCancelled(workflowUUID: string): { status: number; body: unknown } {
    const workflow = this.store.workflows.get(workflowUUID);
    if (!workflow) {
      return { status: 200, body: { cancelled: false } };
    }
    return { status: 200, body: { cancelled: workflow.status === StatusString.CANCELLED } };
  }

  private getPendingWorkflows(executorId: string, appVersion: string): { status: number; body: unknown } {
    const pending = Array.from(this.store.workflows.values())
      .filter(
        (w) =>
          w.status === StatusString.PENDING &&
          w.executorId === executorId &&
          (!appVersion || w.applicationVersion === appVersion),
      )
      .map((w) => ({ workflowUUID: w.workflowUUID, queueName: w.queueName }));
    return { status: 200, body: pending };
  }

  private forkWorkflow(
    workflowUUID: string,
    data: { startStep: number; newWorkflowID?: string },
  ): { status: number; body: unknown } {
    const original = this.store.workflows.get(workflowUUID);
    if (!original) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }

    const newID = data.newWorkflowID || `${workflowUUID}-fork-${Date.now()}`;
    const forked: MockWorkflow = {
      ...original,
      workflowUUID: newID,
      status: StatusString.PENDING,
      forkedFrom: workflowUUID,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      output: null,
      error: null,
    };

    this.store.workflows.set(newID, forked);
    this.store.operations.set(newID, []);

    return { status: 200, body: { newWorkflowID: newID } };
  }

  // Operation handlers
  private getOperations(workflowUUID: string): { status: number; body: unknown } {
    const ops = this.store.operations.get(workflowUUID) || [];
    return {
      status: 200,
      body: ops.map((o) => ({
        workflow_uuid: o.workflowUUID,
        function_id: o.functionId,
        output: o.output,
        error: o.error,
        child_workflow_id: o.childWorkflowId,
        function_name: o.functionName,
        started_at_epoch_ms: o.startedAtEpochMs,
        completed_at_epoch_ms: o.completedAtEpochMs,
      })),
    };
  }

  private getOperation(workflowUUID: string, functionId: number): { status: number; body: unknown } {
    const ops = this.store.operations.get(workflowUUID) || [];
    const op = ops.find((o) => o.functionId === functionId);
    if (!op) {
      return { status: 200, body: null };
    }
    const workflow = this.store.workflows.get(workflowUUID);
    return {
      status: 200,
      body: {
        output: op.output,
        error: op.error,
        cancelled: workflow?.status === StatusString.CANCELLED,
        childWorkflowID: op.childWorkflowId,
        functionName: op.functionName,
      },
    };
  }

  private recordOperation(workflowUUID: string, data: MockOperation): { status: number; body: unknown } {
    const ops = this.store.operations.get(workflowUUID);
    if (!ops) {
      return { status: 404, body: { message: 'Workflow not found', type: 'workflow_not_found' } };
    }

    // Handle both casing variants from SDK
    const functionId = data.functionId ?? data.functionID ?? 0;
    const childWorkflowId = data.childWorkflowId ?? data.childWorkflowID ?? null;
    const startedAtEpochMs = data.startedAtEpochMs ?? data.startTimeEpochMs ?? Date.now();
    const completedAtEpochMs = data.completedAtEpochMs ?? data.endTimeEpochMs ?? Date.now();

    const existing = ops.find((o) => o.functionId === functionId);
    if (existing && data.checkConflict) {
      return { status: 409, body: { message: 'Operation already exists', workflowID: workflowUUID } };
    }

    if (!existing) {
      ops.push({
        workflowUUID,
        functionId,
        functionName: data.functionName || '',
        output: data.output ?? null,
        error: data.error ?? null,
        childWorkflowId,
        startedAtEpochMs,
        completedAtEpochMs,
      });
    }

    return { status: 200, body: {} };
  }

  // Message handlers
  private sendMessage(destinationUUID: string, data: MockMessage): { status: number; body: unknown } {
    this.store.messages.push({
      destinationUUID,
      topic: data.topic ?? null,
      message: data.message ?? null,
      consumed: false,
    });
    return { status: 200, body: {} };
  }

  private receiveMessage(workflowUUID: string, topic: string | null): { status: number; body: unknown } {
    const idx = this.store.messages.findIndex(
      (m) => m.destinationUUID === workflowUUID && m.topic === topic && !m.consumed,
    );
    if (idx === -1) {
      return { status: 200, body: { message: null, found: false } };
    }
    const msg = this.store.messages[idx];
    msg.consumed = true;
    return { status: 200, body: { message: msg.message, found: true } };
  }

  // Event handlers
  private setEvent(
    workflowUUID: string,
    key: string,
    data: { value: string | null },
  ): { status: number; body: unknown } {
    const eventKey = `${workflowUUID}:${key}`;
    this.store.events.set(eventKey, {
      workflowUUID,
      key,
      value: data.value ?? null,
    });
    return { status: 200, body: {} };
  }

  private getEvent(workflowUUID: string, key: string): { status: number; body: unknown } {
    const eventKey = `${workflowUUID}:${key}`;
    const event = this.store.events.get(eventKey);
    if (!event) {
      return { status: 200, body: { value: null, found: false } };
    }
    return { status: 200, body: { value: event.value, found: true } };
  }

  // Queue handlers
  private startQueuedWorkflows(queueName: string, data: object): { status: number; body: unknown } {
    const queuedWorkflows = Array.from(this.store.workflows.values()).filter(
      (w) => w.queueName === queueName && w.status === StatusString.ENQUEUED,
    );

    const toStart = queuedWorkflows.slice(0, (data as { concurrency?: number }).concurrency || 10);
    const workflowIDs: string[] = [];

    for (const wf of toStart) {
      wf.status = StatusString.PENDING;
      wf.updatedAt = Date.now();
      workflowIDs.push(wf.workflowUUID);
    }

    return { status: 200, body: { workflowIDs } };
  }

  private getDeduplicatedWorkflow(queueName: string, deduplicationID: string): { status: number; body: unknown } {
    const workflow = Array.from(this.store.workflows.values()).find(
      (w) => w.queueName === queueName && w.deduplicationID === deduplicationID,
    );
    return { status: 200, body: { workflowID: workflow?.workflowUUID ?? null } };
  }

  // Stream handlers
  private writeStream(workflowUUID: string, key: string, data: { value: unknown }): { status: number; body: unknown } {
    const streamKey = `${workflowUUID}:${key}`;
    let stream = this.store.streams.get(streamKey);
    if (!stream) {
      stream = { workflowUUID, key, values: [], closed: false };
      this.store.streams.set(streamKey, stream);
    }
    stream.values.push(data.value);
    return { status: 200, body: {} };
  }

  private readStream(workflowUUID: string, key: string, offset: number): { status: number; body: unknown } {
    const streamKey = `${workflowUUID}:${key}`;
    const stream = this.store.streams.get(streamKey);
    if (!stream) {
      return { status: 200, body: { value: null, closed: false } };
    }
    if (offset >= stream.values.length) {
      return { status: 200, body: { value: null, closed: stream.closed } };
    }
    return { status: 200, body: { value: stream.values[offset], closed: false } };
  }

  private closeStream(workflowUUID: string, key: string): { status: number; body: unknown } {
    const streamKey = `${workflowUUID}:${key}`;
    const stream = this.store.streams.get(streamKey);
    if (stream) {
      stream.closed = true;
    }
    return { status: 200, body: {} };
  }

  // Event dispatch handlers
  private getEventDispatch(service: string, fnName: string, key: string): { status: number; body: unknown } {
    const dispatchKey = `${service}:${fnName}:${key}`;
    const state = this.store.eventDispatch.get(dispatchKey);
    return { status: 200, body: state ?? null };
  }

  private upsertEventDispatch(data: object): { status: number; body: unknown } {
    const d = data as { service_name: string; workflow_fn_name: string; key: string };
    const dispatchKey = `${d.service_name}:${d.workflow_fn_name}:${d.key}`;
    this.store.eventDispatch.set(dispatchKey, data);
    return { status: 200, body: data };
  }

  // ==========================================
  // Identity-isolation assertion (read-only)
  // ==========================================

  /**
   * Concurrency proof helper (Task 1.4). READ-ONLY: inspects the recorded
   * requestLog only — never mutates store or affects routing/responses.
   *
   * Correlates each backend request to its issuing run via TWO independent
   * on-the-wire identity dimensions and asserts they agree:
   *
   *   A) the workflowID embedded in the request path — every workflow-scoped
   *      route is `/runs/status/<workflowID>/...` (the SDK's natural run key,
   *      = ctx.run.runUuid), and
   *   B) the `Authorization: Bearer <apiKey>` header — sourced from ctx.api.key
   *      via a SEPARATE per-request HttpClient instance, NOT derived from the
   *      path.
   *
   * For every workflow-scoped request, the bearer MUST equal the apiKey the
   * run identified by the path was constructed with (passed in
   * `expectedKeyByRun`, keyed by runUuid). If any request for run-i carries a
   * different run's bearer (e.g. run-j's apiKey leaking through shared/global
   * state), A and B disagree and this throws with a precise message naming the
   * offending request. Returns `true` only when every workflow-scoped request
   * is internally identity-consistent.
   *
   * This is genuinely falsifiable, not a tautology: A (path) and B (bearer)
   * are produced by independent machinery, so a cross-request identity leak
   * would surface as a path/bearer mismatch and fail this check.
   *
   * @param expectedKeyByRun map of runUuid -> the apiKey that run was built
   *   with. Runs not present in the map are ignored (non-workflow / health
   *   requests carry no run key and are skipped automatically).
   */
  assertNoIdentityCrossContamination(expectedKeyByRun: Record<string, string>): boolean {
    // Matches `/runs/status/<workflowID>/...` (raw path is logged BEFORE the
    // route() normalization, so this is the on-the-wire path).
    const runPathRe = /^\/runs\/status\/([^/?]+)/;

    for (let i = 0; i < this.requestLog.length; i++) {
      const entry = this.requestLog[i];
      const match = runPathRe.exec(entry.path);
      if (!match) {
        // Not a workflow-scoped request (e.g. /health) — no run key on the
        // wire to correlate; skip.
        continue;
      }

      const runUuid = decodeURIComponent(match[1]);
      const expectedKey = expectedKeyByRun[runUuid];
      if (expectedKey === undefined) {
        // This run was not part of the asserted set — skip.
        continue;
      }

      // Dimension B: the bearer that actually rode on this request.
      const rawAuth = entry.headers['authorization'] ?? entry.headers['Authorization'];
      const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      const prefix = 'Bearer ';
      if (typeof authHeader !== 'string' || !authHeader.startsWith(prefix)) {
        throw new Error(
          `Identity cross-contamination check: request #${i} ${entry.method} ${entry.path} ` +
            `(run "${runUuid}") carried no usable Authorization bearer (got: ${JSON.stringify(rawAuth)}). ` +
            `Cannot prove identity isolation without an on-the-wire bearer.`,
        );
      }
      const actualKey = authHeader.slice(prefix.length);

      // The proof: path-derived run identity (A) MUST agree with the
      // independently-sourced bearer identity (B).
      if (actualKey !== expectedKey) {
        const leakedRun =
          Object.keys(expectedKeyByRun).find((r) => expectedKeyByRun[r] === actualKey) ?? '<unknown run>';
        throw new Error(
          `IDENTITY CROSS-CONTAMINATION DETECTED: request #${i} ${entry.method} ${entry.path} ` +
            `is path-scoped to run "${runUuid}" (expected bearer "${expectedKey}") but its ` +
            `Authorization header carried bearer "${actualKey}", which belongs to run ` +
            `"${leakedRun}". A concurrent invoke leaked another run's api.key onto this ` +
            `request — per-request identity isolation is broken.`,
        );
      }
    }

    return true;
  }
}

/**
 * Helper function to create and start a mock server
 */
export async function createMockServer(port: number = 0): Promise<MockHttpServer> {
  const server = new MockHttpServer(port);
  await server.start();
  return server;
}
