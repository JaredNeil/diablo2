import { Diablo2MpqData } from '@diablo2/data';
import { Diablo2MpqLoader } from '@diablo2/bintools';
import { toHex } from 'binparse';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import PLimit from 'p-limit';
import { createInterface } from 'readline';
import { Log, LogType } from '../logger.js';
import { run } from './child.process.js';
import { LruCache } from './lru.js';
import { Diablo2Map, Diablo2MapGenMessage, MapGenMessageInfo, MapGenMessageMap } from './map.js';

export const MapCommand = './bin/d2-map.exe';
export const Diablo2Path = '/app/game';
export const RegistryPath = '/app/d2.install.reg';
export const WineCommand = 'wine';

/** Wait at most 10 seconds for things to work */
const ProcessTimeout = 30_000;
const MaxMapsToGenerate = 10;

interface LogMessage {
  time: number;
  level: number;
  msg: string;
}

async function timeOut(message: string, timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(`${message} Timeout after ${timeout}ms`), timeout);
    timer.unref();
  });
}

function getJson<T>(s: string): T | null {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

export type Diablo2MapResponse = { [key: string]: Diablo2Map };

const cwd = process.cwd();
export class Diablo2MapProcess {
  cache: LruCache<Diablo2MapResponse> = new LruCache(100);
  process: ChildProcess | null;
  /** Number of maps generated by this process */
  generatedCount = 0;
  events: EventEmitter = new EventEmitter();
  mpq: Diablo2MpqData;
  /**
   * Limit the map generation to a single thread
   * TODO having a pool of these map processes would be quite nice
   */
  q = PLimit(1);

  /** Get the version of WINE that is being used */
  async version(log: LogType): Promise<string> {
    const versionResponse = await run(WineCommand, ['--version']);
    const version = versionResponse.stdout;
    log.info({ version, command: WineCommand }, 'WineVersion');
    return version;
  }

  /** Start the map process waiting for the `init` event before allowing anything to continue */
  async start(log: LogType): Promise<void> {
    if (this.process != null) {
      Log.warn({ pid: this.process.pid }, 'MapProcess already started');
      return;
    }
    this.generatedCount = 0;

    this.mpq = await Diablo2MpqLoader.load(Diablo2Path, log);

    const res = await run(WineCommand, ['regedit', RegistryPath]);
    log.info({ data: res.stdout }, 'Registry:Update');

    const args = [MapCommand, Diablo2Path];
    log.info({ wineArgs: args }, 'MapProcess:Starting');

    return new Promise(async (resolve) => {
      const process = spawn(WineCommand, args, { cwd });
      if (process == null || process.stdout == null) throw new Error('Failed to start command');
      this.process = process;
      process.stderr.on('data', (data) => {
        Log.debug({ data: data.toString().trim() }, 'MapProcess:stderr');
      });
      process.on('error', (error) => {
        log.fatal({ error }, 'MapProcess:Died');
        inter.close();
        this.process = null;
      });
      process.on('close', (exitCode) => {
        inter.close();
        this.process = null;
        if (exitCode == null) return;
        if (exitCode > 0) log.fatal({ exitCode }, 'MapProcess:Closed');
      });

      log.info({ pid: process.pid }, 'MapProcess:Started');
      const inter = createInterface(process.stdout).on('line', (line) => {
        const json = getJson<Diablo2MapGenMessage | LogMessage>(line);
        if (json == null) return;
        if ('time' in json) {
          if (json.level < 30) return;
          Log.info({ ...json, log: json.msg }, 'MapProcess:Log');
        } else if (json.type) this.events.emit(json.type, json);
      });
      await this.once('init');
      resolve();
    });
  }

  async once<T extends Diablo2MapGenMessage>(e: T['type'], cb?: () => void): Promise<T> {
    return Promise.race([
      new Promise((resolve) => {
        this.events.once(e, (data) => resolve(data));
        cb?.();
      }),
      timeOut(`Event: ${e}`, ProcessTimeout),
    ]) as Promise<T>;
  }

  async stop(log: LogType): Promise<void> {
    if (this.process == null) return;
    log.info({ pid: this.process.pid }, 'MapProcess:Stop');
    this.process.kill('SIGKILL');
    this.process = null;
  }

  async command(cmd: 'seed' | 'difficulty' | 'act', value: number, log: LogType): Promise<void> {
    const startTime = Date.now();
    if (this.process == null) await this.start(log);
    const command = `$${cmd} ${value}\n`;
    const res = await this.once<MapGenMessageInfo>('info', () => this.process?.stdin?.write(command));
    if (res[cmd] !== value) {
      throw new Error(`Failed to set ${cmd}=${value} (output: ${JSON.stringify(res)}: ${command})`);
    }

    log.trace({ cmd, value, duration: Date.now() - startTime }, 'MapProcess:Command');
  }

  map(seed: number, difficulty: number, actId: number, log: LogType): Promise<Diablo2MapResponse> {
    const mapKey = `${seed}_${difficulty}_${actId}`;
    const cacheData = this.cache.get(mapKey);
    if (cacheData != null) return Promise.resolve(cacheData);
    return this.q(async () => {
      const mapResult = await this.getMaps(seed, difficulty, actId, log);
      this.cache.set(mapKey, mapResult);
      return mapResult;
    });
  }

  private async getMaps(seed: number, difficulty: number, actId: number, log: LogType): Promise<Diablo2MapResponse> {
    if (this.generatedCount > MaxMapsToGenerate) {
      this.generatedCount = 0;
      await this.stop(log);
      await this.start(log);
    }

    await this.command('seed', seed, log);
    await this.command('difficulty', difficulty, log);
    if (actId > -1) await this.command('act', actId, log);

    this.generatedCount++;
    log.info({ seed: toHex(seed, 8), difficulty, generated: this.generatedCount }, 'GenerateMap:Start');
    const maps: Record<string, Diablo2Map> = {};

    const newMap = (msg: MapGenMessageMap): void => {
      log?.trace({ mapId: msg.id }, 'GenerateMap:GotMap');
      maps[msg.id] = this.fixMap(msg);
    };

    return await new Promise((resolve, reject) => {
      const failedTimer = setTimeout(() => {
        this.events.off('map', newMap);
        reject();
      }, ProcessTimeout);
      this.events.on('map', newMap);
      this.events.on('done', () => {
        this.events.off('map', newMap);
        clearTimeout(failedTimer);
        log?.trace({ count: Object.keys(maps).length }, 'GenerateMap:Generated');
        resolve(maps);
      });
      this.process?.stdin?.write(`$map\n`);
    });
  }

  /** Correct the names of npcs and objects */
  fixMap(map: MapGenMessageMap): MapGenMessageMap {
    for (const obj of map.objects) {
      if (obj.type === 'npc') obj.name = this.mpq.monsters.name(obj.id)?.trim();

      // Force lowercase all the sub types
      if (obj.type === 'object') {
        obj.name = this.mpq.objects.get(obj.id)?.name.trim();
      }

      if (obj.type === 'exit') {
        obj.name = this.mpq.levels.get(obj.id)?.name.trim();
      }
    }

    return map;
  }
}

export const MapProcess = new Diablo2MapProcess();
