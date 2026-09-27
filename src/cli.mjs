#!/usr/bin/env node
import net from 'node:net';
import { DEFAULT_PORT, lanUrls, startHub } from './hub/server.mjs';

const USAGE = `eee-review hub               start the review hub (tablet pages and agent API) on port ${DEFAULT_PORT}
eee-review mcp               MCP server over stdio for a coding agent; starts the hub if needed
eee-review deploy [host]     install and start the eeereview app on the tablet over telnet
                             (host defaults to $EEE_TABLET)`;

const [command, ...args] = process.argv.slice(2);

if (command === 'hub') {
  const { urls } = await startHub({ log: (...parts) => console.log(new Date().toLocaleTimeString(), ...parts) });
  console.log(`eee-review hub on port ${DEFAULT_PORT}. On the tablet: ${urls.join('  ')}`);
} else if (command === 'mcp') {
  const { startMcp } = await import('./mcp/server.mjs');
  await startMcp();
} else if (command === 'deploy') {
  await deploy(args[0] ?? process.env.EEE_TABLET);
} else {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

// The tablet runs FreeeNote's telnetd. The app is fetched from the
// hub with the tablet's busybox wget and started with the environment the stock note app
// runs in, which carries the Qt Embedded display and library settings.
async function deploy(host) {
  const hubUrl = lanUrls(DEFAULT_PORT).find((u) => sameSubnet(u, host)) ?? lanUrls(DEFAULT_PORT)[0];
  if (!hubUrl) throw new Error('no network address to offer the tablet');
  const dir = '/eTablet/eee-review';
  const session = await telnet(host);
  const run = async (cmd, wait = 1500) => console.log((await session.run(cmd, wait)).trim());
  await run('root', 1500);
  await run('', 800);
  await run(
    `killall eeereview 2>/dev/null; mkdir -p ${dir} && cd ${dir} && wget -q -O eeereview.new ${hubUrl}native/eeereview && mv eeereview.new eeereview && chmod +x eeereview && ls -l eeereview`,
    5000,
  );
  await run(
    `export $(tr '\\0' '\\n' < /proc/$(pidof noteeditor)/environ | grep -E '^(QWS_|QTDIR|LD_LIBRARY_PATH|TSLIB|FONTCONFIG|HOME)')`,
  );
  await run(`((./eeereview ${hubUrl} ; echo "exit $?") > /tmp/eeereview.log 2>&1 &)`);
  await new Promise((r) => setTimeout(r, 4000));
  await run('cat /tmp/eeereview.log; pidof eeereview');
  session.close();
}

function sameSubnet(url, host) {
  const a = new URL(url).hostname.split('.').slice(0, 3).join('.');
  return a === host.split('.').slice(0, 3).join('.');
}

function telnet(host) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(23, host);
    let buffer = '';
    socket.setTimeout(10000, () => socket.destroy(new Error(`telnet to ${host} timed out`)));
    socket.on('error', reject);
    socket.on('data', (data) => {
      const out = [];
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 255 && i + 2 < data.length && data[i + 1] >= 251) {
          socket.write(Buffer.from([255, data[i + 1] <= 252 ? 254 : 252, data[i + 2]]));
          i += 2;
        } else out.push(data[i]);
      }
      buffer += Buffer.from(out).toString('utf8');
    });
    socket.on('connect', () =>
      resolve({
        run: (cmd, wait) =>
          new Promise((done) => {
            buffer = '';
            socket.write(`${cmd}\n`);
            setTimeout(() => done(buffer), wait);
          }),
        close: () => socket.end(),
      }),
    );
  });
}
