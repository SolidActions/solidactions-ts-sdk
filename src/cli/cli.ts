#!/usr/bin/env node
/**
 * SolidActions SDK CLI - HTTP-only version
 *
 * This CLI provides commands for:
 * - Managing workflows via HTTP API
 */

import { Command } from 'commander';
import { SolidActionsClient, GetWorkflowsInput, StatusString } from '..';
import { exit } from 'node:process';
import { globalParams } from '../utils';

const program = new Command();

program.version(globalParams.solidActionsVersion);

/////////////////////////
/* WORKFLOW MANAGEMENT */
/////////////////////////

const workflowCommands = program
  .command('workflow')
  .alias('workflows')
  .alias('wf')
  .description('Manage SolidActions workflows');

workflowCommands
  .command('list')
  .description('List workflows from your application')
  .option('-n, --name <string>', 'Retrieve functions with this name')
  .option('-l, --limit <number>', 'Limit the results returned', '10')
  .option('-u, --user <string>', 'Retrieve workflows run by this user')
  .option('-t, --start-time <string>', 'Retrieve workflows starting after this timestamp (ISO 8601 format)')
  .option('-e, --end-time <string>', 'Retrieve workflows starting before this timestamp (ISO 8601 format)')
  .option(
    '-S, --status <string>',
    'Retrieve workflows with this status (PENDING, SUCCESS, ERROR, ENQUEUED, CANCELLED, or MAX_RECOVERY_ATTEMPTS_EXCEEDED)',
  )
  .option('-v, --application-version <string>', 'Retrieve workflows with this application version')
  .action(
    async (options: {
      name?: string;
      limit?: string;
      user?: string;
      startTime?: string;
      endTime?: string;
      status?: string;
      applicationVersion?: string;
    }) => {
      const validStatuses = Object.values(StatusString) as readonly string[];

      if (options.status && !validStatuses.includes(options.status)) {
        console.error('Invalid status: ', options.status);
        exit(1);
      }

      const input: GetWorkflowsInput = {
        workflowName: options.name,
        limit: Number(options.limit),
        authenticatedUser: options.user,
        startTime: options.startTime,
        endTime: options.endTime,
        status: options.status as GetWorkflowsInput['status'],
        applicationVersion: options.applicationVersion,
      };
      const client = await SolidActionsClient.create();
      try {
        const output = await client.listWorkflows(input);
        console.log(JSON.stringify(output));
      } finally {
        await client.destroy();
      }
    },
  );

workflowCommands
  .command('get')
  .description('Retrieve the status of a workflow')
  .argument('<workflowID>', 'Target workflow ID')
  .action(async (workflowID: string) => {
    const client = await SolidActionsClient.create();
    try {
      const output = await client.getWorkflow(workflowID);
      console.log(JSON.stringify(output));
    } finally {
      await client.destroy();
    }
  });

workflowCommands
  .command('steps')
  .description('List the steps of a workflow')
  .argument('<workflowID>', 'Target workflow ID')
  .action(async (workflowID: string) => {
    const client = await SolidActionsClient.create();
    try {
      const output = await client.listWorkflowSteps(workflowID);
      console.log(JSON.stringify(output));
    } finally {
      await client.destroy();
    }
  });

workflowCommands
  .command('cancel')
  .description('Cancel a workflow so it is no longer automatically retried or restarted')
  .argument('<workflowID>', 'Target workflow ID')
  .action(async (workflowID: string) => {
    const client = await SolidActionsClient.create();
    try {
      await client.cancelWorkflow(workflowID);
      console.log(`Workflow ${workflowID} cancelled`);
    } finally {
      await client.destroy();
    }
  });

workflowCommands
  .command('resume')
  .description('Resume a cancelled workflow')
  .argument('<workflowID>', 'Target workflow ID')
  .action(async (workflowID: string) => {
    const client = await SolidActionsClient.create();
    try {
      await client.resumeWorkflow(workflowID);
      console.log(`Workflow ${workflowID} resumed`);
    } finally {
      await client.destroy();
    }
  });

// Parse command line arguments
program.parse(process.argv);
