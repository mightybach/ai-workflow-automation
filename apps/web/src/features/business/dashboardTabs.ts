import type { IconName } from '../../components/Icon';
export const dashboardTabs = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'appointments', label: 'Bookings', icon: 'calendar' },
  { id: 'workflows', label: 'Workflows', icon: 'spark' },
  { id: 'team', label: 'Team', icon: 'team' },
  { id: 'services', label: 'Services', icon: 'folder' },
  { id: 'inventory', label: 'Inventory', icon: 'calendar' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
export type DashboardTab = typeof dashboardTabs[number]['id'];
export function dashboardTabFromHash(): DashboardTab {
  return dashboardTabs.find((tab) => '#' + tab.id === window.location.hash)?.id ?? 'overview';
}
