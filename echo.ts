/** Linux PulseAudio/PipeWire WebRTC AEC. Never changes default devices.
 * Both streams MUST use this pair: playback supplies the echo reference.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Backend } from './audio.ts';
const exec = promisify(execFile);
type Run = (args: string[]) => Promise<string>;
const pactl: Run = async args => (await exec('pactl', args, { timeout: 5000 })).stdout;
/** Retains ownership after unload failure; serializes overlapping cleanup requests. */
export class EchoCleanup {
 private readonly pending = new Set<{ close(): Promise<void> }>();
 private running: Promise<void> | undefined;
 add(handle: { close(): Promise<void> }): void { this.pending.add(handle); }
 flush(): Promise<void> {
  if (this.running) return this.running;
  this.running = (async () => {
   let failure: unknown;
   for (const handle of this.pending) {
    try { await handle.close(); this.pending.delete(handle); }
    catch (error) { failure = error; }
   }
   if (failure) throw failure;
  })().finally(() => { this.running = undefined; });
  return this.running;
 }
}

export interface EchoAudio {
 capture: Backend;
 playback: Backend;
 close(): Promise<void>;
}
export async function openEchoAudio(run: Run = pactl): Promise<EchoAudio> {
 if (process.platform !== 'linux') throw new Error('AEC requer PulseAudio/PipeWire no Linux');
 const name = `pi_voice_${randomUUID().replaceAll('-', '')}`;
 const source = `${name}_source`, sink = `${name}_sink`;
 const id = (await run(['load-module', 'module-echo-cancel', 'aec_method=webrtc',
  `source_name=${source}`, `sink_name=${sink}`, 'rate=48000', 'channels=1'])).trim();
 if (!/^\d+$/.test(id)) throw new Error('AEC retornou identificador de módulo inválido');
 let closed = false;
 const format = ['--raw', '--format=s16le', '--rate=24000', '--channels=1'];
 return {
  capture: { command: 'parec', args: [...format, `--device=${source}`] },
  playback: { command: 'pacat', args: ['--playback', ...format, `--device=${sink}`] },
  async close() {
   if (closed) return;
   closed = true;
   try { await run(['unload-module', id]); }
   catch (error) { closed = false; throw error; }
  },
 };
}
