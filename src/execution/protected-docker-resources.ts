const BUILT_IN_DOCKER_NETWORKS = new Set(['bridge', 'host', 'none']);

export function isProtectedDockerNetwork(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    BUILT_IN_DOCKER_NETWORKS.has(name) ||
    normalized.startsWith('docker_labs-') ||
    normalized.includes('desktop-extension')
  );
}
