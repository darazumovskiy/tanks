// Игра с плохой сетью для оператора: собранный сервер на выбранном порту, посредник с выбранной связью перед ним
// на следующем и пульт на предыдущем, все доступны из локальной сети. Аргументы задают начальное состояние, дальше
// его меняет пульт. Запуск — `npm run bad-net -- [сокращение] [--ping] [--jitter] [--lead] [--inherit] [--smooth-net]
// [--port]`.
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  describeNetSmoothing,
  describeNetwork,
  describeShotInherit,
  describeShotLead,
  NETWORK_USAGE,
  networkShape,
  parseNetworkArgs,
  type NetworkChoice,
} from './networkProfile.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const REQUIRED_BUILD = [
  'packages/shared/dist/protocol/index.js',
  'packages/server/dist/main.js',
  'packages/client/dist/index.html',
];
const ALL_INTERFACES = '0.0.0.0';
const MAC_HOST = 'localhost';
const FFA_PATH = '/ffa/10';
// Бой толпы начинается через секунду: серверные боты добирают игру до обычного минимума, живых игроков не ждём.
const SERVER_ENV = { FFA_LOBBY_WAIT_SECONDS: '1', HOST: ALL_INTERFACES };
const EXIT_FAILURE = 1;

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_FAILURE);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseChoice(): NetworkChoice {
  try {
    return parseNetworkArgs(process.argv.slice(2));
  } catch (error) {
    return fail(`${errorText(error)}\n\n${NETWORK_USAGE}`);
  }
}

interface Host {
  label: string;
  address: string;
}

// Имя интерфейса в подписи: Wi‑Fi Mac — обычно en0, туннели VPN — utun.
function lanHosts(): Host[] {
  return Object.entries(networkInterfaces()).flatMap(([name, infos]) =>
    (infos ?? [])
      .filter((info) => info.family === 'IPv4' && !info.internal)
      .map((info) => ({ label: `телефон, ${name}`, address: info.address })),
  );
}

function hostLines(port: number, hosts: readonly Host[], describe: (origin: string) => string): string[] {
  const width = Math.max(...hosts.map((host) => host.label.length));
  return hosts.map((host) => `    ${host.label.padEnd(width)}  ${describe(`http://${host.address}:${String(port)}`)}`);
}

function links(port: number, hosts: readonly Host[]): string[] {
  return hostLines(port, hosts, (origin) => `бой толпы ${origin}${FFA_PATH}   главная ${origin}/`);
}

const choice = parseChoice();
const missing = REQUIRED_BUILD.filter((file) => !existsSync(`${ROOT}/${file}`));
if (missing.length > 0) {
  fail(`Нет сборки: ${missing.join(', ')}. Сначала — npm run build`);
}

// Посредник и пульт берут кодек и константы из собранного `@tanks/shared`: импорт — только после проверки сборки.
const netProxyModule = await import('./netProxy.js');
const serverModule = await import('./server.js');
const panelModule = await import('./badNetPanel.js');

const directPort = choice.port;
const proxyPort = choice.port + 1;
const panelPort = choice.port - 1;
const server = new serverModule.GameServer({ ...SERVER_ENV, ...panelModule.serverSettingsEnv(choice) });
const busyHint = `Порт ${String(panelPort)}, ${String(directPort)} или ${String(proxyPort)} занят — bad-net уже запущен?`;
await server.start(directPort).catch((error: unknown) => fail(`Сервер не поднялся: ${errorText(error)}. ${busyHint}`));
const proxy = await netProxyModule.NetProxy.start(directPort, {
  ...networkShape(choice.network),
  port: proxyPort,
  host: ALL_INTERFACES,
}).catch(async (error: unknown) => {
  await server.stop();
  return fail(`Посредник не поднялся: ${errorText(error)}. ${busyHint}`);
});
const panel = await panelModule
  .startPanel({
    port: panelPort,
    host: ALL_INTERFACES,
    proxy,
    server,
    network: choice.network,
    shotLeadTicks: choice.shotLeadTicks,
    shotInheritPercent: choice.shotInheritPercent,
    hasNetSmoothing: choice.hasNetSmoothing,
    directPort,
    proxyPort,
  })
  .catch(async (error: unknown) => {
    await proxy.close();
    await server.stop();
    return fail(`Пульт не поднялся: ${errorText(error)}. ${busyHint}`);
  });

const hosts = [{ label: 'Mac', address: MAC_HOST }, ...lanHosts()];
console.log(
  [
    `  Пульт — пинг, неровность, лаг-компенсация, скорость танка у снаряда и сглаживание кнопками, порт ${String(panel.port)}:`,
    ...hostLines(panel.port, hosts, (origin) => `${origin}/`),
    '',
    `Плохая сеть: ${describeNetwork(choice.network)}`,
    `Лаг-компенсация: ${describeShotLead(choice.shotLeadTicks)}`,
    `Снаряд со скоростью танка: ${describeShotInherit(choice.shotInheritPercent)}`,
    `Сглаживание сети: ${describeNetSmoothing(choice.hasNetSmoothing)}`,
    '',
    `  Через плохую сеть, порт ${String(proxyPort)}:`,
    ...links(proxyPort, hosts),
    `  Напрямую для сравнения, порт ${String(directPort)}:`,
    ...links(directPort, hosts),
    '',
    `  Журналы сервера: ${server.logDir}`,
    '  В журнале боя — строки «sec … corr= gap=» от клиентов и «input overflow» от сервера.',
    '',
    'Ctrl+C — остановить.',
  ].join('\n'),
);

let isStopping = false;
async function stop(): Promise<void> {
  if (isStopping) {
    return;
  }
  isStopping = true;
  await panel.close();
  await proxy.close();
  await server.stop();
  console.log(`Остановлено. Журналы: ${server.logDir}`);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void stop();
  });
}
