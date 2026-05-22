/**
 * SolidActions SDK Configuration
 *
 * This module handles configuration for the HTTP-based SolidActions SDK.
 * Configuration can be provided via:
 * - Environment variables (SOLIDACTIONS_API_URL, SOLIDACTIONS_API_KEY)
 * - Config file (solidactions-config.yaml or solidsteps.yaml)
 * - Direct API calls
 */

import { readFile } from './utils';
import { SolidActionsConfig, SolidActionsRuntimeConfig, SolidActionsConfigInternal } from './solidactions-executor';
import YAML from 'yaml';
import { writeFileSync } from 'fs';
import path from 'path';
import assert from 'assert';
import { SolidActionsJSON } from './serialization';

/**
 * SolidSteps project configuration (from solidsteps.yaml)
 * This is separate from SolidActions config - it contains project metadata.
 */
export interface SolidStepsConfig {
  project?: string;
  env?: Array<{
    key: string;
    value?: string;
    mapped?: string;
  }>;
  workflows?: Array<{
    id: string;
    name?: string;
    file: string;
    trigger: 'webhook' | 'internal' | 'schedule';
    schedule?: string;
  }>;
}

/**
 * Read SolidSteps project configuration from solidsteps.yaml
 * Returns project name and other metadata.
 * Returns empty object if file doesn't exist.
 */
export async function readSolidStepsConfig(dirPath?: string): Promise<SolidStepsConfig> {
  dirPath ??= process.cwd();
  const configPath = path.join(dirPath, 'solidsteps.yaml');

  try {
    const content = await readFile(configPath);
    if (!content) {
      return {};
    }
    return YAML.parse(content) as SolidStepsConfig;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/**
 * HTTP API Configuration for SolidActions SDK
 */
export interface SolidActionsHttpConfig {
  apiUrl: string; // Required: Base API URL
  apiKey: string; // Required: Bearer token
  timeout?: number; // Optional: Request timeout in ms (default: 30000)
  maxRetries?: number; // Optional: Retry count (default: 3)
  // Optional: worker session id for the X-Worker-Session-ID header. invoke()
  // threads this from ctx.run.workerSessionId; legacy boot leaves it unset and
  // HttpClient falls back to the SOLIDACTIONS_WORKER_SESSION_ID env var.
  workerSessionId?: string;
}

/**
 * Get HTTP configuration from environment variables or config file
 */
export function getHttpConfig(configFile?: ConfigFile): SolidActionsHttpConfig {
  /* boot-only */ // legacy boot/CLI config resolution; invoke() takes api.url/key from ctx.api, never these env vars
  const apiUrl = process.env.SOLIDACTIONS_API_URL ?? configFile?.api?.url;
  const apiKey = process.env.SOLIDACTIONS_API_KEY ?? configFile?.api?.key;
  const timeout = process.env.SOLIDACTIONS_API_TIMEOUT
    ? parseInt(process.env.SOLIDACTIONS_API_TIMEOUT, 10)
    : configFile?.api?.timeout;
  const maxRetries = process.env.SOLIDACTIONS_API_MAX_RETRIES
    ? parseInt(process.env.SOLIDACTIONS_API_MAX_RETRIES, 10)
    : configFile?.api?.maxRetries;

  if (!apiUrl) {
    throw new Error(
      'SolidActions API URL is required. Set SOLIDACTIONS_API_URL environment variable or api.url in config file.',
    );
  }
  if (!apiKey) {
    throw new Error(
      'SolidActions API key is required. Set SOLIDACTIONS_API_KEY environment variable or api.key in config file.',
    );
  }

  return {
    apiUrl,
    apiKey,
    timeout,
    maxRetries,
  };
}

export const configFilePath = 'solidactions-config.yaml';

export interface ConfigFile {
  name?: string;
  language?: string;
  api?: {
    url?: string; // HTTP API base URL
    key?: string; // API key / Bearer token
    timeout?: number; // Request timeout in ms
    maxRetries?: number; // Max retry attempts
  };
  telemetry?: {
    logs?: {
      addContextMetadata?: boolean;
      logLevel?: string;
      silent?: boolean;
    };
    OTLPExporter?: {
      logsEndpoint?: string | string[];
      tracesEndpoint?: string | string[];
    };
  };
  runtimeConfig?: Partial<SolidActionsRuntimeConfig>;
}

/**
 * Substitute environment variables using a regex for matching.
 * Will find anything in curly braces like ${VAR_NAME}.
 */
export function substituteEnvVars(content: string): string {
  /* boot-only */ // legacy config-file (solidactions-config.yaml) env interpolation; not on the invoke() workflow path
  const regex = /\${([^}]+)}/g;
  return content.replace(regex, (_, g1: string) => {
    return process.env[g1] || '""';
  });
}

export async function readConfigFile(dirPath?: string): Promise<ConfigFile> {
  dirPath ??= process.cwd();
  const solidactionsConfigPath = path.join(dirPath, configFilePath);
  const configContent = await readFileHelper(solidactionsConfigPath);

  const config = configContent ? (YAML.parse(substituteEnvVars(configContent)) as ConfigFile) : {};
  if (!config.name) {
    const packageJsonPath = path.join(dirPath, 'package.json');
    const packageContent = await readFileHelper(packageJsonPath);
    const $package = packageContent ? (JSON.parse(packageContent) as { name?: string }) : {};
    config.name = $package.name;
  }

  return config;

  async function readFileHelper(filePath: string): Promise<string | undefined> {
    try {
      return await readFile(filePath);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }
}

export function writeConfigFile(configFile: ConfigFile, configFilePath: string) {
  try {
    const configFileContent = YAML.stringify(configFile);
    writeFileSync(configFilePath, configFileContent);
  } catch (e) {
    if (e instanceof Error) {
      throw new Error(`Failed to write config to ${configFilePath}: ${e.message}`);
    } else {
      throw e;
    }
  }
}

export function getSolidActionsConfig(
  config: ConfigFile,
  options: {
    logLevel?: string;
    forceConsole?: boolean;
  } = {},
): SolidActionsConfigInternal {
  assert(
    config.language === undefined || config.language === 'node',
    `Config file specifies invalid language ${config.language}`,
  );

  return translateSolidActionsConfig(
    {
      name: config.name,
      api: config.api
        ? {
            url: config.api.url!,
            key: config.api.key!,
            timeout: config.api.timeout,
            maxRetries: config.api.maxRetries,
          }
        : undefined,
      logLevel: options.logLevel ?? config.telemetry?.logs?.logLevel,
      addContextMetadata: config.telemetry?.logs?.addContextMetadata,
      otlpTracesEndpoints: toArray(config.telemetry?.OTLPExporter?.tracesEndpoint),
      otlpLogsEndpoints: toArray(config.telemetry?.OTLPExporter?.logsEndpoint),
      runAdminServer: config.runtimeConfig?.runAdminServer,
      adminPort: config.runtimeConfig?.admin_port,
    },
    options.forceConsole,
  );
}

function toArray(endpoint: string | string[] | undefined): Array<string> {
  return endpoint ? (Array.isArray(endpoint) ? endpoint : [endpoint]) : [];
}

export function translateSolidActionsConfig(
  options: SolidActionsConfig,
  forceConsole: boolean = false,
): SolidActionsConfigInternal {
  // Get HTTP config from options or environment
  // Convert from config file format (url, key) to internal format (apiUrl, apiKey)
  const httpConfig: SolidActionsHttpConfig = options.api
    ? {
        apiUrl: options.api.url,
        apiKey: options.api.key,
        timeout: options.api.timeout,
        maxRetries: options.api.maxRetries,
      }
    : getHttpConfig();

  return {
    name: options.name,
    api: httpConfig,
    serializer: options.serializer ?? SolidActionsJSON,
    telemetry: {
      logs: {
        logLevel: options.logLevel || 'info',
        addContextMetadata: options.addContextMetadata,
        forceConsole,
      },
      OTLPExporter: {
        tracesEndpoint: options.otlpTracesEndpoints,
        logsEndpoint: options.otlpLogsEndpoints,
      },
    },
  };
}

export function getRuntimeConfig(config: ConfigFile): SolidActionsRuntimeConfig {
  return translateRuntimeConfig(config.runtimeConfig);
}

export function translateRuntimeConfig(
  config: Partial<SolidActionsRuntimeConfig & SolidActionsConfig> = {},
): SolidActionsRuntimeConfig {
  return {
    runAdminServer: config.runAdminServer ?? true,
    admin_port: config.admin_port ?? config.adminPort ?? 3001,
    start: config.start ?? [],
    setup: config.setup ?? [],
  };
}

/**
 * For HTTP SDK, cloud configuration is handled via API URL and key.
 * This function is a no-op for backwards compatibility.
 */
export function overwriteConfigForCloud(
  internalConfig: SolidActionsConfigInternal,
  runtimeConfig: SolidActionsRuntimeConfig,
  _configFile?: ConfigFile,
): [SolidActionsConfigInternal, SolidActionsRuntimeConfig] {
  // In HTTP SDK, cloud config is handled via the api.url and api.key settings
  // No additional overwriting needed
  return [internalConfig, runtimeConfig];
}
