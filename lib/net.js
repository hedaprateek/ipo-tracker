'use strict';

const dns = require('dns');
const { spawn } = require('child_process');

/**
 * Corporate/AV TLS inspection (Kaspersky, Zscaler, Netskope…) re-signs every
 * HTTPS response with a root that lives in the OS store, which Node does not
 * consult by default — upstream fetches then die with "self-signed certificate
 * in certificate chain". Re-exec once with --use-system-ca so callers never
 * have to know about the flag.
 *
 * Returns true if it re-launched, in which case the caller must return
 * immediately. No-ops on Node builds without the flag (CI runners, older Node),
 * where the system store is not being tampered with anyway.
 */
function relaunchWithSystemCa(entryFile) {
  if (process.env.IPO_TRACKER_CHILD) return false;
  if (process.execArgv.includes('--use-system-ca')) return false;
  if (!process.allowedNodeEnvironmentFlags.has('--use-system-ca')) return false;

  const child = spawn(
    process.execPath,
    ['--use-system-ca', entryFile, ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, IPO_TRACKER_CHILD: '1' } }
  );
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('could not re-launch with --use-system-ca:', err.message);
    process.exit(1);
  });
  return true;
}

/** Some networks black-hole IPv6 to these hosts; prefer A records. */
function preferIpv4() {
  dns.setDefaultResultOrder('ipv4first');
}

module.exports = { relaunchWithSystemCa, preferIpv4 };
