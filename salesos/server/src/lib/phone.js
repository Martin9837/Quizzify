// Lightweight phone helpers. A production deployment would delegate to
// libphonenumber; this keeps the dependency surface at zero while still
// giving correct E.164 normalisation for the common cases.

const COUNTRY_DIAL_CODES = {
  US: '1', CA: '1', GB: '44', IE: '353', DE: '49', FR: '33', ES: '34', IT: '39',
  NL: '31', SE: '46', NO: '47', DK: '45', FI: '358', PL: '48', PT: '351',
  IN: '91', SG: '65', AU: '61', NZ: '64', JP: '81', KR: '82', CN: '86',
  BR: '55', MX: '52', AR: '54', ZA: '27', AE: '971', SA: '966', IL: '972',
};

const DIAL_TO_COUNTRY = Object.entries(COUNTRY_DIAL_CODES).reduce((acc, [country, dial]) => {
  if (!acc[dial]) acc[dial] = country;
  return acc;
}, {});

export function toE164(input, defaultCountry = 'US') {
  if (!input) return null;
  const raw = String(input).trim();
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return `+${digits.slice(1).replace(/\D/g, '')}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  const dial = COUNTRY_DIAL_CODES[defaultCountry] || '1';
  const national = digits.replace(/\D/g, '').replace(/^0+/, '');
  if (!national) return null;
  return `+${dial}${national}`;
}

export function callingCode(e164) {
  if (!e164 || !e164.startsWith('+')) return null;
  const digits = e164.slice(1);
  for (const len of [3, 2, 1]) {
    const candidate = digits.slice(0, len);
    if (DIAL_TO_COUNTRY[candidate]) return candidate;
  }
  return digits.slice(0, 1);
}

export function countryFromE164(e164) {
  const code = callingCode(e164);
  return code ? DIAL_TO_COUNTRY[code] || null : null;
}

export function formatDisplay(e164) {
  if (!e164) return '';
  const code = callingCode(e164);
  if (!code) return e164;
  const rest = e164.slice(1 + code.length);
  if (code === '1' && rest.length === 10) return `+1 (${rest.slice(0, 3)}) ${rest.slice(3, 6)}-${rest.slice(6)}`;
  return `+${code} ${rest.replace(/(\d{3})(?=\d)/g, '$1 ').trim()}`;
}

/** Masks all but the last 2 digits, for logs and non-privileged views. */
export function maskNumber(e164) {
  if (!e164) return '';
  const code = callingCode(e164) || '';
  const rest = e164.slice(1 + code.length);
  if (rest.length <= 2) return `+${code}${rest}`;
  return `+${code} ${'*'.repeat(Math.max(0, rest.length - 2))}${rest.slice(-2)}`;
}

/**
 * Pick the outbound caller id the counterparty should see. When masking is
 * enabled we present an org-owned number rather than the agent's own line.
 */
export function proxyNumber(orgCallerId, agentNumber, maskingEnabled) {
  return maskingEnabled ? orgCallerId : agentNumber || orgCallerId;
}

export const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_DIAL_CODES);
export { COUNTRY_DIAL_CODES };
