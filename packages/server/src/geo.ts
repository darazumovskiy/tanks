import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Reader, type AsnResponse, type CityResponse, type Response } from 'mmdb-lib';

export const GEO_CITY_FILE = 'dbip-city-lite.mmdb';
export const GEO_PROVIDER_FILE = 'dbip-asn-lite.mmdb';

// Пустые поля уходят из JSON визита сами: JSON.stringify пропускает undefined.
interface GeoInfo {
  country: string | undefined;
  countryName: string | undefined;
  city: string | undefined;
  asn: number | undefined;
  org: string | undefined;
}

export type GeoLookup = (ip: string) => GeoInfo;

export const NO_GEO: GeoLookup = () => ({
  country: undefined,
  countryName: undefined,
  city: undefined,
  asn: undefined,
  org: undefined,
});

// Битая или недокачанная база не роняет сервер: гео визитов просто пустое.
function openReader<T extends Response>(path: string): Reader<T> | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return new Reader<T>(readFileSync(path));
  } catch (error) {
    console.warn(`база гео ${path} не открылась: ${String(error)}`);
    return null;
  }
}

// Базы DB-IP читаются целиком в память при старте: поиск в обработчике запроса не трогает диск.
export function openGeo(dir: string): GeoLookup {
  const cities = openReader<CityResponse>(join(dir, GEO_CITY_FILE));
  const providers = openReader<AsnResponse>(join(dir, GEO_PROVIDER_FILE));
  return (ip) => {
    const place = cities?.get(ip);
    const provider = providers?.get(ip);
    return {
      country: place?.country?.iso_code,
      countryName: place?.country?.names.en,
      city: place?.city?.names.en,
      asn: provider?.autonomous_system_number,
      org: provider?.autonomous_system_organization,
    };
  };
}
