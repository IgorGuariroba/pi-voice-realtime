import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openEchoAudio } from '../echo.ts';

test('AEC owns a paired capture/playback route and unloads once', async () => {
 const calls: string[][] = [];
 const run = async (args: string[]) => { calls.push(args); return args[0] === 'load-module' ? '123\n' : ''; };
 const audio = await openEchoAudio(run);
 assert.equal(audio.capture.command, 'parec');
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
