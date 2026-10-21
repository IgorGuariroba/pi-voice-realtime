import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openEchoAudio, EchoCleanup } from '../echo.ts';

test('cleanup retains failed handles for retry', async () => {
 const cleanup = new EchoCleanup();
 let attempts = 0;
 const handle = { close: async () => { if (++attempts === 1) throw new Error('busy'); } };
 cleanup.add(handle);
 await assert.rejects(cleanup.flush(), /busy/);
 await cleanup.flush();
 await cleanup.flush();
 assert.equal(attempts, 2);
});

test('unsupported platforms fail without invoking pactl', { skip: process.platform === 'linux' }, async () => {
 await assert.rejects(openEchoAudio(async () => { throw new Error('should not run'); }), /Linux/);
});

test('AEC owns a paired capture/playback route and unloads once', { skip: process.platform !== 'linux' }, async () => {
 const calls: string[][] = [];
 const run = async (args: string[]) => { calls.push(args); return args[0] === 'load-module' ? '123\n' : ''; };
 const audio = await openEchoAudio(run);
 assert.equal(audio.capture.command, 'parec');
 assert.ok(audio.capture.args.includes('--latency-msec=30'));
 assert.equal(audio.playback.command, 'pacat');
 assert.ok(calls[0].includes('aec_method=webrtc'));
 const source = calls[0].find(a => a.startsWith('source_name='))!.split('=')[1];
 const sink = calls[0].find(a => a.startsWith('sink_name='))!.split('=')[1];
 assert.ok(audio.capture.args.includes(`--device=${source}`));
 assert.ok(audio.playback.args.includes(`--device=${sink}`));
 await audio.close(); await audio.close();
 assert.deepEqual(calls[1], ['unload-module', '123']);
 assert.equal(calls.length, 2);
});
