import { createHash, verify } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

const certificate = readFileSync(new URL('./release-cert.pem', import.meta.url));
export function verifyRelease(file, info, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || info?.version !== version || !info.bhuleshwarSignature)
    throw new Error('Missing signed Bhuleshwar release metadata.');
  const fd = openSync(file, 'r');
  const hash = createHash('sha512');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (let n; (n = readSync(fd, chunk)) > 0;) hash.update(chunk.subarray(0, n));
  } finally { closeSync(fd); }
  const payload = ['com.bhuleshwar.local-agent', 'win32-x64', version, hash.digest('base64')].join('\n');
  if (!verify('RSA-SHA256', Buffer.from(payload), certificate, Buffer.from(info.bhuleshwarSignature, 'base64')))
    throw new Error('Bhuleshwar release signature verification failed.');
}
