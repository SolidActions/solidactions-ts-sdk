import * as http from 'http';
import * as url from 'url';
import { GetWorkflowsInput, StatusString } from './workflow';
import { SolidActionsError } from './error';
import { SolidActionsExecutor } from './solidactions-executor';
import { GlobalLogger } from './telemetry/logs';
import * as net from 'net';
import { performance } from 'perf_hooks';
import { bootParams } from './utils';
import { globalTimeout } from './workflow_management';
import * as protocol from './conductor/protocol';

export const WorkflowUUIDHeader = 'dbos-idempotency-key';
export const WorkflowRecoveryUrl = '/dbos-workflow-recovery';
export const HealthUrl = '/dbos-healthz';
export const PerfUrl = '/dbos-perf';
export const DeactivateUrl = '/deactivate';

// Simple router interface
interface Route {
  method: string;
  path: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse, params?: Record<string, string>) => Promise<void>;
}

// Helper to parse JSON body
async function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON response
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// Helper to send text response
function sendText(res: http.ServerResponse, statusCode: number, text: string) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(text);
}

// Helper to send no content response
function sendNoContent(res: http.ServerResponse) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

// Helper to extract path params
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = pathname.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const pathPart = pathParts[i];

    if (patternPart.startsWith(':')) {
      const paramName = patternPart.substring(1);
      params[paramName] = pathPart;
    } else if (patternPart !== pathPart) {
      return null;
    }
  }

  return params;
}

export class SolidActionsAdminServer {
  static setupAdminApp(solidActionsExec: SolidActionsExecutor): http.Server {
    const routes: Route[] = [];
    // Register HTTP endpoints.
    SolidActionsAdminServer.registerHealthEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerRecoveryEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerPerfEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerDeactivateEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerCancelWorkflowEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerResumeWorkflowEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerRestartWorkflowEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerListWorkflowStepsEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerListWorkflowsEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerGetWorkflowEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerForkWorkflowEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerGarbageCollectEndpoint(solidActionsExec, routes);
    SolidActionsAdminServer.registerGlobalTimeoutEndpoint(solidActionsExec, routes);

    // Create the HTTP server
    const server = http.createServer(async (req, res) => {
      // Handle CORS preflight requests
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      const parsedUrl = url.parse(req.url || '', true);
      const pathname = parsedUrl.pathname || '';

      // Find matching route
      let routeFound = false;
      for (const route of routes) {
        if (req.method === route.method) {
          const params = matchPath(route.path, pathname);
          if (params !== null) {
            routeFound = true;
            try {
              await route.handler(req, res, params);
            } catch (error) {
              solidActionsExec.logger.error(`Request handler error: ${String(error)}`);
              sendJson(res, 500, { error: 'Internal server error' });
            }
            break;
          }
        }
      }

      if (!routeFound) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    return server;
  }

  static async checkPortAvailabilityIPv4Ipv6(port: number, logger: GlobalLogger) {
    try {
      await this.checkPortAvailability(port, '127.0.0.1');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        logger.warn(
          `Port ${port} is already used for IPv4 address "127.0.0.1". Please use the -p option to choose another port.\n${err.message}`,
        );
        throw error;
      } else {
        logger.warn(
          `Error occurred while checking port availability for IPv4 address "127.0.0.1" : ${err.code}\n${err.message}`,
        );
      }
    }

    try {
      await this.checkPortAvailability(port, '::1');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'EADDRINUSE') {
        logger.warn(
          `Port ${port} is already used for IPv6 address "::1". Please use the -p option to choose another port.\n${err.message}`,
        );
        throw error;
      } else {
        logger.warn(
          `Error occurred while checking port availability for IPv6 address "::1" : ${err.code}\n${err.message}`,
        );
      }
    }
  }

  static async checkPortAvailability(port: number, host: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = new net.Server();
      server.on('error', (error: NodeJS.ErrnoException) => {
        reject(error);
      });

      server.on('listening', () => {
        server.close();
        resolve();
      });

      server.listen({ port: port, host: host }, () => {
        resolve();
      });
    });
  }

  /**
   * Health check endpoint.
   */
  static registerHealthEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    routes.push({
      method: 'GET',
      path: HealthUrl,
      handler: async (req, res) => {
        sendText(res, 200, 'healthy');
        return Promise.resolve();
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Healthz GET ${HealthUrl}`);
  }

  /**
   * Register workflow recovery endpoint.
   * Receives a list of executor IDs and returns a list of workflowUUIDs.
   */
  static registerRecoveryEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    routes.push({
      method: 'POST',
      path: WorkflowRecoveryUrl,
      handler: async (req, res) => {
        const executorIDs = (await parseJsonBody(req)) as string[];
        solidActionsExec.logger.info('Recovering workflows for executors: ' + executorIDs.toString());
        const recoverHandles = await solidActionsExec.recoverPendingWorkflows(executorIDs);

        // Return a list of workflowUUIDs being recovered.
        const result = await Promise.allSettled(recoverHandles.map((i) => i.workflowID)).then((results) =>
          results.filter((i) => i.status === 'fulfilled').map((i) => (i as PromiseFulfilledResult<unknown>).value),
        );
        sendJson(res, 200, result);
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Recovery POST ${WorkflowRecoveryUrl}`);
  }

  /**
   * Register performance endpoint.
   * Returns information on VM performance since last call.
   */
  static lastELU = performance.eventLoopUtilization();
  static registerPerfEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    routes.push({
      method: 'GET',
      path: PerfUrl,
      handler: async (req, res) => {
        const currELU = performance.eventLoopUtilization();
        const elu = performance.eventLoopUtilization(currELU, SolidActionsAdminServer.lastELU);
        sendJson(res, 200, elu);
        SolidActionsAdminServer.lastELU = currELU;
        return Promise.resolve();
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Perf GET ${PerfUrl}`);
  }

  /**
   * Register Deactivate endpoint.
   * Deactivate consumers so that they don't start new workflows.
   */
  static isDeactivated = false;
  static registerDeactivateEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    routes.push({
      method: 'GET',
      path: DeactivateUrl,
      handler: async (req, res) => {
        if (!SolidActionsAdminServer.isDeactivated) {
          solidActionsExec.logger.info(
            `Deactivating SolidActions executor ${bootParams.executorID} with version ${bootParams.appVersion}. This executor will complete existing workflows but will not create new workflows.`,
          );
          SolidActionsAdminServer.isDeactivated = true;
        }
        await solidActionsExec.deactivateEventReceivers();
        sendText(res, 200, 'Deactivated');
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Deactivate GET ${DeactivateUrl}`);
  }

  static registerGarbageCollectEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const url = '/dbos-garbage-collect';
    routes.push({
      method: 'POST',
      path: url,
      handler: async (req, res) => {
        const body = (await parseJsonBody(req)) as {
          cutoff_epoch_timestamp_ms?: number;
          rows_threshold?: number;
        };
        await solidActionsExec.systemDatabase.garbageCollect(body.cutoff_epoch_timestamp_ms, body.rows_threshold);
        sendNoContent(res);
      },
    });
  }

  static registerGlobalTimeoutEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const url = '/dbos-global-timeout';
    routes.push({
      method: 'POST',
      path: url,
      handler: async (req, res) => {
        const body = (await parseJsonBody(req)) as {
          cutoff_epoch_timestamp_ms: number;
        };
        await globalTimeout(solidActionsExec.systemDatabase, body.cutoff_epoch_timestamp_ms);
        sendNoContent(res);
      },
    });
  }

  /**
   * Register Cancel Workflow endpoint.
   * Cancels a workflow by setting its status to CANCELLED.
   */
  static registerCancelWorkflowEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const workflowCancelUrl = '/workflows/:workflow_id/cancel';
    routes.push({
      method: 'POST',
      path: workflowCancelUrl,
      handler: async (req, res, params) => {
        const workflowId = params!.workflow_id;
        await solidActionsExec.cancelWorkflow(workflowId);
        sendNoContent(res);
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Cancel Workflow POST ${workflowCancelUrl}`);
  }

  /**
   * Register Resume Workflow endpoint.
   * Resume a workflow.
   */
  static registerResumeWorkflowEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const workflowResumeUrl = '/workflows/:workflow_id/resume';
    routes.push({
      method: 'POST',
      path: workflowResumeUrl,
      handler: async (req, res, params) => {
        const workflowId = params!.workflow_id;
        solidActionsExec.logger.info(`Resuming workflow with ID: ${workflowId}`);
        try {
          await solidActionsExec.resumeWorkflow(workflowId);
          sendNoContent(res);
        } catch (e) {
          let errorMessage = '';
          if (e instanceof SolidActionsError) {
            errorMessage = e.message;
          } else {
            errorMessage = `Unknown error`;
          }
          solidActionsExec.logger.error(`Error resuming workflow ${workflowId}: ${errorMessage}`);
          sendJson(res, 500, {
            error: `Error resuming workflow ${workflowId}: ${errorMessage}`,
          });
        }
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Resume Workflow POST ${workflowResumeUrl}`);
  }

  /**
   * Register Restart Workflow endpoint.
   * Restart a workflow.
   */
  static registerRestartWorkflowEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const workflowRestartUrl = '/workflows/:workflow_id/restart';
    routes.push({
      method: 'POST',
      path: workflowRestartUrl,
      handler: async (req, res, params) => {
        const workflowId = params!.workflow_id;
        solidActionsExec.logger.info(`Restarting workflow: ${workflowId} with a new id`);
        const workflowID = await solidActionsExec.forkWorkflow(workflowId, 0);
        sendJson(res, 200, {
          workflow_id: workflowID,
        });
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Restart Workflow POST ${workflowRestartUrl}`);
  }

  /**
   * Register Fork Workflow endpoint.
   */
  static registerForkWorkflowEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const workflowForkUrl = '/workflows/:workflow_id/fork';
    routes.push({
      method: 'POST',
      path: workflowForkUrl,
      handler: async (req, res, params) => {
        const workflowId = params!.workflow_id;
        const body = (await parseJsonBody(req)) as {
          start_step?: number;
          new_workflow_id?: string;
          application_version?: string;
          timeout_ms?: number;
        };

        if (body.start_step === undefined) {
          sendJson(res, 400, { error: 'Missing start_step in request body' });
          return;
        }

        solidActionsExec.logger.info(`Forking workflow: ${workflowId} from step ${body.start_step} with a new id`);
        try {
          const workflowID = await solidActionsExec.forkWorkflow(workflowId, body.start_step, {
            newWorkflowID: body.new_workflow_id,
            applicationVersion: body.application_version,
            timeoutMS: body.timeout_ms,
          });
          sendJson(res, 200, {
            workflow_id: workflowID,
          });
        } catch (e) {
          let errorMessage = '';
          if (e instanceof SolidActionsError) {
            errorMessage = e.message;
          } else {
            errorMessage = `Unknown error`;
          }
          solidActionsExec.logger.error(`Error forking workflow ${workflowId}: ${errorMessage}`);
          sendJson(res, 500, {
            error: `Error forking workflow ${workflowId}: ${errorMessage}`,
          });
        }
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Fork Workflow POST ${workflowForkUrl}`);
  }

  /**
   * Register List Workflow Steps endpoint.
   * List steps for a given workflow.
   */
  static registerListWorkflowStepsEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const workflowStepsUrl = '/workflows/:workflow_id/steps';
    routes.push({
      method: 'GET',
      path: workflowStepsUrl,
      handler: async (req, res, params) => {
        const workflowId = params!.workflow_id;
        const steps = await solidActionsExec.listWorkflowSteps(workflowId);
        const result = steps?.map((step) => new protocol.WorkflowSteps(step));
        sendJson(res, 200, result);
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered List Workflow steps Get ${workflowStepsUrl}`);
  }

  /**
   * Register List Workflows endpoint.
   * List workflows with optional filtering via request body.
   */
  static registerListWorkflowsEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const listWorkflowsUrl = '/workflows';
    routes.push({
      method: 'POST',
      path: listWorkflowsUrl,
      handler: async (req, res) => {
        const body = (await parseJsonBody(req)) as {
          workflow_uuids?: string[];
          workflow_name?: string;
          authenticated_user?: string;
          start_time?: string;
          end_time?: string;
          status?: (typeof StatusString)[keyof typeof StatusString];
          application_version?: string;
          fork_from?: string;
          limit?: number;
          offset?: number;
          sort_desc?: boolean;
          workflow_id_prefix?: string;
          load_input?: boolean;
          load_output?: boolean;
        };

        // Map request body keys to GetWorkflowsInput properties
        const input: GetWorkflowsInput = {
          workflowIDs: body.workflow_uuids,
          workflowName: body.workflow_name,
          authenticatedUser: body.authenticated_user,
          startTime: body.start_time,
          endTime: body.end_time,
          status: body.status,
          applicationVersion: body.application_version,
          forkedFrom: body.fork_from,
          limit: body.limit,
          offset: body.offset,
          sortDesc: body.sort_desc,
          workflow_id_prefix: body.workflow_id_prefix,
          loadInput: body.load_input ?? false,
          loadOutput: body.load_output ?? false,
        };

        const workflows = await solidActionsExec.listWorkflows(input);

        // Map result to the underscore format.
        const result = workflows.map((wf) => new protocol.WorkflowsOutput(wf));
        sendJson(res, 200, result);
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered List Workflows POST ${listWorkflowsUrl}`);
  }

  /**
   * Register Get Workflow endpoint.
   * Get detailed information about a specific workflow by ID.
   */
  static registerGetWorkflowEndpoint(solidActionsExec: SolidActionsExecutor, routes: Route[]) {
    const getWorkflowUrl = '/workflows/:workflow_id';
    routes.push({
      method: 'GET',
      path: getWorkflowUrl,
      handler: async (req, res, params) => {
        const workflowId = params!.workflow_id;
        const workflow = await solidActionsExec.getWorkflowStatus(workflowId);
        if (workflow) {
          const result = new protocol.WorkflowsOutput(workflow);
          sendJson(res, 200, result);
        } else {
          sendJson(res, 404, { error: `Workflow ${workflowId} not found` });
        }
      },
    });
    solidActionsExec.logger.debug(`SolidActions Server Registered Get Workflow GET ${getWorkflowUrl}`);
  }
}
