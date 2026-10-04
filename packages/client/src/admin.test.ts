import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_STORAGE_KEY, resolveAdminMode } from './admin.js';

describe('resolveAdminMode', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('?admin=1 включает и запоминает, без параметра — как запомнено', () => {
    expect(resolveAdminMode('?admin=1', localStorage)).toBe(true);
    expect(localStorage.getItem(ADMIN_STORAGE_KEY)).toBe('1');
    expect(resolveAdminMode('', localStorage)).toBe(true);
    expect(resolveAdminMode('?lab=camera', localStorage)).toBe(true);
  });

  it('?admin=0 снимает и удаляет ключ', () => {
    localStorage.setItem(ADMIN_STORAGE_KEY, '1');
    expect(resolveAdminMode('?admin=0', localStorage)).toBe(false);
    expect(localStorage.getItem(ADMIN_STORAGE_KEY)).toBeNull();
  });

  it('чистое устройство и мусор в параметре — выключено', () => {
    expect(resolveAdminMode('', localStorage)).toBe(false);
    expect(resolveAdminMode('?admin=yes', localStorage)).toBe(false);
    expect(localStorage.getItem(ADMIN_STORAGE_KEY)).toBeNull();
  });
});
