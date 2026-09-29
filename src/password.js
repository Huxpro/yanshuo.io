// Password hashing.
//
// New passwords use PBKDF2-SHA256 (the Workers runtime caps iterations at
// 100k). Users imported from LeanCloud keep their original hash until they
// next log in, at which point it is transparently upgraded.

const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return {
    algo: 'pbkdf2',
    salt: `${PBKDF2_ITERATIONS}$${toBase64(salt)}`,
    hash: toBase64(hash),
  };
}

// Returns true if `password` matches the stored hash.
export async function verifyPassword(password, { password_algo, password_hash, password_salt }) {
  if (!password_hash || typeof password !== 'string') return false;
  let actual;
  if (password_algo === 'leancloud') {
    actual = await leancloudHash(password, password_salt ?? '');
  } else if (password_algo === 'pbkdf2') {
    const [iterations, salt] = password_salt.split('$');
    actual = await pbkdf2(password, fromBase64(salt), Number(iterations));
  } else {
    return false;
  }
  return timingSafeEqual(actual, fromBase64(password_hash));
}

// LeanCloud's documented export algorithm:
//   hv = sha512(salt + password); repeat 512 times: hv = sha512(hv); base64(hv)
// https://docs.leancloud.cn/sdk/start/dashboard/ (导出的用户数据中密码的加密算法)
export async function leancloudHash(password, salt) {
  let hv = await crypto.subtle.digest('SHA-512', encoder.encode(salt + password));
  for (let i = 0; i < 512; i++) {
    hv = await crypto.subtle.digest('SHA-512', hv);
  }
  return new Uint8Array(hv);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export function toBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(str) {
  return Uint8Array.from(atob(str.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
}
