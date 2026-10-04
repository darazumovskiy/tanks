export const ADMIN_STORAGE_KEY = 'tanks.admin';
const ADMIN_QUERY_KEY = 'admin';
const ADMIN_ON = '1';
const ADMIN_OFF = '0';

// `?admin=1` включает режим на устройстве, `?admin=0` выключает; без параметра — как запомнено.
export function resolveAdminMode(search: string, storage: Storage): boolean {
  const value = new URLSearchParams(search).get(ADMIN_QUERY_KEY);
  if (value === ADMIN_ON) {
    storage.setItem(ADMIN_STORAGE_KEY, ADMIN_ON);
  }
  if (value === ADMIN_OFF) {
    storage.removeItem(ADMIN_STORAGE_KEY);
  }
  return storage.getItem(ADMIN_STORAGE_KEY) === ADMIN_ON;
}
