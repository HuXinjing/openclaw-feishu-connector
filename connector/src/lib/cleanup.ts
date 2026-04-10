/**
 * Orphaned Resource Cleanup — ClawManager ops pattern.
 * Scans for Docker containers not tracked in the user map on startup.
 */
import { listOpenclawContainers, stopContainer, removeContainer } from '../docker.js';
import { findAllUsers } from '../user-map.js';

export interface CleanupResult {
  removed: string[];
  errors: string[];
}

/**
 * Scan Docker for containers that have no corresponding user record.
 * Stops and removes orphaned containers.
 */
export async function cleanupOrphanedResources(): Promise<CleanupResult> {
  const containers = await listOpenclawContainers();
  const users = findAllUsers();
  const validContainerIds = new Set(
    users.map(u => u.status.containerId).filter(Boolean)
  );

  const orphaned: string[] = [];
  for (const container of containers) {
    const containerId = container.id;
    const name = container.name || '';

    // Skip non-planC containers
    if (!name.startsWith('openclaw-')) continue;

    // Orphan if no user record references this container
    if (!validContainerIds.has(containerId)) {
      orphaned.push(containerId);
    }
  }

  const errors: string[] = [];
  const removed: string[] = [];

  for (const containerId of orphaned) {
    try {
      await stopContainer(containerId);
      await removeContainer(containerId);
      removed.push(containerId);
      console.log(`[Cleanup] Removed orphaned container: ${containerId}`);
    } catch (err) {
      const msg = `Failed to cleanup ${containerId}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      console.error(`[Cleanup] ${msg}`);
    }
  }

  return { removed, errors };
}
