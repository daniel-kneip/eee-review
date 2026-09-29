#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, hubToken, lanUrls, startHub } from './hub/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USB_TELNET = 2323;

const USAGE = `eee-review hub               start the review hub (tablet pages and agent API) on port ${DEFAULT_PORT},
                             and the USB link to the tablet when native/eeelink/eeelink-host is built
eee-review mcp               MCP server over stdio for a coding agent; starts the hub if needed
eee-review agent <command>   the same for agents without MCP; starts the hub if needed:
  create [json]              send a review; json (or stdin): {title, kind, files, exclude, base,
                             head, repo, overview, comments}
  fetch <id>                 what the user sent; notes and page cuts are written as PNG files
  respond <id> [json]        answer the round; json (or stdin): {replies, files, exclude, overview,
                             comments, drafts}
  context <id> <file...>     add files to the round
  close <id>                 take the review off the tablet
  list                       all reviews
eee-review deploy [host]     install and start the app on the tablet over telnet: through the USB
                             link when it is up, else over Wi-Fi to host ($EEE_TABLET)
Environment: EEE_REVIEW_HOME, EEE_REVIEW_PORT, EEE_REVIEW_BIND (127.0.0.1 for cable only)`;

const [command, ...args] = process.argv.slice(2);

if (command === 'hub') {
  const log = (...parts) => console.log(new Date().toLocaleTimeString(), ...parts);
  const { urls, store } = await startHub({ log });
  console.log(`eee-review hub on port ${DEFAULT_PORT}. On the tablet: ${[...urls, 'USB cable'].join('  ')}`);
  if (urls.length) console.log(`In a browser elsewhere: ${urls[0]}?token=<${path.join(store.home, 'token')}>`);
  startUsbLink(log);
} else if (command === 'mcp') {
  const { startMcp } = await import('./mcp/server.mjs');
  await startMcp();
} else if (command === 'agent') {
  await agentCommand(args);
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
  const token = hubToken();
  if (!hubUrl) throw new Error('no route to the tablet: no USB link and no network address');
  console.log(usb ? 'deploying through the USB cable' : `deploying over Wi-Fi to ${host}`);
  const dir = '/eTablet/eee-review';
  const session = await telnet(usb ? '127.0.0.1' : host, usb ? USB_TELNET : 23);
  const run = async (cmd, wait = 1500) => console.log((await session.run(cmd, wait)).trim());
  await run('root', 1500);
  await run('', 800);
  const fetch = (name) =>
    `wget -q -O ${name}.new '${hubUrl}native/${name}?token=${token}' && mv ${name}.new ${name} && chmod +x ${name}`;
  await run(
    `mkdir -p ${dir} && cd ${dir} && ${fetch('start.sh')} && ${fetch('eeereview')} && ${fetch('eeelink')} && ls -l`,
    8000,
  );
  if (lan) await run(`echo ${lan} > ${dir}/hub-wifi`);
  await run(`echo ${token} > ${dir}/hub-token && chmod 600 ${dir}/hub-token`);
  await installLauncherEntry(run, hubUrl, token);
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
async function installLauncherEntry(run, hubUrl, token) {
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
      `wget -q -O ${icons}/icon_b_eeereview.png '${hubUrl}native/icon_b_eeereview.png?token=${token}'`,
      `wget -q -O ${icons}/icon_s_eeereview.png '${hubUrl}native/icon_s_eeereview.png?token=${token}'`,
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

// The agent CLI prints what the MCP tools return. Images go to files, which the agent opens
// with its own tools; their paths are printed where the images stand.
async function agentCommand([sub, ...rest]) {
  const agent = await import('./agent/client.mjs');
  const to = {
    fetch: (id) => `eee-review agent fetch ${id}`,
    respond: (id) => `eee-review agent respond ${id} (JSON mit replies auf stdin)`,
    context: (id) => `eee-review agent context ${id} <dateien>`,
    close: (id) => `eee-review agent close ${id}`,
  };
  const input = async (arg) => {
    if (arg) return JSON.parse(arg);
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.trim() ? JSON.parse(data) : {};
  };
  let parts;
  if (sub === 'create') parts = await agent.create(to, await input(rest[0]));
  else if (sub === 'fetch') parts = await agent.fetchRound(to, rest[0]);
  else if (sub === 'respond') parts = await agent.respond(to, rest[0], await input(rest[1]));
  else if (sub === 'context') parts = await agent.addContext(to, rest[0], rest.slice(1));
  else if (sub === 'close') parts = await agent.close(rest[0]);
  else if (sub === 'list') parts = await agent.list();
  else {
    console.log(USAGE);
    process.exit(1);
  }
  const dir = path.join(process.env.EEE_REVIEW_HOME ?? path.join(os.homedir(), '.eee-review'), 'agent', rest[0] ?? '', String(Date.now()));
  for (const part of parts) {
    if (part.type === 'text') console.log(part.text);
    else {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, part.name);
      fs.writeFileSync(file, Buffer.from(part.data, 'base64'));
      console.log(`[Bild: ${file}]`);
    }
  }
}
