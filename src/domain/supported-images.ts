import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

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

export interface TrustedImageCatalog {
  trustedImages: TrustedImageProfile[];
}

export interface TrustedImageCatalogLoadOptions {
  configPath?: string;
}

export class TrustedImageCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedImageCatalogError';
  }
}

const trustedImageRoleSchema = z.enum(['reverse-proxy', 'backend', 'database']);
const trustedImageProfileSchema = z.object({
  base: z.enum(SUPPORTED_IMAGE_BASES),
  image: z.string().trim().min(1),
  role: trustedImageRoleSchema,
  defaultPorts: z.array(z.string().trim().min(1)),
  defaultEnvironment: z.record(z.string(), z.string()),
  defaultVolumes: z.array(z.string().trim().min(1)),
  sameRoleReplacements: z.array(z.string().trim().min(1)),
  crossFamilyReplacements: z.array(z.string().trim().min(1)),
}).strict();

export const trustedImageCatalogSchema = z.object({
  trustedImages: z.array(trustedImageProfileSchema).min(1),
}).strict();

const DEFAULT_TRUSTED_IMAGE_CATALOG_PATH = path.resolve(process.cwd(), 'config', 'trusted-images.yaml');
const TRUSTED_IMAGE_CATALOG_PATH = process.env.TRUSTED_IMAGES_CONFIG?.trim()
  ? path.resolve(process.cwd(), process.env.TRUSTED_IMAGES_CONFIG.trim())
  : DEFAULT_TRUSTED_IMAGE_CATALOG_PATH;

export const SUPPORTED_IMAGE_BASE_SET = new Set<string>(SUPPORTED_IMAGE_BASES);

let trustedImageCatalogCache: TrustedImageCatalog | null = null;
let trustedImageProfileMapCache: ReadonlyMap<SupportedImageBase, TrustedImageProfile> | null = null;

export function loadTrustedImageCatalog(options: TrustedImageCatalogLoadOptions = {}): TrustedImageCatalog {
  const configPath = resolveTrustedImageCatalogPath(options.configPath);

  if (!existsSync(configPath)) {
    throw new TrustedImageCatalogError(`Trusted image catalog file not found: ${configPath}`);
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(raw);
  const catalog = trustedImageCatalogSchema.parse(parsed);
  validateTrustedImageCatalog(catalog, configPath);
  return catalog;
}

export function getTrustedImageCatalogPath(): string {
  return TRUSTED_IMAGE_CATALOG_PATH;
}

export function resetTrustedImageCatalogCache(): void {
  trustedImageCatalogCache = null;
  trustedImageProfileMapCache = null;
}

export function getTrustedImageCatalog(): TrustedImageCatalog {
  if (trustedImageCatalogCache === null) {
    trustedImageCatalogCache = loadTrustedImageCatalog();
  }

  return trustedImageCatalogCache;
}

export const TRUSTED_IMAGE_PROFILES: TrustedImageProfile[] = getTrustedImageCatalog().trustedImages;
export const TRUSTED_IMAGE_BASE_SET = new Set<string>(TRUSTED_IMAGE_PROFILES.map((profile) => profile.base));

const IMAGE_BASE_SYNONYMS = new Map<string, SupportedImageBase>([
  ['nodejs', 'node'],
  ['postgresql', 'postgres'],
  ['mssql', 'mysql'],
  ['maria', 'mariadb'],
  ['mongo-db', 'mongo'],
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

  const nearest = findNearestSupportedImageBase(normalizedBase);
  if (nearest !== null) {
    return {
      value: nearest,
      changed: nearest !== normalizedBase,
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
      confidence: canonical.reason === 'exact' || canonical.reason === 'synonym' ? 'high' : 'low',
      reason: canonical.reason,
      needsClarification: false,
    };
  }

  const candidates = findCandidateSupportedImageBases(parsed.base);
  if (candidates.length > 0) {
    return {
      raw: reference,
      resolved: null,
      candidates,
      confidence: 'low',
      reason: candidates.length === 1 ? 'typo' : 'ambiguous',
      needsClarification: true,
    };
  }

  return {
    raw: reference,
    resolved: null,
    candidates: [],
    confidence: 'none',
    reason: 'unsupported',
    needsClarification: false,
  };
}

export function isSupportedImageReference(reference: string): boolean {
  const parsed = splitImageReference(reference);
  return SUPPORTED_IMAGE_BASE_SET.has(parsed.base);
}

export function isTrustedImageReference(reference: string): boolean {
  const parsed = splitImageReference(reference);
  return getTrustedImageProfileByBase(parsed.base) !== null;
}

export function getTrustedImageProfile(reference: string): TrustedImageProfile | null {
  const parsed = splitImageReference(reference);
  return getTrustedImageProfileByBase(parsed.base);
}

export function getTrustedReplacementImages(reference: string, role?: TrustedImageRole, includeCrossFamily = false): string[] {
  const profile = getTrustedImageProfile(reference);
  if (profile === null) return [];
  if (role !== undefined && profile.role !== role) return [];
  return [...profile.sameRoleReplacements, ...(includeCrossFamily ? profile.crossFamilyReplacements : [])];
}

export function getTrustedDefaultImageForBase(base: string): string | null {
  const canonical = canonicalizeImageBase(base);
  return getTrustedImageProfileByBase(canonical.value)?.image ?? null;
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

function getTrustedImageProfileByBase(base: string): TrustedImageProfile | null {
  if (trustedImageProfileMapCache === null) {
    trustedImageProfileMapCache = new Map(
      getTrustedImageCatalog().trustedImages.map((profile) => [profile.base, profile]),
    );
  }

  return trustedImageProfileMapCache.get(base as SupportedImageBase) ?? null;
}

function resolveTrustedImageCatalogPath(configPath?: string): string {
  if (configPath?.trim()) {
    return path.resolve(process.cwd(), configPath.trim());
  }

  return TRUSTED_IMAGE_CATALOG_PATH;
}

function validateTrustedImageCatalog(catalog: TrustedImageCatalog, configPath: string): void {
  const seenBases = new Set<string>();

  for (const profile of catalog.trustedImages) {
    if (seenBases.has(profile.base)) {
      throw new TrustedImageCatalogError(`Trusted image catalog contains duplicate base "${profile.base}" in ${configPath}`);
    }
    seenBases.add(profile.base);
  }
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