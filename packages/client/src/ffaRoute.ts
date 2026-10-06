import { FFA_SIZES, type FfaSize } from '@tanks/shared/engine';
import { FFA_PATH_GAME_ID } from '@tanks/shared/protocol';

const FFA_DEFAULT_SIZE: FfaSize = 30;
const FFA_ROUTE = new RegExp(`^/ffa(?:/(\\d+)(?:/(${FFA_PATH_GAME_ID}))?)?$`);

// gameId — номер игры из приглашения друга, пусто — любая игра этого размера.
export interface FfaRoute {
  size: FfaSize;
  gameId: string;
}

// null — адрес не общего боя или размер не из списка игр.
export function ffaRouteOf(pathname: string): FfaRoute | null {
  const match = FFA_ROUTE.exec(pathname);
  if (match === null) {
    return null;
  }
  const digits = match[1];
  if (digits === undefined) {
    return { size: FFA_DEFAULT_SIZE, gameId: '' };
  }
  const size = FFA_SIZES.find((candidate) => String(candidate) === digits);
  if (size === undefined) {
    return null;
  }
  return { size, gameId: match[2] ?? '' };
}

export function ffaInvitePath(size: FfaSize, gameId: string): string {
  return `/ffa/${String(size)}/${gameId}`;
}
