#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, lanUrls, startHub } from './hub/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USB_TELNET = 2323;

const USAGE = `eee-review hub               start the review hub (tablet pages and agent API) on port ${DEFAULT_PORT},
                             and the USB link to the tablet when native/eeelink/eeelink-host is built
eee-review mcp               MCP server over stdio for a coding agent; starts the hub if needed
eee-review deploy [host]     install and start the app on the tablet over telnet: through the USB
                             link when it is up, else over Wi-Fi to host ($EEE_TABLET)
Environment: EEE_REVIEW_HOME, EEE_REVIEW_PORT, EEE_REVIEW_BIND (127.0.0.1 for cable only)`;

const [command, ...args] = process.argv.slice(2);

if (command === 'hub') {
  const log = (...parts) => console.log(new Date().toLocaleTimeString(), ...parts);
  const { urls } = await startHub({ log });
  console.log(`eee-review hub on port ${DEFAULT_PORT}. On the tablet: ${[...urls, 'USB cable'].join('  ')}`);
  startUsbLink(log);
} else if (command === 'mcp') {
  const { startMcp } = await import('./mcp/server.mjs');
  await startMcp();
} else if (command === 'deploy') {
  await deploy(args[0] ?? process.env.EEE_TABLET);
} else {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

// eeelink's Mac end: claims the tablet's USB bulk endpoints, connects the tablet's requests
// to this hub, and forwards USB_TELNET here to the tablet's telnetd. It waits for the tablet
// on its own, so it runs for as long as the hub does.
function startUsbLink(log) {
  const binary = path.join(root, 'native/eeelink/eeelink-host');
  if (!fs.existsSync(binary)) return;
  const run = () => {
    const child = spawn(binary, [`${USB_TELNET}:23`], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => log(d.toString().trim()));
    child.on('exit', (code) => {
      log(`eeelink exited (${code}), restarting`);
      setTimeout(run, 3000);
    });
    process.on('exit', () => child.kill());
  };
  run();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
}

// The tablet runs FreeeNote's telnetd. Over the cable it is reached
// through eeelink and fetches from the hub through eeelink's tablet end at 127.0.0.1:8770;
// over Wi-Fi it is reached directly and fetches from this machine's address on its subnet.
async function deploy(host) {
  const usb = await reachable('127.0.0.1', USB_TELNET);
  const lan = lanUrls(DEFAULT_PORT).find((u) => sameSubnet(u, host)) ?? lanUrls(DEFAULT_PORT)[0];
  const hubUrl = usb ? `http://127.0.0.1:${DEFAULT_PORT}/` : lan;
  if (!hubUrl) throw new Error('no route to the tablet: no USB link and no network address');
  console.log(usb ? 'deploying through the USB cable' : `deploying over Wi-Fi to ${host}`);
  const dir = '/eTablet/eee-review';
  const session = await telnet(usb ? '127.0.0.1' : host, usb ? USB_TELNET : 23);
  const run = async (cmd, wait = 1500) => console.log((await session.run(cmd, wait)).trim());
  await run('root', 1500);
  await run('', 800);
  const fetch = (name) =>
    `wget -q -O ${name}.new ${hubUrl}native/${name} && mv ${name}.new ${name} && chmod +x ${name}`;
  await run(
    `mkdir -p ${dir} && cd ${dir} && ${fetch('start.sh')} && ${fetch('eeereview')} && ${fetch('eeelink')} && ls -l`,
    8000,
  );
  if (lan) await run(`echo ${lan} > ${dir}/hub-wifi`);
  await installLauncherEntry(run, hubUrl);
  await run('cat /tmp/eeereview.log /tmp/eeelink.log; pidof eeereview eeelink');
  // The new eeelink replaces the running one. Over the cable that ends this session, which the
  // old one carries, so the restart runs detached and the session is not waited on.
  await run(`(trap '' HUP; sleep 1; killall eeelink eeereview; ${dir}/start.sh) </dev/null >/dev/null 2>&1 &`, 1500);
  session.close();
}

// The stock launcher lists apps from Config.xml, and eeeserver starts <path> as
// /usr/local/eTablet/bin/<path>/<path>, but only for apps registered in its own .Aconfig: an
// unregistered one takes the whole GUI down with it. The link points at the copy deploy
// refreshes. /usr is mounted read-only, so it is remounted writable for the
// change and read-only again after. Config.xml is saved once as .orig
// before the entry is added, and the entry only goes in when it is missing.
async function installLauncherEntry(run, hubUrl) {
  const bin = '/usr/local/eTablet/bin/eeereview';
  const icons = '/usr/local/eTablet/bin/launcher/icon';
  const config = '/eTablet/etc/launcher/Config.xml';
  const registry = '/eTablet/etc/server/.Aconfig';
  const entry =
    '<Ap thumbnail="icon/icon_b_eeereview.png" note="Specs, plans and code reviewed with the pen, round by round with a coding agent." action="Startup" path="eeereview" icon="icon/icon_s_eeereview.png" name="eee-review"/>';
  await run(
    [
      'mount -o remount,rw /usr',
      `mkdir -p ${bin}`,
      `rm -f ${bin}/eeereview`,
      `ln -s /eTablet/eee-review/eeereview ${bin}/eeereview`,
      `wget -q -O ${icons}/icon_b_eeereview.png ${hubUrl}native/icon_b_eeereview.png`,
      `wget -q -O ${icons}/icon_s_eeereview.png ${hubUrl}native/icon_s_eeereview.png`,
      'sync',
      'mount -o remount,ro /usr',
    ].join('; '),
    6000,
  );
  await run(
    `grep -q 'path="eeereview"' ${config} || { [ -f ${config}.orig ] || cp ${config} ${config}.orig; sed 's#</AppList>#${entry}</AppList>#' ${config} > ${config}.new && mv ${config}.new ${config}; }; grep -c 'path="eeereview"' ${config}; mount | grep ' /usr '`,
  );
  await run(
    `grep -q 'TITLE=eeereview' ${registry} || { [ -f ${registry}.orig ] || cp ${registry} ${registry}.orig; printf '\\nTITLE=eeereview\\nLOCATION=eeereview/\\nLEVEL=1\\nAPPEND\\n' >> ${registry}; }; grep -c 'TITLE=eeereview' ${registry}`,
  );
}

function reachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.setTimeout(3000);
    socket.once('data', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.once('close', () => resolve(false));
  });
}

function sameSubnet(url, host) {
  const a = new URL(url).hostname.split('.').slice(0, 3).join('.');
  return a === host.split('.').slice(0, 3).join('.');
}

function telnet(host, port = 23) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
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
