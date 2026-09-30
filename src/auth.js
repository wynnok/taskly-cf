const enc = new TextEncoder();
const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (value) => Uint8Array.from(value.match(/../g) || [], (b) => parseInt(b, 16));
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
export function equal(a, b) {
  const x = enc.encode(a),
    y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
export async function hashPassword(password, salt = randomToken().slice(0, 32)) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: 100000 },
    key,
    256,
  );
  return `pbkdf2-sha256$100000$${salt}$${hex(derived)}`;
}
export async function verifyPassword(stored, provided) {
  if (!/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored)) return false;
  return equal(stored, await hashPassword(provided, stored.split('$')[2]));
}
export function cookie(request, value, maxAge = 1800) {
  return `taskly_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function session(request, db) {
  const token = request.headers
    .get('Cookie')
    ?.match(/(?:^|;\s*)taskly_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  if (!token) return null;
  const hash = await digest(token);
  const row = await db
    .prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?')
    .bind(hash, Date.now())
    .first();
  if (row)
    await db
      .prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
      .bind(Date.now() + 1800000, hash)
      .run();
  return row;
}
