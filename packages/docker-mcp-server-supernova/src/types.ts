import { z } from 'zod';

// Validation regexes (shared across schemas)
const SAFE_CMD_ARG = /^[A-Za-z0-9_./:@%+=,\-]+$/;
const SAFE_PATH = /^\/[A-Za-z0-9_./\-]+$/;
const SAFE_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const SAFE_BUILD_CONTEXT = /^\/[A-Za-z0-9_./\-]+$/;

// Container lifecycle schemas
export const ListContainersSchema = z.object({
  all: z
    .boolean()
    .optional()
    .describe('Include stopped containers (default: false)'),
  label: z
    .array(z.string())
    .optional()
    .describe("Filter by label (e.g., 'app=web')"),
  name: z.string().optional().describe('Filter by name (partial match)'),
  state: z
    .enum(['running', 'stopped', 'paused', 'exited', 'created', 'restarting'])
    .optional()
    .describe('Filter by state'),
});

export const InspectContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
});

export const StartContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
});

export const StopContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  timeout: z
    .number()
    .optional()
    .describe('Seconds to wait before killing (default: 10)'),
});

export const RestartContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  timeout: z
    .number()
    .optional()
    .describe('Seconds to wait before killing (default: 10)'),
});

export const RemoveContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  force: z
    .boolean()
    .optional()
    .describe('Force removal even if running (default: false)'),
});

export const RecreateContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  timeout: z
    .number()
    .optional()
    .describe('Seconds to wait before killing (default: 10)'),
});

export const RunContainerSchema = z.object({
  image: z.string().describe("Image name (e.g., 'nginx:latest')"),
  name: z.string().optional().describe('Container name'),
  env: z.record(z.string()).optional().describe('Environment variables'),
  ports: z
    .record(z.string())
    .optional()
    .describe("Port mappings (e.g., {'8080/tcp': '80/tcp'})"),
  volumes: z
    .array(z.string())
    .optional()
    .describe("Volume mounts (e.g., ['/host/path:/container/path'])"),
  network: z
    .string()
    .optional()
    .describe('Docker network name to attach the container to'),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe('Labels to apply to the container'),
  restart_policy: z
    .enum(['no', 'always', 'unless-stopped', 'on-failure'])
    .optional()
    .describe('Restart policy'),
  command: z.array(z.string()).optional().describe('Override command'),
  detach: z
    .boolean()
    .optional()
    .describe('Run in detached mode (default: true)'),
});

// Image management schemas
export const ListImagesSchema = z.object({
  all: z
    .boolean()
    .optional()
    .describe('Include intermediate images (default: false)'),
  filter: z.string().optional().describe('Filter by reference'),
});

export const PullImageSchema = z.object({
  image: z.string().describe("Image to pull (e.g., 'nginx:latest')"),
  tag: z.string().optional().describe("Tag to pull (default: 'latest')"),
});

export const BuildImageSchema = z.object({
  context: z
    .string()
    .regex(
      SAFE_BUILD_CONTEXT,
      "Build context must be a local absolute path (no URLs, no '..')",
    )
    .max(4096)
    .describe('Build context path (local absolute path only)'),
  tag: z.string().describe("Tag for the built image (e.g., 'myapp:v1')"),
  dockerfile: z
    .string()
    .max(256)
    .optional()
    .describe("Dockerfile name relative to context (default: 'Dockerfile')"),
  build_args: z
    .record(
      z
        .string()
        .regex(SAFE_ENV_KEY, 'Build arg key must be POSIX-style')
        .max(256),
      z.string().max(4096),
    )
    .optional()
    .describe('Build arguments (keys must be POSIX-style)'),
  target: z.string().max(256).optional().describe('Target build stage'),
});

export const RemoveImageSchema = z.object({
  image: z.string().describe('Image name or ID'),
  force: z.boolean().optional().describe('Force removal (default: false)'),
});

// Docker Compose schemas
export const ComposeUpSchema = z.object({
  path: z
    .string()
    .describe('Path to docker-compose.yml file or its parent directory'),
  build: z
    .boolean()
    .optional()
    .describe('Build images before starting (default: false)'),
  detach: z
    .boolean()
    .optional()
    .describe('Run in detached mode (default: true)'),
  services: z
    .array(z.string())
    .optional()
    .describe('Specific services to start'),
});

export const ComposeDownSchema = z.object({
  path: z
    .string()
    .describe('Path to docker-compose.yml file or its parent directory'),
  volumes: z
    .boolean()
    .optional()
    .describe('Remove named volumes (default: false)'),
  timeout: z
    .number()
    .optional()
    .describe('Shutdown timeout in seconds (default: 10)'),
});

export const ComposePsSchema = z.object({
  path: z
    .string()
    .describe('Path to docker-compose.yml file or its parent directory'),
});

export const ComposeLogsSchema = z.object({
  path: z.string().describe('Path to docker-compose.yml directory'),
  services: z
    .array(z.string())
    .optional()
    .describe('Specific services to tail'),
  tail: z
    .number()
    .optional()
    .describe('Number of lines to show (default: 100)'),
  follow: z.boolean().optional().describe('Follow log output (default: false)'),
});

export const ComposeRestartSchema = z.object({
  path: z
    .string()
    .describe('Path to docker-compose.yml file or its parent directory'),
  services: z
    .array(z.string())
    .optional()
    .describe('Specific services to restart (empty = all)'),
  timeout: z
    .number()
    .optional()
    .describe('Shutdown timeout in seconds (default: 10)'),
});

// Health schemas
export const CheckHealthSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  type: z
    .enum(['http', 'tcp', 'exec'])
    .optional()
    .describe('Probe type (default: auto-detect from HEALTHCHECK)'),
  endpoint: z.string().optional().describe('HTTP endpoint or TCP port'),
  command: z.array(z.string()).optional().describe('Command for exec probe'),
});

export const WatchHealthSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  timeout: z
    .number()
    .max(600)
    .optional()
    .describe('Max seconds to wait (default: 60, max: 600)'),
  interval: z
    .number()
    .max(60)
    .optional()
    .describe('Seconds between polls (default: 5, max: 60)'),
});

export const SetRestartPolicySchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  policy: z
    .enum(['no', 'always', 'unless-stopped', 'on-failure'])
    .describe('Restart policy'),
  max_retry_count: z
    .number()
    .optional()
    .describe('Max retry count for on-failure (default: 0)'),
});

// Logs schemas
export const StreamLogsSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  tail: z
    .number()
    .max(10000)
    .optional()
    .describe('Number of lines to show (default: 100, max: 10000)'),
  since: z
    .string()
    .optional()
    .describe("Show logs since timestamp (e.g., '2026-01-01T00:00:00Z')"),
  follow: z.boolean().optional().describe('Follow log output (default: false)'),
});

export const ContainerStatsSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
});

// Exec schema (validated per Finding 8.1 — command/working_dir/env constraints)
export const ExecInContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  command: z
    .array(
      z
        .string()
        .max(500)
        .regex(SAFE_CMD_ARG, 'Command arg contains disallowed characters'),
    )
    .min(1)
    .max(50)
    .describe(
      'Command to execute (max 50 args, alphanumeric + safe chars only)',
    ),
  working_dir: z
    .string()
    .regex(SAFE_PATH, "Working directory must be an absolute path without '..'")
    .max(1000)
    .optional()
    .describe('Working directory inside container (absolute path)'),
  env: z
    .record(
      z
        .string()
        .regex(SAFE_ENV_KEY, 'Env key must be POSIX-style (A-Z, 0-9, _)')
        .max(100),
      z.string().max(1000),
    )
    .optional()
    .describe('Environment variables (keys must be POSIX-style)'),
});

// Network/Volume schemas
export const ListNetworksSchema = z.object({
  filter: z.string().optional().describe('Filter by name or driver'),
});

export const CreateNetworkSchema = z.object({
  name: z.string().min(1).max(255).describe('Network name'),
  driver: z.string().optional().describe("Network driver (default: 'bridge')"),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe('Labels to apply to the network'),
});

export const RemoveNetworkSchema = z.object({
  network_id: z.string().min(1).describe('Network ID or name to remove'),
});

export const ListVolumesSchema = z.object({
  filter: z.string().optional().describe('Filter by name or driver'),
});

export const CreateVolumeSchema = z.object({
  name: z.string().min(1).max(255).describe('Volume name'),
  driver: z.string().optional().describe("Volume driver (default: 'local')"),
  labels: z
    .record(z.string(), z.string())
    .optional()
    .describe('Labels to apply to the volume'),
  options: z
    .record(z.string(), z.string())
    .optional()
    .describe('Driver-specific options'),
});

export const InspectVolumeSchema = z.object({
  name: z.string().min(1).describe('Volume name or ID to inspect'),
});

export const RemoveVolumeSchema = z.object({
  name: z.string().min(1).describe('Volume name or ID to remove'),
  force: z
    .boolean()
    .optional()
    .describe('Force removal even if in use (default: false)'),
});

export const PruneVolumesSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe("Filter by label (e.g., 'label=key=value')"),
});

export const PruneContainersSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe("Filter by label (e.g., 'label=key=value')"),
});

export const PruneImagesSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe('Docker filters JSON (e.g. "dangling=true")'),
});

export const UpdateContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  cpu_limit: z
    .number()
    .optional()
    .describe('CPU limit in cores (e.g. 1.5 for 1.5 CPUs)'),
  memory_limit: z
    .string()
    .optional()
    .describe('Memory limit (e.g. "512m", "1g", "2048m")'),
  cpu_shares: z
    .number()
    .optional()
    .describe('CPU shares (relative weight, 0-1024)'),
});

// Monitoring schemas (v0.2.0)
export const ContainerHealthStatusSchema = z.object({});

export const ContainerResourceUsageSchema = z.object({
  sort_by: z
    .enum(['cpu', 'memory', 'network'])
    .optional()
    .describe('Sort results by metric (default: cpu)'),
});

export const WatchEventsSchema = z.object({
  container: z.string().optional().describe('Filter by container name or ID'),
  event_type: z
    .enum(['start', 'stop', 'die', 'restart', 'health_status', 'oom', 'all'])
    .optional()
    .describe('Filter by event type (default: all)'),
  since: z
    .string()
    .optional()
    .describe("Show events since timestamp (e.g., '2026-01-01T00:00:00Z')"),
  duration: z
    .number()
    .max(300)
    .optional()
    .describe('Max seconds to listen (default: 30, max: 300)'),
});

export const SearchLogsSchema = z.object({
  pattern: z.string().max(1000).describe('Regex or grep pattern to search for'),
  containers: z
    .array(z.string())
    .max(50)
    .optional()
    .describe('Specific containers to search (default: all running, max: 50)'),
  tail: z
    .number()
    .max(10000)
    .optional()
    .describe('Max lines to scan per container (default: 500, max: 10000)'),
  since: z.string().optional().describe('Only search logs since timestamp'),
  ignore_case: z
    .boolean()
    .optional()
    .describe('Case-insensitive search (default: false)'),
});

export const ResourceAlertCheckSchema = z.object({
  cpu_percent: z
    .number()
    .optional()
    .describe('Alert if CPU usage exceeds this % (default: 80)'),
  memory_percent: z
    .number()
    .optional()
    .describe('Alert if memory usage exceeds this % (default: 80)'),
  restart_count: z
    .number()
    .optional()
    .describe('Alert if restart count exceeds this (default: 5)'),
});

export const MonitorDashboardSchema = z.object({});

// System info schemas (v0.3.3)
export const DockerInfoSchema = z.object({});

export const DiskUsageSchema = z.object({});

// File transfer schemas (v0.3.4)
export const CopyFromContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  container_path: z
    .string()
    .describe(
      "Path inside container to copy from (e.g., '/etc/nginx/nginx.conf')",
    ),
});

export const CopyToContainerSchema = z.object({
  container_id: z.string().describe('Container ID or name'),
  container_path: z
    .string()
    .describe("Destination path inside container (e.g., '/app/config.json')"),
  content: z.string().describe('File content to write (plain text)'),
  mode: z
    .number()
    .optional()
    .describe('File permissions in octal (e.g., 0o644 = 420). Default: 0o644'),
});

// Registry operation schemas (v0.4.0)
export const RegistryLoginSchema = z.object({
  username: z.string().describe('Registry username'),
  password: z.string().describe('Registry password or access token'),
  server: z
    .string()
    .optional()
    .describe('Registry server URL (default: Docker Hub)'),
});

export const RegistrySearchSchema = z.object({
  term: z.string().describe('Search term for Docker Hub images'),
});

export const RegistryPushSchema = z.object({
  image: z
    .string()
    .describe("Image name to push (e.g., 'myregistry.com/myimage')"),
  tag: z.string().optional().describe("Image tag (default: 'latest')"),
});

// Security scanning schemas (v0.4.0)
export const ScanImageSchema = z.object({
  image: z
    .string()
    .describe("Docker image name to scan (e.g., 'nginx:latest')"),
  tag: z.string().optional().describe("Image tag to scan (default: 'latest')"),
  severity: z
    .string()
    .optional()
    .describe(
      "Comma-separated severities to include (default: 'CRITICAL,HIGH,MEDIUM')",
    ),
  timeout: z
    .number()
    .optional()
    .describe('Max seconds to wait for scan (default: 120)'),
});

export const VulnerabilityReportSchema = z.object({
  image: z.string().describe('Docker image name for vulnerability report'),
  tag: z.string().optional().describe("Image tag (default: 'latest')"),
  severity: z
    .string()
    .optional()
    .describe("Severities to include (default: 'CRITICAL,HIGH,MEDIUM,LOW')"),
  timeout: z
    .number()
    .optional()
    .describe('Max seconds for report generation (default: 180)'),
});

// Docker context schemas (v0.4.0)
export const ListContextsSchema = z.object({});

export const UseContextSchema = z.object({
  context_name: z.string().describe('Name of the Docker context to activate'),
});

export const InspectContextSchema = z.object({
  context_name: z.string().describe('Name of the Docker context to inspect'),
});
