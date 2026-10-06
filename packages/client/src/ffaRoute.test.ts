import { describe, expect, it } from 'vitest';
import { ffaInvitePath, ffaRouteOf } from './ffaRoute.js';

describe('адрес общего боя', () => {
  it.each([
    ['/ffa', { size: 30, gameId: '' }],
    ['/ffa/10', { size: 10, gameId: '' }],
    ['/ffa/50', { size: 50, gameId: '' }],
    ['/ffa/10/K7MF', { size: 10, gameId: 'K7MF' }],
    ['/ffa/30/x', { size: 30, gameId: 'x' }],
  ])('%s — размер и номер игры', (pathname, route) => {
    expect(ffaRouteOf(pathname)).toEqual(route);
  });

  it.each([
    '/',
    '/ffa/',
    '/ffa/11',
    '/ffa/11/K7MF',
    '/ffa/10/',
    '/ffa/10/K7MF/x',
    '/ffa/10/K7-F',
    `/ffa/10/${'A'.repeat(17)}`,
    '/d/abc',
  ])('%s — не общий бой', (pathname) => {
    expect(ffaRouteOf(pathname)).toBeNull();
  });

  it('ссылка приглашения разбирается обратно в ту же игру', () => {
    expect(ffaInvitePath(10, 'K7MF')).toBe('/ffa/10/K7MF');
    expect(ffaRouteOf(ffaInvitePath(50, 'Z2Q9'))).toEqual({ size: 50, gameId: 'Z2Q9' });
  });
});
