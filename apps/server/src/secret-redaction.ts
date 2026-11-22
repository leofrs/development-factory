const REDACTED = '[REDACTED]';

const NON_SECRET_LITERALS = new Set([
  'null',
  'undefined',
  'true',
  'false',
  'string',
  'number',
  'boolean',
  'unknown',
  'never',
  'object',
  'symbol',
  'bigint',
  'void',
  'any',
  'none',
  'empty',
  'optional',
  'required',
]);

const SENSITIVE_KEY_NAME =
  '(?:[A-Za-z0-9_.-]*(?:api[-_]?key|apikey|secret[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bearer[-_]?token|client[-_]?secret|private[-_]?key|aws_secret_access_key|aws_session_token|aws_access_key_id|jira[-_]?(?:api[-_]?)?token|atlassian[-_]?(?:api[-_]?)?token|github[-_]?token|gh[-_]?token|npm[-_]?token|password|passwd|pwd|secret)|(?:[A-Za-z0-9_.-]*[-_])?token|x-api-key|x-auth-token)';

const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PEM_PRIVATE_KEY_HEADER_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const URL_CREDENTIALS_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/\s@?#"'`<>]+@)/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const KNOWN_PROVIDER_TOKEN_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA|AROA|AIDA|ANPA|ANVA|APKA)[A-Z0-9]{16}|ATATT[A-Za-z0-9_-]{16,}|sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{16,}|sk-(?:proj-|live-|test-|svcacct-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35,}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,})\b/g;
const AUTH_HEADER_PATTERN =
  /\b((?:Proxy-)?Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)(\[REDACTED\]|[^\s'"`,;)}\]]+)/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)(\[REDACTED\]|[A-Za-z0-9._~+/-]{8,}=*)/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|secret|password|passwd|token)=)([^&#\s"'`]+)/gi;
const KEY_VALUE_SECRET_PATTERN = new RegExp(
  `(^|[\\s,{(\\[;'"])((?:--)?${SENSITIVE_KEY_NAME})(['"]?)(\\s*[:=]\\s*)(?:(['"])([^'"\\r\\n]{4,})\\5|(\\[REDACTED\\]|[^\\s'",;)\\]}]{4,}))`,
  'gi',
);
const CLI_FLAG_SECRET_PATTERN =
  /(^|\s)(--?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|jira[-_]?(?:api[-_]?)?token|github[-_]?token|token|secret|password|passwd))(\s+)(?:(['"])([^'"\r\n]{4,})\4|([^\s'"`;|&]{4,}))/gi;

function isPlaceholderOrAlreadyRedacted(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === REDACTED || trimmed.includes(REDACTED)) {
    return true;
  }
  if (trimmed.startsWith('$') || (trimmed.startsWith('<') && trimmed.endsWith('>'))) {
    return true;
  }
  return NON_SECRET_LITERALS.has(trimmed.toLowerCase());
}

function looksLikeToken(value: string): boolean {
  if (isPlaceholderOrAlreadyRedacted(value)) {
    return false;
  }
  if (value.length >= 20) {
    return true;
  }
  return /[\d._+/-=]/.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value));
}

function shouldRedactAssignedSecret(
  keyName: string,
  separator: string,
  quoted: boolean,
  value: string,
): boolean {
  if (isPlaceholderOrAlreadyRedacted(value)) {
    return false;
  }
  if (quoted || separator.includes('=')) {
    return true;
  }
  const normalizedKey = keyName.toLowerCase();
  if (normalizedKey === 'x-api-key' || normalizedKey === 'x-auth-token') {
    return true;
  }
  // Evita falsos positivos em anotações de tipo ou prosa após `:` (ex.: `password: invalid`).
  return value.length >= 16 || /[\d._+/-=]/.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value));
}

export interface SecretDetection {
  readonly rule: string;
}

function addMatches(
  detections: SecretDetection[],
  seenRules: Set<string>,
  input: string,
  pattern: RegExp,
  rule: string,
  accept: (match: RegExpExecArray) => boolean = () => true,
): void {
  const matcher = new RegExp(pattern.source, pattern.flags);
  for (const match of input.matchAll(matcher)) {
    if (!accept(match)) {
      continue;
    }
    if (!seenRules.has(rule)) {
      seenRules.add(rule);
      detections.push({ rule });
    }
  }
}

/**
 * Detecta padrões sensíveis (chaves PEM, tokens de provedores, JWT, URLs com credenciais,
 * cabeçalhos Authorization/Bearer e atribuições ou flags de credenciais) em um texto.
 */
export function detectSecretsInText(input: string): SecretDetection[] {
  if (input.length === 0) {
    return [];
  }

  const detections: SecretDetection[] = [];
  const seenRules = new Set<string>();

  addMatches(detections, seenRules, input, PEM_PRIVATE_KEY_HEADER_PATTERN, 'Chave privada PEM');
  addMatches(detections, seenRules, input, URL_CREDENTIALS_PATTERN, 'Credenciais embutidas em URL');
  addMatches(detections, seenRules, input, JWT_PATTERN, 'Token JWT');
  addMatches(
    detections,
    seenRules,
    input,
    KNOWN_PROVIDER_TOKEN_PATTERN,
    'Token ou chave de provedor conhecido',
  );
  addMatches(
    detections,
    seenRules,
    input,
    AUTH_HEADER_PATTERN,
    'Cabeçalho Authorization',
    match => !isPlaceholderOrAlreadyRedacted(match[2] ?? ''),
  );
  addMatches(detections, seenRules, input, BEARER_TOKEN_PATTERN, 'Token Bearer', match =>
    looksLikeToken(match[2] ?? ''),
  );
  addMatches(
    detections,
    seenRules,
    input,
    QUERY_SECRET_PATTERN,
    'Credencial em parâmetro de URL',
    match => !isPlaceholderOrAlreadyRedacted(match[2] ?? ''),
  );
  addMatches(
    detections,
    seenRules,
    input,
    KEY_VALUE_SECRET_PATTERN,
    'Atribuição de credencial ou segredo',
    match => {
      const key = match[2] ?? '';
      const separator = match[4] ?? '';
      const quote = match[5] ?? '';
      const rawValue = match[6] ?? match[7] ?? '';
      return shouldRedactAssignedSecret(key, separator, quote.length > 0, rawValue);
    },
  );
  addMatches(
    detections,
    seenRules,
    input,
    CLI_FLAG_SECRET_PATTERN,
    'Credencial em flag de comando',
    match => {
      const flag = match[2] ?? '';
      const quote = match[4] ?? '';
      const rawValue = match[5] ?? match[6] ?? '';
      return !rawValue.startsWith('-') && shouldRedactAssignedSecret(flag, ' ', quote.length > 0, rawValue);
    },
  );

  return detections;
}

/**
 * Redige padrões sensíveis (tokens Bearer/JWT, chaves de API, segredos AWS/GitHub/Jira,
 * chaves privadas PEM e URLs com credenciais embutidas) substituindo-os por `[REDACTED]`.
 */
export function redactSecrets(input: string): string {
  if (input.length === 0) {
    return input;
  }

  let output = input;
  output = output.replace(PEM_PRIVATE_KEY_PATTERN, REDACTED);
  output = output.replace(
    URL_CREDENTIALS_PATTERN,
    (_match, scheme: string, _credentials: string) => `${scheme}${REDACTED}@`,
  );
  output = output.replace(JWT_PATTERN, REDACTED);
  output = output.replace(KNOWN_PROVIDER_TOKEN_PATTERN, REDACTED);
  output = output.replace(AUTH_HEADER_PATTERN, (match, prefix: string, value: string) =>
    isPlaceholderOrAlreadyRedacted(value) ? match : `${prefix}${REDACTED}`,
  );
  output = output.replace(BEARER_TOKEN_PATTERN, (match, prefix: string, value: string) =>
    looksLikeToken(value) ? `${prefix}${REDACTED}` : match,
  );
  output = output.replace(QUERY_SECRET_PATTERN, (match, prefix: string, value: string) =>
    isPlaceholderOrAlreadyRedacted(value) ? match : `${prefix}${REDACTED}`,
  );
  output = output.replace(
    KEY_VALUE_SECRET_PATTERN,
    (
      match,
      leading: string,
      key: string,
      keyQuote: string,
      separator: string,
      valueQuote: string | undefined,
      quotedValue: string | undefined,
      unquotedValue: string | undefined,
    ) => {
      const quote = valueQuote ?? '';
      const rawValue = quotedValue ?? unquotedValue ?? '';
      if (!shouldRedactAssignedSecret(key, separator, quote.length > 0, rawValue)) {
        return match;
      }
      return `${leading}${key}${keyQuote}${separator}${quote}${REDACTED}${quote}`;
    },
  );
  output = output.replace(
    CLI_FLAG_SECRET_PATTERN,
    (
      match,
      leading: string,
      flag: string,
      spacing: string,
      valueQuote: string | undefined,
      quotedValue: string | undefined,
      unquotedValue: string | undefined,
    ) => {
      const quote = valueQuote ?? '';
      const rawValue = quotedValue ?? unquotedValue ?? '';
      if (rawValue.startsWith('-') || !shouldRedactAssignedSecret(flag, ' ', quote.length > 0, rawValue)) {
        return match;
      }
      return `${leading}${flag}${spacing}${quote}${REDACTED}${quote}`;
    },
  );

  return output;
}

/**
 * Aplica `redactSecrets` recursivamente em todas as strings de uma estrutura JSON
 * sem corromper chaves, tipos primitivos ou a formatação ao serializar.
 */
export function redactSecretsInValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(item => redactSecretsInValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = redactSecretsInValue(entry);
    }
    return result;
  }
  return value;
}
