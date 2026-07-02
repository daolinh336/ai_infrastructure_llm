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

export type TrustedImageRole = 'reverse-proxy' | 'backend' | 'database';

export interface TrustedImageProfile {
  base: SupportedImageBase;
  image: string;
  role: TrustedImageRole;
  defaultPorts: string[];
  defaultEnvironment: Record<string, string>;
  defaultVolumes: string[];
  sameRoleReplacements: string[];
  crossFamilyReplacements: string[];
}

export const SUPPORTED_IMAGE_BASE_SET = new Set<string>(SUPPORTED_IMAGE_BASES);

export const TRUSTED_IMAGE_PROFILES: TrustedImageProfile[] = [
  { base: 'nginx', image: 'nginx:stable', role: 'reverse-proxy', defaultPorts: ['80:80'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['httpd:2.4', 'traefik:v3.0'], crossFamilyReplacements: [] },
  { base: 'httpd', image: 'httpd:2.4', role: 'reverse-proxy', defaultPorts: ['80:80'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['nginx:stable', 'traefik:v3.0'], crossFamilyReplacements: [] },
  { base: 'traefik', image: 'traefik:v3.0', role: 'reverse-proxy', defaultPorts: ['80:80'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['nginx:stable', 'httpd:2.4'], crossFamilyReplacements: [] },
  { base: 'node', image: 'node:20-alpine', role: 'backend', defaultPorts: ['3000:3000'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['python:3.12-alpine'], crossFamilyReplacements: ['golang:1.22-alpine', 'eclipse-temurin:21-jre'] },
  { base: 'python', image: 'python:3.12-alpine', role: 'backend', defaultPorts: ['8000:8000'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['node:20-alpine'], crossFamilyReplacements: ['golang:1.22-alpine', 'eclipse-temurin:21-jre'] },
  { base: 'golang', image: 'golang:1.22-alpine', role: 'backend', defaultPorts: ['8080:8080'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['node:20-alpine', 'python:3.12-alpine'], crossFamilyReplacements: ['eclipse-temurin:21-jre'] },
  { base: 'openjdk', image: 'openjdk:21-jdk-slim', role: 'backend', defaultPorts: ['8080:8080'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['eclipse-temurin:21-jre'], crossFamilyReplacements: ['node:20-alpine', 'python:3.12-alpine'] },
  { base: 'eclipse-temurin', image: 'eclipse-temurin:21-jre', role: 'backend', defaultPorts: ['8080:8080'], defaultEnvironment: {}, defaultVolumes: [], sameRoleReplacements: ['openjdk:21-jdk-slim'], crossFamilyReplacements: ['node:20-alpine', 'python:3.12-alpine'] },
  { base: 'postgres', image: 'postgres:16-alpine', role: 'database', defaultPorts: ['5432:5432'], defaultEnvironment: { POSTGRES_PASSWORD: 'change-me' }, defaultVolumes: ['data:/var/lib/postgresql/data'], sameRoleReplacements: [], crossFamilyReplacements: ['mysql:8.4', 'mariadb:11.4', 'mongo:7'] },
  { base: 'mysql', image: 'mysql:8.4', role: 'database', defaultPorts: ['3306:3306'], defaultEnvironment: { MYSQL_ROOT_PASSWORD: 'change-me' }, defaultVolumes: ['data:/var/lib/mysql'], sameRoleReplacements: ['mariadb:11.4'], crossFamilyReplacements: ['postgres:16-alpine', 'mongo:7'] },
  { base: 'mariadb', image: 'mariadb:11.4', role: 'database', defaultPorts: ['3306:3306'], defaultEnvironment: { MARIADB_ROOT_PASSWORD: 'change-me' }, defaultVolumes: ['data:/var/lib/mysql'], sameRoleReplacements: ['mysql:8.4'], crossFamilyReplacements: ['postgres:16-alpine', 'mongo:7'] },
  { base: 'mongo', image: 'mongo:7', role: 'database', defaultPorts: ['27017:27017'], defaultEnvironment: {}, defaultVolumes: ['data:/data/db'], sameRoleReplacements: [], crossFamilyReplacements: ['postgres:16-alpine', 'mysql:8.4', 'mariadb:11.4'] },
  { base: 'redis', image: 'redis:7-alpine', role: 'database', defaultPorts: ['6379:6379'], defaultEnvironment: {}, defaultVolumes: ['data:/data'], sameRoleReplacements: [], crossFamilyReplacements: [] },
  { base: 'rabbitmq', image: 'rabbitmq:3-management', role: 'database', defaultPorts: ['5672:5672'], defaultEnvironment: {}, defaultVolumes: ['data:/var/lib/rabbitmq'], sameRoleReplacements: [], crossFamilyReplacements: [] },
  { base: 'elasticsearch', image: 'elasticsearch:8.14.0', role: 'database', defaultPorts: ['9200:9200'], defaultEnvironment: {}, defaultVolumes: ['data:/usr/share/elasticsearch/data'], sameRoleReplacements: [], crossFamilyReplacements: [] },
  { base: 'kafka', image: 'kafka:latest', role: 'database', defaultPorts: ['9092:9092'], defaultEnvironment: {}, defaultVolumes: ['data:/var/lib/kafka/data'], sameRoleReplacements: [], crossFamilyReplacements: [] },
];

export const TRUSTED_IMAGE_BASE_SET = new Set<string>(TRUSTED_IMAGE_PROFILES.map((profile) => profile.base));

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

export function isTrustedImageReference(reference: string): boolean {
  const parsed = splitImageReference(reference);
  return TRUSTED_IMAGE_BASE_SET.has(parsed.base);
}

export function getTrustedImageProfile(reference: string): TrustedImageProfile | null {
  const parsed = splitImageReference(reference);
  return TRUSTED_IMAGE_PROFILES.find((profile) => profile.base === parsed.base) ?? null;
}

export function getTrustedReplacementImages(reference: string, role?: TrustedImageRole, includeCrossFamily = false): string[] {
  const profile = getTrustedImageProfile(reference);
  if (profile === null) return [];
  if (role !== undefined && profile.role !== role) return [];
  return [...profile.sameRoleReplacements, ...(includeCrossFamily ? profile.crossFamilyReplacements : [])];
}

export function getTrustedDefaultImageForBase(base: string): string | null {
  const canonical = canonicalizeImageBase(base);
  const profile = TRUSTED_IMAGE_PROFILES.find((candidate) => candidate.base === canonical.value);
  return profile?.image ?? null;
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
