export const SUPPORTED_IMAGE_BASES = [
  'alpine',
  'ubuntu',
  'debian',
  'busybox',
  'nginx',
  'httpd',
  'traefik',
  'node',
  'python',
  'golang',
  'openjdk',
  'eclipse-temurin',
  'postgres',
  'mysql',
  'mariadb',
  'mongo',
  'redis',
  'rabbitmq',
  'elasticsearch',
  'kafka',
  'keycloak',
] as const;

export type SupportedImageBase = (typeof SUPPORTED_IMAGE_BASES)[number];

export const SUPPORTED_IMAGE_BASE_SET = new Set<string>(SUPPORTED_IMAGE_BASES);

const IMAGE_BASE_SYNONYMS = new Map<string, SupportedImageBase>([
  ['nodejs', 'node'],
  ['node.js', 'node'],
  ['go', 'golang'],
  ['java', 'openjdk'],
  ['jdk', 'openjdk'],
  ['temurin', 'eclipse-temurin'],
  ['apache', 'httpd'],
  ['apache2', 'httpd'],
  ['apache-httpd', 'httpd'],
  ['maria', 'mariadb'],
  ['mongodb', 'mongo'],
  ['elastic', 'elasticsearch'],
  ['elastic-search', 'elasticsearch'],
  ['rabbit', 'rabbitmq'],
  ['rmq', 'rabbitmq'],
  ['postgresql', 'postgres'],
  ['postgresql-db', 'postgres'],
  ['postgres-db', 'postgres'],
]);

const COMMON_IMAGE_BASE_TYPOS = new Map<string, SupportedImageBase>([
  ['postresql', 'postgres'],
]);

export interface ImageBaseCanonicalization {
  value: string;
  changed: boolean;
  reason: 'exact' | 'synonym' | 'typo' | 'none';
}

export interface ImageReferenceResolution {
  raw: string;
  resolved: string | null;
  candidates: SupportedImageBase[];
  confidence: 'high' | 'low' | 'none';
  reason: 'exact' | 'synonym' | 'typo' | 'ambiguous' | 'unsupported';
  needsClarification: boolean;
}

export function canonicalizeImageBase(base: string): ImageBaseCanonicalization {
  const normalizedBase = normalizeCandidate(base);

  if (SUPPORTED_IMAGE_BASE_SET.has(normalizedBase)) {
    return {
      value: normalizedBase,
      changed: normalizedBase !== base,
      reason: 'exact',
    };
  }

  const synonym = IMAGE_BASE_SYNONYMS.get(normalizedBase);
  if (synonym !== undefined) {
    return {
      value: synonym,
      changed: synonym !== normalizedBase,
      reason: 'synonym',
    };
  }

  const commonTypo = COMMON_IMAGE_BASE_TYPOS.get(normalizedBase);
  if (commonTypo !== undefined) {
    return {
      value: commonTypo,
      changed: commonTypo !== normalizedBase,
      reason: 'typo',
    };
  }

  const typoMatch = findNearestSupportedImageBase(normalizedBase);
  if (typoMatch !== null) {
    return {
      value: typoMatch,
      changed: typoMatch !== normalizedBase,
      reason: 'typo',
    };
  }

  return {
    value: normalizedBase,
    changed: normalizedBase !== base,
    reason: 'none',
  };
}

export function resolveImageReference(reference: string): ImageReferenceResolution {
  const parsed = splitImageReference(reference);
  const canonical = canonicalizeImageBase(parsed.base);

  if (SUPPORTED_IMAGE_BASE_SET.has(canonical.value) && canonical.reason !== 'none') {
    return {
      raw: reference,
      resolved: `${parsed.prefix}${canonical.value}${parsed.suffix}`,
      candidates: [canonical.value as SupportedImageBase],
      confidence: 'high',
      reason: canonical.reason,
      needsClarification: false,
    };
  }

  const candidates = findCandidateSupportedImageBases(parsed.base);

  return {
    raw: reference,
    resolved: null,
    candidates,
    confidence: candidates.length ? 'low' : 'none',
    reason: candidates.length ? 'ambiguous' : 'unsupported',
    needsClarification: true,
  };
}

export function isSupportedImageReference(reference: string): boolean {
  const parsed = splitImageReference(reference);
  return SUPPORTED_IMAGE_BASE_SET.has(parsed.base);
}

export function getImageReferenceBase(reference: string): string {
  return splitImageReference(reference).base;
}

export function extractCanonicalImageBases(text: string): SupportedImageBase[] {
  const images: SupportedImageBase[] = [];
  const seen = new Set<string>();

  for (const token of extractCandidateTokens(text)) {
    const canonical = canonicalizeImageBase(token);
    if (
      canonical.reason !== 'none' &&
      SUPPORTED_IMAGE_BASE_SET.has(canonical.value) &&
      !seen.has(canonical.value)
    ) {
      images.push(canonical.value as SupportedImageBase);
      seen.add(canonical.value);
    }
  }

  return images;
}

export function textMentionsSupportedImage(text: string): boolean {
  return extractCanonicalImageBases(text).length > 0;
}

function findNearestSupportedImageBase(input: string): SupportedImageBase | null {
  if (input.length < 4) {
    return null;
  }

  const ranked = SUPPORTED_IMAGE_BASES
    .map((candidate) => ({
      candidate,
      distance: damerauLevenshteinDistance(input, candidate),
    }))
    .sort((left, right) => left.distance - right.distance);

  const best = ranked[0];
  const second = ranked[1];

  if (best === undefined || best.distance > getTypoDistanceLimit(input, best.candidate)) {
    return null;
  }

  if (second !== undefined && second.distance === best.distance) {
    return null;
  }

  return best.candidate;
}

function findCandidateSupportedImageBases(input: string): SupportedImageBase[] {
  const normalizedInput = normalizeCandidate(input);
  const maxDistance = Math.max(2, Math.ceil(normalizedInput.length / 3));

  return SUPPORTED_IMAGE_BASES
    .map((candidate) => ({
      candidate,
      distance: damerauLevenshteinDistance(normalizedInput, candidate),
    }))
    .filter((entry) => entry.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

function getTypoDistanceLimit(input: string, target: string): number {
  const maxLength = Math.max(input.length, target.length);

  if (maxLength <= 3) {
    return 0;
  }

  if (maxLength <= 5) {
    return 1;
  }

  return 2;
}

function extractCandidateTokens(text: string): string[] {
  return [...text.matchAll(/[A-Za-z][A-Za-z0-9_.-]*/g)].map((match) => match[0]);
}

function normalizeCandidate(value: string): string {
  return value.trim().toLowerCase();
}

function splitImageReference(image: string): {
  prefix: string;
  base: string;
  suffix: string;
} {
  const slashIndex = image.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? image.slice(0, slashIndex + 1) : '';
  const baseAndSuffix = slashIndex >= 0 ? image.slice(slashIndex + 1) : image;
  const tagIndex = baseAndSuffix.indexOf(':');

  if (tagIndex < 0) {
    return {
      prefix,
      base: normalizeCandidate(baseAndSuffix),
      suffix: '',
    };
  }

  return {
    prefix,
    base: normalizeCandidate(baseAndSuffix.slice(0, tagIndex)),
    suffix: baseAndSuffix.slice(tagIndex),
  };
}

function damerauLevenshteinDistance(left: string, right: string): number {
  const distances = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );

  for (let leftIndex = 0; leftIndex <= left.length; leftIndex += 1) {
    distances[leftIndex]![0] = leftIndex;
  }

  for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
    distances[0]![rightIndex] = rightIndex;
  }

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;

      distances[leftIndex]![rightIndex] = Math.min(
        distances[leftIndex - 1]![rightIndex]! + 1,
        distances[leftIndex]![rightIndex - 1]! + 1,
        distances[leftIndex - 1]![rightIndex - 1]! + substitutionCost,
      );

      if (
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      ) {
        distances[leftIndex]![rightIndex] = Math.min(
          distances[leftIndex]![rightIndex]!,
          distances[leftIndex - 2]![rightIndex - 2]! + 1,
        );
      }
    }
  }

  return distances[left.length]![right.length]!;
}
